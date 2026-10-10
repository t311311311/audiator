# -*- coding: utf-8 -*-
"""Accounts: sign-in by a code sent to the email, the free daily allowance,
and the plan (docs/PRODUCT-PLAN.md, step 4).

Speech recognition and translation run on the user's computer; this server
only keeps the accounts and counts minutes, so it stays small and cheap.

  POST /api/v2/auth/code    {email, lang}             mail a 6-digit code
  POST /api/v2/auth/verify  {email, code, device, tz} sign in (signs up the first time)
  GET  /api/v2/me?tz=       (Bearer)                  plan, minutes left today
  POST /api/v2/usage        {seconds, tz} (Bearer)    count minutes used

Rules agreed with the user:
- No password: a code from the mailbox proves the email (valid 10 minutes,
  5 tries). Signing up and signing in are the same step.
- Disposable mailboxes (temp-mail and the like) are not accepted.
- One free account per computer (by a hash of its Windows MachineGuid); paid,
  unlimited and admin accounts are not bound by it.
- Free: FREE_DAILY_SECONDS (2 hours) a day, counted per computer, starting
  again at midnight local time — the date comes from the server's clock and
  the client's time zone, so turning the PC clock does not help.
- unlimited = lifetime unlimited, granted by hand; ADMIN_EMAILS are admins
  and unlimited from their first sign-in.
"""
import hashlib
import hmac
import logging
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt
from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

import billing
import mailer
import rate
from accounts_db import Device, Session, Usage, User, init_accounts_db

router = APIRouter(prefix="/api/v2")
log = logging.getLogger("audiator")  # into the capped log files (log_setup.py)

SECRET = os.environ.get("AUDIATOR_SECRET_KEY", "")
ADMIN_EMAILS = {e.strip().lower() for e in
                os.environ.get("ADMIN_EMAILS", "t311311311@gmail.com").split(",") if e.strip()}
FREE_DAILY_SECONDS = int(os.environ.get("FREE_DAILY_SECONDS_V2", "7200"))
CODE_TTL = timedelta(minutes=10)
# The free allowance is per 24 hours of each account's own, counted from its
# first use once the previous 24 hours are over (user's decision 2026-10-04).
WINDOW = timedelta(hours=24)
# The rules the app shows at sign-in; signing in means accepting this version.
TERMS_VERSION = os.environ.get("TERMS_VERSION", "2026-10-04")
CODE_TRIES = 5
TOKEN_DAYS = 30
# Codes go out through one Gmail mailbox (about 500 letters a day), and the host
# blocks the server for good on a spam complaint: whatever bots try, an address
# gets at most CODE_PER_EMAIL_DAY codes a day and the server sends at most
# CODE_PER_DAY in all. In memory, like the other limits (rate.py).
CODE_PER_EMAIL_DAY = int(os.environ.get("CODE_PER_EMAIL_DAY", "10"))
CODE_PER_DAY = int(os.environ.get("CODE_PER_DAY", "300"))

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
DEVICE_RE = re.compile(r"^[0-9a-f]{32,128}$")
# Throw-away mailboxes, one click and no sign-up: a new free account every time.
DISPOSABLE = {
    "mailinator.com", "10minutemail.com", "10minutemail.net", "temp-mail.org", "temp-mail.io",
    "tempmail.com", "tempmail.net", "tempmailo.com", "guerrillamail.com", "guerrillamail.net",
    "guerrillamail.org", "sharklasers.com", "grr.la", "yopmail.com", "yopmail.net", "trashmail.com",
    "trashmail.de", "getnada.com", "nada.email", "dispostable.com", "maildrop.cc", "mailnesia.com",
    "fakeinbox.com", "throwawaymail.com", "mintemail.com", "mohmal.com", "emailondeck.com",
    "spamgourmet.com", "mailcatch.com", "moakt.com", "tempr.email", "discard.email", "burnermail.io",
    "1secmail.com", "1secmail.net", "1secmail.org", "dropmail.me", "emailfake.com", "crazymailing.com",
}

init_accounts_db()


# --- helpers --------------------------------------------------------------------

