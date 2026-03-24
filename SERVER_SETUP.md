# Настройка сервера Audiator

## Архитектура

| Сервис | Порт | Описание |
|--------|------|----------|
| Whisper ASR | 8000 | Транскрибация аудио в текст |
| LibreTranslate | 5000 | Перевод текста между языками |
| Auth Server | 3000 | JWT-авторизация, триал, подписка |

## Структура директорий

```
/opt/
├── audiator-services/
│   └── docker-compose.yml
└── auth-server/
    ├── main.py
    └── requirements.txt
```

## Быстрый старт

### 1. Установка Docker и docker-compose

```bash
sudo apt update
sudo apt install -y docker.io docker-compose
```

### 2. Настройка сервисов (Whisper + LibreTranslate)

```bash
mkdir -p /opt/audiator-services
cd /opt/audiator-services

# Создать docker-compose.yml
cat > docker-compose.yml << 'EOF'
version: '3.8'

services:
  whisper-asr:
    image: onerahmet/openai-whisper-asr-webservice:latest
    ports:
      - "8000:9000"
    volumes:
      - whisper-cache:/root/.cache/
    environment:
      - ASR_MODEL=base
      - ASR_ENGINE=openai_whisper
      - SERVER_NAME=0.0.0.0
      - SERVER_PORT=9000
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 4G

  libretranslate:
    image: libretranslate/libretranslate:latest
    ports:
      - "5000:5000"
    environment:
      - LT_HOST=0.0.0.0
      - LT_PORT=5000
      - LT_UPDATE_MODELS=true
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 2G

volumes:
  whisper-cache:
EOF

# Запустить
docker-compose up -d
```

### 3. Настройка Auth Server

```bash
mkdir -p /opt/auth-server
cd /opt/auth-server

# requirements.txt
cat > requirements.txt << 'EOF'
fastapi==0.104.1
uvicorn==0.24.0
pydantic==2.5.2
pydantic-settings==2.1.0
python-jose[cryptography]==3.3.0
passlib[bcrypt]==1.7.4
sqlalchemy==2.0.23
aiosqlite==0.19.0
python-multipart==0.0.6
EOF

# main.py
cat > main.py << 'EOF'
from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from datetime import datetime, timedelta
from typing import Optional
import hashlib
import time

app = FastAPI(title="Audiator Auth Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SECRET_KEY = "audiator-secret-key-2024"
TRIAL_DAYS = 14
SUBSCRIPTION_PRICES = {
    "1_month": {"months": 1, "price": 299},
    "12_months": {"months": 12, "price": 2490}
}

users_db = {}

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
    user = users_db.get(device_id)
    
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
    users_db[device_id] = {
        "device_name": request.device_name,
        "created_at": datetime.now(),
        "is_trial": True,
        "subscription_end": trial_end
    }
    
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
    
    user = users_db.get(device_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    months = SUBSCRIPTION_PRICES[plan]["months"]
    now = datetime.now()
    current_end = user.get("subscription_end")
    
    if current_end and current_end > now:
        new_end = current_end + timedelta(days=months * 30)
    else:
        new_end = now + timedelta(days=months * 30)
    
    users_db[device_id] = {
        **user,
        "is_trial": False,
        "subscription_end": new_end,
        "last_payment": request.payment_id
    }
    
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
    user = users_db.get(device_id)
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

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=3000)
EOF

# Установить зависимости и запустить
pip3 install -r requirements.txt
nohup python3 main.py > auth-server.log 2>&1 &

# Проверка
curl http://localhost:3000/health
```

## API Endpoints

### Auth Server (порт 3000)

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET | `/health` | Проверка статуса сервера |
| GET | `/api/auth/plans` | Получить планы подписки |
| POST | `/api/auth/trial` | Начать триал (14 дней) |
| POST | `/api/auth/subscription` | Активировать подписку |
| GET | `/api/auth/status` | Проверить статус подписки |

### Whisper ASR (порт 8000)

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET | `/docs` | Swagger документация |
| POST | `/asr` | Транскрибация аудио |

### LibreTranslate (порт 5000)

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET | `/languages` | Доступные языки |
| POST | `/translate` | Перевод текста |

## Тестирование

```bash
# 1. Получить токен триала
curl -X POST http://localhost:3000/api/auth/trial \
  -H "Content-Type: application/json" \
  -d '{"device_id": "test-device", "device_name": "Test PC"}'

# 2. Проверить статус
curl http://localhost:3000/api/auth/status \
  -H "Authorization: Bearer <TOKEN>"

# 3. Проверить Whisper
curl http://localhost:8000/docs

# 4. Проверить LibreTranslate
curl http://localhost:5000/languages
```

## Перезапуск сервисов

```bash
# Auth Server
pkill -f "python3 main.py"
cd /opt/auth-server && nohup python3 main.py > auth-server.log 2>&1 &

# Docker сервисы
cd /opt/audiator-services
docker-compose restart
```
