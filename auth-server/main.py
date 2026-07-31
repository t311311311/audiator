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

from db import init_db, get_user, upsert_user, usage_today, add_usage
import rate

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

# --- Rate limiting & usage quotas (AUD-13); all tunable via env ---
TRIAL_PER_IP_DAY = int(os.environ.get("TRIAL_PER_IP_DAY", "10"))
ASR_PER_MIN = int(os.environ.get("ASR_PER_MIN", "20"))
TRANSLATE_PER_MIN = int(os.environ.get("TRANSLATE_PER_MIN", "40"))
ASR_DAILY_SECONDS = int(os.environ.get("ASR_DAILY_SECONDS", "14400"))  # 4h/device/day
# Daily transcription allowance by tier (seconds). The free tier is the "gift"
# every user gets without a subscription; admins are unlimited.
FREE_DAILY_SECONDS = int(os.environ.get("FREE_DAILY_SECONDS", "3600"))    # 60 min
PAID_DAILY_SECONDS = int(os.environ.get("PAID_DAILY_SECONDS", str(ASR_DAILY_SECONDS)))


def _client_ip(request: Request) -> str:
    """Client IP for rate limiting. Behind the nginx reverse proxy (AUD-7 TLS)
    the socket peer is 127.0.0.1, so honour X-Forwarded-For, which nginx sets to
    the real client IP. The left-most entry is the originating client."""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _enforce_rate(key: str, limit: int, window_sec: int) -> None:
    """Raise 429 with Retry-After when the sliding window is exhausted."""
    allowed, retry_after = rate.check(key, limit, window_sec)
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail="Rate limit exceeded. Try again later.",
            headers={"Retry-After": str(retry_after)},
        )


def _asr_seconds(response) -> int:
    """Seconds of audio actually transcribed, read from the Whisper JSON
    response (last segment's end time). Returns 0 when it cannot be determined,
    so an unparsable response is never billed against the quota."""
    try:
        segments = response.json().get("segments") or []
        if segments:
            return int(round(float(segments[-1].get("end", 0))))
    except Exception:
        pass
    return 0


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
def start_trial(request: TrialRequest, http_request: Request):
    # Anti-abuse: this endpoint mints free access and trusts a client-supplied
    # device_id, so cap how many trials one IP can request per day. It does not
    # stop an attacker with a proxy pool, but it kills casual mass minting.
    _enforce_rate(f"trial:{_client_ip(http_request)}", TRIAL_PER_IP_DAY, 86400)
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


@app.get("/api/auth/quota")
def get_quota(authorization: Optional[str] = Header(None)):
    """How much of today's transcription allowance is left, for the UI to show."""
    device_id = require_active_subscription(authorization)
    user = get_user(device_id)
    limit = daily_limit_for(device_id)
    used = usage_today(device_id)
    return {
        "role": (user or {}).get("role") or "free",
        "unlimited": limit == 0,
        "limit_seconds": limit,
        "used_seconds": used,
        "remaining_seconds": None if limit == 0 else max(0, limit - used),
    }


# === Authenticated gateway to the ASR / translation services (AUD-8) ===
# The public ASR (Whisper) and translation (LibreTranslate) services were
# reachable by anyone. These endpoints require a valid subscription token and
# proxy the request to the internal services, so access can be gated per
# subscription. Internal service URLs default to localhost and are overridable.
WHISPER_URL = os.environ.get("WHISPER_URL", "http://127.0.0.1:8000")
TRANSLATE_URL = os.environ.get("TRANSLATE_URL", "http://127.0.0.1:5000")


def require_active_subscription(authorization: Optional[str]) -> str:
    """Validate the Bearer token and return the device id.

    Access tiers (the daily transcription allowance is enforced separately, in
    the /asr handler):
      admin       - unlimited, no subscription needed (for testing)
      subscriber  - active paid subscription or trial
      free        - no subscription: still allowed, but capped by the daily gift

    Raises 401 for a missing/invalid/expired token.
    """
    token = authorization.replace("Bearer ", "") if authorization else None
    payload = verify_token(token)  # raises 401 on bad/expired token
    return payload["device_id"]


def daily_limit_for(device_id: str) -> int:
    """Seconds of audio this device may transcribe today. 0 means unlimited."""
    user = get_user(device_id)
    role = (user or {}).get("role") or "free"
    if role == "admin":
        return 0  # unlimited
    sub_end = (user or {}).get("subscription_end")
    if sub_end and sub_end > datetime.now():
        return PAID_DAILY_SECONDS
    return FREE_DAILY_SECONDS


@app.post("/asr")
async def gateway_asr(
    audio_file: UploadFile = File(...),
    encode: Optional[str] = Query(None),
    task: Optional[str] = Query(None),
    output: Optional[str] = Query(None),
    language: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None),
):
    device_id = require_active_subscription(authorization)
    _enforce_rate(f"asr:{device_id}", ASR_PER_MIN, 60)
    # Cost ceiling: transcription is the expensive path (Whisper CPU time is
    # proportional to audio length). Checked before the work, recorded after.
    limit = daily_limit_for(device_id)
    if limit and usage_today(device_id) >= limit:
        raise HTTPException(
            status_code=402,
            detail=f"Дневной лимит {limit // 60} мин исчерпан. Попробуйте завтра.",
        )
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
    if r.status_code == 200:
        add_usage(device_id, _asr_seconds(r))
    return Response(content=r.content, status_code=r.status_code,
                    media_type=r.headers.get("content-type", "application/json"))


@app.post("/translate")
async def gateway_translate(request: Request, authorization: Optional[str] = Header(None)):
    device_id = require_active_subscription(authorization)
    _enforce_rate(f"translate:{device_id}", TRANSLATE_PER_MIN, 60)
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
    # Bind to localhost when behind the nginx reverse proxy (AUD-7): only nginx
    # should reach the app, which also prevents X-Forwarded-For spoofing. Default
    # stays 0.0.0.0 for direct/dev use; production sets BIND_HOST=127.0.0.1.
    uvicorn.run(app, host=os.environ.get("BIND_HOST", "0.0.0.0"), port=3000)