def _utcnow() -> datetime:
    """Now in UTC (naive, as stored). One place, so the tests can move the clock."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _err(status: int, error: str, **extra):
    return HTTPException(status, {"error": error, **extra})


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _code_hash(email: str, code: str) -> str:
    return hashlib.sha256(f"{SECRET}:{email}:{code}".encode()).hexdigest()


def _local_day(tz: Optional[int]) -> str:
    """The user's date. tz is JavaScript's getTimezoneOffset(): minutes to add
    to local time to get UTC (Moscow: -180)."""
    tz = max(-14 * 60, min(14 * 60, int(tz or 0)))
    return (_utcnow() - timedelta(minutes=tz)).date().isoformat()


def _plan(u: User) -> str:
    if u.role == "admin":
        return "admin"
    if u.unlimited:
        return "unlimited"
    if u.paid_until and u.paid_until > _utcnow():
        return "commercial"
    return "free"


def _mask(email: str) -> str:
    name, _, domain = email.partition("@")
    return f"{name[:1]}***@{domain}"


def _token(u: User, device: str) -> str:
    now = _utcnow()
    return jwt.encode({"sub": str(u.id), "email": u.email, "dev": device,
                       "iat": now, "exp": now + timedelta(days=TOKEN_DAYS)}, SECRET, algorithm="HS256")


def _auth(authorization: Optional[str]):
    """The signed-in user and computer, from the Bearer token."""
    if not authorization or not authorization.startswith("Bearer "):
        raise _err(401, "not_signed_in")
    try:
        claims = jwt.decode(authorization[7:], SECRET, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise _err(401, "session_expired")
    except jwt.PyJWTError:
        raise _err(401, "not_signed_in")
    with Session() as s:
        u = s.get(User, int(claims["sub"]))
    if not u:
        raise _err(401, "not_signed_in")
    if u.status == "blocked":
        raise _err(403, "blocked")
    # Rules accepted at sign-in, in the current version: a new version (or a
    # session from before there were rules) means sign in again and tick them.
    if u.terms_version != TERMS_VERSION:
        raise _err(403, "terms_not_accepted", version=TERMS_VERSION)
    return u, claims.get("dev", "")


def _window(u: User):
    """(when the current 24 hours end, seconds used in them), or (None, 0)
    when none are running: the next use starts them."""
    if u.window_start and _utcnow() < u.window_start + WINDOW:
        return u.window_start + WINDOW, int(u.window_used or 0)
    return None, 0


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() + "Z" if dt else None  # stored naive, in UTC


def _profile(u: User) -> dict:
    plan = _plan(u)
    limited = plan == "free"
    resets_at, used = _window(u)
    return {
        "email": u.email,
        "plan": plan,                       # free | commercial | unlimited | admin
        "role": u.role,
        "unlimited": bool(u.unlimited),
        "paid_until": _iso(u.paid_until),
        "balance": round(u.balance or 0.0, 2),   # USDT waiting to pay the next period
        # What a month and a year cost now, USDT: the payment window shows these
        # (cheap ones in a test are then seen at a glance, AUD-55).
        "prices": {"month": billing.PRICE["month"], "year": billing.PRICE["year"]},
        "limit_seconds": FREE_DAILY_SECONDS if limited else None,
        # The account's own 24 hours: used and left in them, and when they end
        # (None: not running — the next use starts them).
        "used": used if limited else None,
        "remaining": max(0, FREE_DAILY_SECONDS - used) if limited else None,
        "resets_at": _iso(resets_at) if limited else None,
    }


# --- sign-in ----------------------------------------------------------------------

class CodeRequest(BaseModel):
    email: str
    lang: str = "en"


@router.post("/auth/code")
def request_code(req: CodeRequest, request: Request):
    email = req.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise _err(400, "bad_email")
    domain = email.rsplit("@", 1)[1]
    if domain in DISPOSABLE:
        raise _err(400, "disposable_email")
    # Against bots and mail floods; a person needs one or two. The server-wide
    # cap comes last, so requests turned away by the others do not use it up.
    for key, limit, window in ((f"code-ip:{_client_ip(request)}", 20, 3600), (f"code-email:{email}", 5, 3600),
                               (f"code-email-day:{email}", CODE_PER_EMAIL_DAY, 86400),
                               ("code-all-day", CODE_PER_DAY, 86400)):
        ok, retry = rate.check(key, limit, window)
        if not ok:
            if key == "code-all-day":
                log.warning("sign-in codes: the cap of %s a day is reached", CODE_PER_DAY)
            raise _err(429, "too_many_requests", retry_after=retry)

    code = f"{secrets.randbelow(10 ** 6):06d}"
    with Session() as s:
        # Addresses that asked for a code a day ago and never entered it go,
        # so a flood of made-up addresses does not pile up in the table.
        s.query(User).filter(User.email_verified.is_(False), User.created_at < _utcnow() - timedelta(days=1),
                             User.email != email).delete(synchronize_session=False)
        u = s.query(User).filter(User.email == email).one_or_none()
        if u is None:
            admin = email in ADMIN_EMAILS
            # Every field set here: column defaults only apply when the row is
            # written, and this one is read before that.
            u = User(email=email, email_domain=domain, role="admin" if admin else "user", unlimited=admin,
                     status="active", email_verified=False, code_attempts=0)
            s.add(u)
        if u.status == "blocked":
            raise _err(403, "blocked")
        u.code_hash = _code_hash(email, code)
        u.code_expires = _utcnow() + CODE_TTL
        u.code_attempts = 0
        s.commit()
    try:
        mailer.send_code(email, code, req.lang)
    except Exception as e:  # noqa: BLE001 — reported to the user as "could not send"
        log.warning("mail to %s failed: %s", _mask(email), e)  # no full addresses in logs
        raise _err(502, "mail_failed")
    # The same answer for a known address and a new one: whether someone has
    # an account is not for anyone to find out by asking for codes.
    return {"sent": True}


class VerifyRequest(BaseModel):
    email: str
    code: str
    device: str
    tz: Optional[int] = 0
    terms: Optional[str] = None   # the version of the rules the user ticked


@router.post("/auth/verify")
def verify_code(req: VerifyRequest):
    email = req.email.strip().lower()
    device = req.device.strip().lower()
    if not DEVICE_RE.match(device):
        raise _err(400, "bad_device")
    # No sign-in without the rules accepted — the version shown now.
    if req.terms != TERMS_VERSION:
        raise _err(400, "terms_not_accepted", version=TERMS_VERSION)
    with Session() as s:
        u = s.query(User).filter(User.email == email).one_or_none()
        if u is None or not u.code_hash:
            raise _err(400, "no_code")
        if u.code_expires is None or u.code_expires < _utcnow():
            raise _err(400, "code_expired")
        if u.code_attempts >= CODE_TRIES:
            raise _err(429, "too_many_attempts")
        if not hmac.compare_digest(u.code_hash, _code_hash(email, req.code.strip())):
            u.code_attempts += 1
            s.commit()
            raise _err(400, "wrong_code", attempts_left=max(0, CODE_TRIES - u.code_attempts))

        # The code is right: it is used up either way.
        u.code_hash, u.code_expires, u.code_attempts = None, None, 0
        u.email_verified = True

        dev = s.query(Device).filter(Device.device_hash == device).one_or_none()
        if dev is None:
            dev = Device(device_hash=device)
            s.add(dev)
        dev.last_seen = _utcnow()
        # One free account per computer.
        if _plan(u) == "free":
            s.flush()
            if dev.free_user_id is None:
                dev.free_user_id = u.id
            elif dev.free_user_id != u.id:
                other = s.get(User, dev.free_user_id)
                s.commit()
                raise _err(403, "device_has_free_account", other_email=_mask(other.email) if other else None)
        u.last_login_at = _utcnow()
        if u.terms_version != TERMS_VERSION:
            u.terms_version, u.terms_accepted_at = TERMS_VERSION, _utcnow()
        s.commit()
        token = _token(u, device)
    return {"token": token, "profile": _profile(u)}


# --- the signed-in user -------------------------------------------------------------

@router.get("/me")
def me(tz: Optional[int] = 0, authorization: Optional[str] = Header(None)):
    u, device = _auth(authorization)
    # Invoices paid while nobody was asking (after "Back" in the payment
    # window, or with it closed, and no notification from xRocket): credited
    # now, so the profile is true. Never in the way of the answer itself.
    try:
        from payments import settle_pending   # payments.py imports this module: not at the top
        settle_pending(u.id)
    except Exception:   # noqa: BLE001 — the profile matters more than the sweep
        log.exception("settling pending invoices of user #%s", u.id)
    with Session() as s:
        u = s.get(User, u.id)
        # Whatever the balance covers is bought (a payment made elsewhere, a
        # price lowered since); a lapsed period starts again from now.
        if billing.settle(u, _utcnow()):
            s.commit()
    return _profile(u)


class UsageReport(BaseModel):
    seconds: int
    tz: Optional[int] = 0


@router.post("/usage")
def report_usage(rep: UsageReport, authorization: Optional[str] = Header(None)):
    """Count seconds of speech recognised: against the account's 24 hours
    (started by this use if none are running), and in the per-day history."""
    u, device = _auth(authorization)
    seconds = max(0, min(int(rep.seconds), 3600))
    day = _local_day(rep.tz)
    with Session() as s:
        u = s.get(User, u.id)
        now = _utcnow()
        if not (u.window_start and now < u.window_start + WINDOW):
            # The speech was just before this report: the 24 hours start with it.
            u.window_start, u.window_used = now - timedelta(seconds=seconds), 0
        u.window_used = (u.window_used or 0) + seconds
        row = s.query(Usage).filter(Usage.user_id == u.id, Usage.device_hash == device,
                                    Usage.day == day).one_or_none()
        if row is None:
            row = Usage(user_id=u.id, device_hash=device, day=day, seconds=0)
            s.add(row)
        row.seconds += seconds
        s.commit()
    return _profile(u)
