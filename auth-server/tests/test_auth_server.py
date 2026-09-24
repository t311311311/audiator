# -*- coding: utf-8 -*-
"""Tests for the auth server and gateway.

Covers the things that would cost money or let someone in for free if they
silently broke: token forgery, the daily allowance per tier, rate limits, the
one-trial-per-device rule, and the paid-subscription endpoint staying shut while
payments are unverified.
"""
from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException

import db
import main
import rate


# --- the suite must never write to the real database -----------------------

def test_tests_use_a_temporary_database():
    assert "audiator-tests-" in db.DATABASE_URL
    assert "audiator.db" not in db.DATABASE_URL


# --- tokens ----------------------------------------------------------------

def test_valid_token_round_trips():
    token = main.create_token("dev-1", 30)
    assert main.verify_token(token)["device_id"] == "dev-1"


def test_tampered_signature_is_rejected():
    device, exp, sig = main.create_token("dev-1", 30).split(".")
    forged = f"{device}.{exp}.{'0' * len(sig)}"
    with pytest.raises(HTTPException) as e:
        main.verify_token(forged)
    assert e.value.status_code == 401


def test_token_for_another_device_is_rejected():
    """The signature covers the device id, so it cannot be swapped."""
    device, exp, sig = main.create_token("dev-1", 30).split(".")
    with pytest.raises(HTTPException) as e:
        main.verify_token(f"dev-2.{exp}.{sig}")
    assert e.value.status_code == 401


def test_expired_token_is_rejected():
    with pytest.raises(HTTPException) as e:
        main.verify_token(main.create_token("dev-1", -1))
    assert e.value.status_code == 401


@pytest.mark.parametrize("bad", ["", "nonsense", "a.b", "a.b.c.d"])
def test_malformed_tokens_are_rejected(bad):
    with pytest.raises(HTTPException) as e:
        main.verify_token(bad)
    assert e.value.status_code == 401


# --- daily allowance by tier ----------------------------------------------

def test_unknown_device_gets_the_free_allowance():
    assert main.daily_limit_for("never-seen") == main.FREE_DAILY_SECONDS


def test_admin_is_unlimited():
    db.upsert_user("boss", role="admin")
    assert main.daily_limit_for("boss") == 0  # 0 means no limit


def test_active_subscription_gets_the_paid_allowance():
    db.upsert_user("sub", role="free",
                   subscription_end=datetime.now() + timedelta(days=10))
    assert main.daily_limit_for("sub") == main.PAID_DAILY_SECONDS


def test_expired_subscription_falls_back_to_free():
    db.upsert_user("lapsed", role="free",
                   subscription_end=datetime.now() - timedelta(days=1))
    assert main.daily_limit_for("lapsed") == main.FREE_DAILY_SECONDS


def test_free_allowance_is_sixty_minutes_by_default():
    assert main.FREE_DAILY_SECONDS == 3600


# --- usage accounting ------------------------------------------------------

def test_usage_accumulates_per_device_per_day():
    db.add_usage("dev-1", 120)
    db.add_usage("dev-1", 60)
    db.add_usage("dev-2", 30)
    assert db.usage_today("dev-1") == 180
    assert db.usage_today("dev-2") == 30


def test_non_positive_usage_is_ignored():
    db.add_usage("dev-1", 0)
    db.add_usage("dev-1", -5)
    assert db.usage_today("dev-1") == 0


def test_asr_seconds_read_from_the_whisper_response():
    class Resp:
        def json(self):
            return {"segments": [{"end": 1.2}, {"end": 7.4}]}
    assert main._asr_seconds(Resp()) == 7


def test_asr_seconds_is_zero_when_unparsable():
    """An odd response must never be over-billed against the quota."""
    class Resp:
        def json(self):
            raise ValueError("not json")
    assert main._asr_seconds(Resp()) == 0


# --- rate limiter ----------------------------------------------------------

def test_rate_limiter_allows_then_blocks():
    for _ in range(3):
        assert rate.check("k", 3, 60)[0] is True
    allowed, retry_after = rate.check("k", 3, 60)
    assert allowed is False
    assert retry_after > 0


def test_rate_limiter_keys_are_independent():
    assert rate.check("a", 1, 60)[0] is True
    assert rate.check("a", 1, 60)[0] is False
    assert rate.check("b", 1, 60)[0] is True


