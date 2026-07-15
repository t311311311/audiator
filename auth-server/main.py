from fastapi import FastAPI, HTTPException, Header, UploadFile, File, Query, Request
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from datetime import datetime, timedelta
from typing import Optional
import hashlib
import os
import time

import httpx

# Load a local .env file if python-dotenv is installed (optional dependency).
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from db import init_db, get_user, upsert_user

app = FastAPI(title="Audiator Auth Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# The signing secret MUST come from the environment. The previous hardcoded
# value was committed to a public repository and is considered compromised.
# Generate a fresh one, e.g.:
#   python -c "import secrets; print(secrets.token_urlsafe(48))"
# and provide it via the AUDIATOR_SECRET_KEY env var (or a local .env file).
SECRET_KEY = os.environ.get("AUDIATOR_SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError(
        "AUDIATOR_SECRET_KEY is not set. Refusing to start with an insecure "
        "default secret. Set AUDIATOR_SECRET_KEY in the environment or a .env file."
    )
TRIAL_DAYS = 14
SUBSCRIPTION_PRICES = {
    "1_month": {"months": 1, "price": 299},
    "12_months": {"months": 12, "price": 2490}
}

# Persistence: create tables on startup (SQLite by default; see db.py).
init_db()

class TrialRequest(BaseModel):
    device_id: str
    device_name: Optional[str] = "Unknown"

class SubscriptionRequest(BaseModel):
    device_id: str
    plan: str
    payment_id: str

class TokenResponse(BaseModel):
    access_token: str
    token_type: str
    expires_at: datetime
    subscription_end: Optional[datetime]

def create_token(device_id: str, expires_days: int) -> str:
    exp_ts = int(time.time()) + (expires_days * 86400)
    signature = hashlib.sha256(f"{device_id}{SECRET_KEY}{exp_ts}".encode()).hexdigest()[:16]
    return f"{device_id}.{exp_ts}.{signature}"

def verify_token(token: str) -> dict:
    if not token:
        raise HTTPException(status_code=401, detail="Token required")
    
    parts = token.split(".")
    if len(parts) != 3:
        raise HTTPException(status_code=401, detail=f"Invalid token format")
    
    device_id, exp_ts, signature = parts
    expected_sig = hashlib.sha256(f"{device_id}{SECRET_KEY}{exp_ts}".encode()).hexdigest()[:16]
    
    if signature != expected_sig:
        raise HTTPException(status_code=401, detail="Invalid signature")
    
    exp = datetime.fromtimestamp(int(exp_ts))
    if exp < datetime.now():
        raise HTTPException(status_code=401, detail="Token expired")
    
    return {"device_id": device_id, "exp": exp}

@app.get("/health")
def health():
    return {"status": "ok", "timestamp": datetime.now()}

@app.post("/api/auth/trial", response_model=TokenResponse)
def start_trial(request: TrialRequest):
    device_id = request.device_id
    user = get_user(device_id)
    
    if user and user.get("is_trial"):
        raise HTTPException(status_code=400, detail="Trial already used")
    
    if user and user.get("subscription_end"):
        sub_end = user["subscription_end"]
        days_left = int((sub_end - datetime.now()).total_seconds() / 86400)
        return TokenResponse(
            access_token=create_token(device_id, max(days_left, 30)),
            token_type="bearer",
            expires_at=datetime.now() + timedelta(days=max(days_left, 30)),
            subscription_end=sub_end
        )
    
    trial_end = datetime.now() + timedelta(days=TRIAL_DAYS)
    upsert_user(
        device_id,
        device_name=request.device_name,
        created_at=datetime.now(),
        is_trial=True,
        subscription_end=trial_end,
    )
    
    return TokenResponse(
        access_token=create_token(device_id, TRIAL_DAYS),
        token_type="bearer",
        expires_at=trial_end,
        subscription_end=trial_end
    )

@app.post("/api/auth/subscription", response_model=TokenResponse)
def activate_subscription(request: SubscriptionRequest):
    device_id = request.device_id
    plan = request.plan
    
    if plan not in SUBSCRIPTION_PRICES:
        raise HTTPException(status_code=400, detail="Invalid plan")
    
    user = get_user(device_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    months = SUBSCRIPTION_PRICES[plan]["months"]
    now = datetime.now()
    current_end = user.get("subscription_end")
    
    if current_end and current_end > now:
        new_end = current_end + timedelta(days=months * 30)
    else:
        new_end = now + timedelta(days=months * 30)
    
    upsert_user(
        device_id,
        is_trial=False,
        subscription_end=new_end,
        last_payment=request.payment_id,
    )
    
    return TokenResponse(
        access_token=create_token(device_id, months * 30),
        token_type="bearer",
        expires_at=new_end,
        subscription_end=new_end
    )

@app.get("/api/auth/status")
def get_status(authorization: Optional[str] = Header(None)):
    token = authorization.replace("Bearer ", "") if authorization else None
    payload = verify_token(token)
    device_id = payload["device_id"]
    user = get_user(device_id)
    subscription_end = user.get("subscription_end") if user else None
    
    return TokenResponse(
        access_token=create_token(device_id, 30),
        token_type="bearer",
        expires_at=datetime.now() + timedelta(days=30),
        subscription_end=subscription_end
    )

@app.get("/api/auth/plans")
def get_plans():
    return {"plans": SUBSCRIPTION_PRICES, "trial_days": TRIAL_DAYS}


# === Authenticated gateway to the ASR / translation services (AUD-8) ===
# The public ASR (Whisper) and translation (LibreTranslate) services were
# reachable by anyone. These endpoints require a valid subscription token and
# proxy the request to the internal services, so access can be gated per
# subscription. Internal service URLs default to localhost and are overridable.
WHISPER_URL = os.environ.get("WHISPER_URL", "http://127.0.0.1:8000")
TRANSLATE_URL = os.environ.get("TRANSLATE_URL", "http://127.0.0.1:5000")


def require_active_subscription(authorization: Optional[str]) -> str:
    """Validate the Bearer token and require a non-expired subscription.

    Raises 401 for a missing/invalid/expired token and 403 when the token is
    valid but the subscription (or trial) is not currently active.
    """
    token = authorization.replace("Bearer ", "") if authorization else None
    payload = verify_token(token)  # raises 401 on bad/expired token
    device_id = payload["device_id"]
    user = get_user(device_id)
    sub_end = user.get("subscription_end") if user else None
    if not sub_end or sub_end < datetime.now():
        raise HTTPException(status_code=403, detail="No active subscription")
    return device_id


@app.post("/asr")
async def gateway_asr(
    audio_file: UploadFile = File(...),
    encode: Optional[str] = Query(None),
    task: Optional[str] = Query(None),
    output: Optional[str] = Query(None),
    language: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None),
):
    require_active_subscription(authorization)
    params = {k: v for k, v in {
        "encode": encode, "task": task, "output": output, "language": language,
    }.items() if v is not None}
    data = await audio_file.read()
    files = {"audio_file": (
        audio_file.filename or "audio.webm", data,
        audio_file.content_type or "application/octet-stream",
    )}
    async with httpx.AsyncClient(timeout=180) as client:
        r = await client.post(f"{WHISPER_URL}/asr", params=params, files=files)
    return Response(content=r.content, status_code=r.status_code,
                    media_type=r.headers.get("content-type", "application/json"))


@app.post("/translate")
async def gateway_translate(request: Request, authorization: Optional[str] = Header(None)):
    require_active_subscription(authorization)
    body = await request.body()
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(f"{TRANSLATE_URL}/translate", content=body,
                              headers={"Content-Type": "application/json"})
    return Response(content=r.content, status_code=r.status_code,
                    media_type=r.headers.get("content-type", "application/json"))


@app.get("/languages")
async def gateway_languages(authorization: Optional[str] = Header(None)):
    require_active_subscription(authorization)
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(f"{TRANSLATE_URL}/languages")
    return Response(content=r.content, status_code=r.status_code,
                    media_type=r.headers.get("content-type", "application/json"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=3000)