def test_rate_limiter_window_expires():
    assert rate.check("k", 1, 1)[0] is True
    assert rate.check("k", 1, 1)[0] is False
    import time
    time.sleep(1.1)
    assert rate.check("k", 1, 1)[0] is True


# --- endpoints -------------------------------------------------------------

def test_health_is_open(client):
    assert client.get("/health").status_code == 200


def test_trial_can_only_be_taken_once(client):
    body = {"device_id": "dev-trial", "device_name": "test"}
    assert client.post("/api/auth/trial", json=body).status_code == 200
    second = client.post("/api/auth/trial", json=body)
    assert second.status_code == 400
    assert "Trial already used" in second.text


def test_trial_is_rate_limited_per_ip(client):
    limit = main.TRIAL_PER_IP_DAY
    for i in range(limit):
        client.post("/api/auth/trial", json={"device_id": f"dev-{i}"})
    blocked = client.post("/api/auth/trial", json={"device_id": "one-too-many"})
    assert blocked.status_code == 429
    assert blocked.headers.get("Retry-After")


def test_paid_subscription_stays_closed_while_payments_are_unverified(client):
    """The endpoint trusts a client-supplied payment id, so it must not grant
    anything until the payment is verified server-side (AUD-15)."""
    db.upsert_user("dev-pay", role="free")
    r = client.post("/api/auth/subscription",
                    json={"device_id": "dev-pay", "plan": "1_month",
                          "payment_id": "made-up"})
    assert r.status_code == 503
    # and crucially: no subscription was handed out
    assert db.get_user("dev-pay")["subscription_end"] is None


def test_quota_endpoint_reports_the_free_allowance(client, token):
    db.add_usage("dev-q", 600)
    r = client.get("/api/auth/quota",
                   headers={"Authorization": f"Bearer {token('dev-q')}"})
    body = r.json()
    assert r.status_code == 200
    assert body["unlimited"] is False
    assert body["limit_seconds"] == main.FREE_DAILY_SECONDS
    assert body["used_seconds"] == 600
    assert body["remaining_seconds"] == main.FREE_DAILY_SECONDS - 600


def test_quota_endpoint_reports_admin_as_unlimited(client, token):
    db.upsert_user("boss", role="admin")
    body = client.get("/api/auth/quota",
                      headers={"Authorization": f"Bearer {token('boss')}"}).json()
    assert body["unlimited"] is True
    assert body["remaining_seconds"] is None


def test_asr_refuses_requests_without_a_token(client):
    r = client.post("/asr", files={"audio_file": ("a.webm", b"fake", "audio/webm")})
    assert r.status_code == 401


def test_translate_refuses_requests_without_a_token(client):
    assert client.post("/translate", json={"q": "hi", "target": "ru"}).status_code == 401


def test_asr_validates_the_upload_before_checking_the_token(client):
    """Documents a known quirk: FastAPI validates the multipart body first, so a
    request with no file gets 422 instead of 401. Harmless — it leaks only the
    parameter name — but worth pinning so a future change is a deliberate one."""
    assert client.post("/asr").status_code == 422


def test_asr_refuses_once_the_daily_allowance_is_spent(client, token):
    """Checked before any work is proxied, so an exhausted quota costs no CPU."""
    db.add_usage("dev-spent", main.FREE_DAILY_SECONDS + 1)
    r = client.post("/asr",
                    headers={"Authorization": f"Bearer {token('dev-spent')}"},
                    files={"audio_file": ("a.webm", b"fake", "audio/webm")})
    assert r.status_code == 402
    assert "лимит" in r.text.lower()


def test_admin_is_not_stopped_by_the_daily_allowance(client, token):
    """An admin past the free limit must get through the quota gate. The proxy
    to whisper then fails because no service is running here, which is exactly
    the proof that the request was not rejected earlier."""
    db.upsert_user("boss", role="admin")
    db.add_usage("boss", main.FREE_DAILY_SECONDS * 10)
    with pytest.raises(Exception) as e:
        client.post("/asr",
                    headers={"Authorization": f"Bearer {token('boss')}"},
                    files={"audio_file": ("a.webm", b"fake", "audio/webm")})
    assert "402" not in str(e.value)
