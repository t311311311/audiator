# -*- coding: utf-8 -*-
"""Accounts by email (step 4): sign-in by code, one free account per computer,
the daily allowance by local day, admins and lifetime-unlimited users."""
from datetime import datetime, timedelta

import pytest

import accounts
import accounts_db
import mailer

DEV_A = "a" * 64   # a computer (hash of its MachineGuid)
DEV_B = "b" * 64


@pytest.fixture
def mailbox(monkeypatch):
    """Catch the codes instead of mailing them."""
    sent = {}
    monkeypatch.setattr(mailer, "send_code", lambda email, code, lang="en": sent.__setitem__(email, code))
    return sent


def sign_in(client, mailbox, email, device=DEV_A, tz=0):
    r = client.post("/api/v2/auth/code", json={"email": email, "lang": "ru"})
    assert r.status_code == 200, r.text
    return client.post("/api/v2/auth/verify",
                       json={"email": email, "code": mailbox[email.lower()], "device": device, "tz": tz})


def auth(r):
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_first_sign_in_creates_the_account(client, mailbox):
    r = client.post("/api/v2/auth/code", json={"email": "Ivan@Mail.RU "})
    assert r.json() == {"sent": True, "new": True}
    assert "ivan@mail.ru" in mailbox and len(mailbox["ivan@mail.ru"]) == 6
    r = client.post("/api/v2/auth/verify", json={"email": "ivan@mail.ru", "code": mailbox["ivan@mail.ru"], "device": DEV_A})
    assert r.status_code == 200
    p = r.json()["profile"]
    assert p["email"] == "ivan@mail.ru" and p["plan"] == "free"
    assert p["limit_seconds"] == 7200 and p["remaining_today"] == 7200
    with accounts_db.Session() as s:
        u = s.query(accounts_db.User).one()
        assert u.email_verified and u.email_domain == "mail.ru" and u.code_hash is None
    # second time it is just a sign-in
    assert client.post("/api/v2/auth/code", json={"email": "ivan@mail.ru"}).json()["new"] is False


def test_wrong_code_counts_tries_and_locks_after_five(client, mailbox):
    client.post("/api/v2/auth/code", json={"email": "a@b.com"})
    good = mailbox["a@b.com"]
    bad = "000000" if good != "000000" else "111111"
    for left in (4, 3, 2, 1, 0):
        r = client.post("/api/v2/auth/verify", json={"email": "a@b.com", "code": bad, "device": DEV_A})
        assert r.status_code == 400 and r.json()["detail"] == {"error": "wrong_code", "attempts_left": left}
    r = client.post("/api/v2/auth/verify", json={"email": "a@b.com", "code": good, "device": DEV_A})
    assert r.status_code == 429 and r.json()["detail"]["error"] == "too_many_attempts"


def test_code_expires_and_is_single_use(client, mailbox):
    client.post("/api/v2/auth/code", json={"email": "a@b.com"})
    with accounts_db.Session() as s:
        u = s.query(accounts_db.User).one()
        u.code_expires = accounts._utcnow() - timedelta(seconds=1)
        s.commit()
    r = client.post("/api/v2/auth/verify", json={"email": "a@b.com", "code": mailbox["a@b.com"], "device": DEV_A})
    assert r.json()["detail"]["error"] == "code_expired"
    r = sign_in(client, mailbox, "a@b.com")
    assert r.status_code == 200
    r = client.post("/api/v2/auth/verify", json={"email": "a@b.com", "code": mailbox["a@b.com"], "device": DEV_A})
    assert r.json()["detail"]["error"] == "no_code", "a used code does not work twice"


@pytest.mark.parametrize("email,error", [("not-an-email", "bad_email"), ("x@mailinator.com", "disposable_email"),
                                         ("x@yopmail.com", "disposable_email")])
def test_bad_and_throwaway_addresses_are_refused(client, mailbox, email, error):
    r = client.post("/api/v2/auth/code", json={"email": email})
    assert r.status_code == 400 and r.json()["detail"]["error"] == error
    assert not mailbox


def test_codes_are_rate_limited_per_email(client, mailbox):
    for _ in range(5):
        assert client.post("/api/v2/auth/code", json={"email": "a@b.com"}).status_code == 200
    r = client.post("/api/v2/auth/code", json={"email": "a@b.com"})
    assert r.status_code == 429 and r.json()["detail"]["error"] == "too_many_requests"


def test_one_free_account_per_computer(client, mailbox):
    assert sign_in(client, mailbox, "first@b.com", DEV_A).status_code == 200
    r = sign_in(client, mailbox, "second@b.com", DEV_A)
    assert r.status_code == 403
    assert r.json()["detail"] == {"error": "device_has_free_account", "other_email": "f***@b.com"}
    # the first one can still sign in there, and the second on another computer
    assert sign_in(client, mailbox, "first@b.com", DEV_A).status_code == 200
    assert sign_in(client, mailbox, "second@b.com", DEV_B).status_code == 200


def test_paid_and_unlimited_accounts_are_not_bound_to_the_free_rule(client, mailbox):
    assert sign_in(client, mailbox, "first@b.com", DEV_A).status_code == 200
    client.post("/api/v2/auth/code", json={"email": "payer@b.com"})
    with accounts_db.Session() as s:
        u = s.query(accounts_db.User).filter_by(email="payer@b.com").one()
        u.paid_until = accounts._utcnow() + timedelta(days=30)
        s.commit()
    r = client.post("/api/v2/auth/verify", json={"email": "payer@b.com", "code": mailbox["payer@b.com"], "device": DEV_A})
    assert r.status_code == 200 and r.json()["profile"]["plan"] == "commercial"
    assert r.json()["profile"]["remaining_today"] is None


def test_admin_email_is_admin_and_unlimited(client, mailbox):
    r = sign_in(client, mailbox, "Owner@Example.com")
    p = r.json()["profile"]
    assert p["plan"] == "admin" and p["unlimited"] is True and p["limit_seconds"] is None


def test_lifetime_unlimited_flag(client, mailbox):
    r = sign_in(client, mailbox, "friend@b.com")
    with accounts_db.Session() as s:
        s.query(accounts_db.User).filter_by(email="friend@b.com").one().unlimited = True
        s.commit()
    p = client.get("/api/v2/me", headers=auth(r)).json()
    assert p["plan"] == "unlimited" and p["remaining_today"] is None


def test_usage_counts_against_the_free_allowance(client, mailbox):
    r = sign_in(client, mailbox, "a@b.com")
    p = client.post("/api/v2/usage", json={"seconds": 600, "tz": 0}, headers=auth(r)).json()
    assert p["used_today"] == 600 and p["remaining_today"] == 6600
    p = client.post("/api/v2/usage", json={"seconds": 7000, "tz": 0}, headers=auth(r)).json()
    assert p["used_today"] == 600 + 3600, "one report counts at most an hour"
    for _ in range(2):
        p = client.post("/api/v2/usage", json={"seconds": 3600, "tz": 0}, headers=auth(r)).json()
    assert p["remaining_today"] == 0, "never below zero" 


def test_the_day_is_the_users_local_day(client, mailbox, monkeypatch):
    # 23:30 UTC: still the same day in London, already the next day in Moscow (UTC+3).
    r = sign_in(client, mailbox, "a@b.com")
    # Move the clock the day is read from (tokens keep the real one).
    monkeypatch.setattr(accounts, "_utcnow", lambda: datetime(2026, 10, 3, 23, 30))
    assert client.get("/api/v2/me?tz=0", headers=auth(r)).json()["day"] == "2026-10-03"
    assert client.get("/api/v2/me?tz=-180", headers=auth(r)).json()["day"] == "2026-10-04"
    client.post("/api/v2/usage", json={"seconds": 100, "tz": -180}, headers=auth(r))
    assert client.get("/api/v2/me?tz=-180", headers=auth(r)).json()["used_today"] == 100
    assert client.get("/api/v2/me?tz=0", headers=auth(r)).json()["used_today"] == 0


def test_me_needs_a_valid_token(client, mailbox):
    assert client.get("/api/v2/me").status_code == 401
    assert client.get("/api/v2/me", headers={"Authorization": "Bearer nonsense"}).status_code == 401
    r = sign_in(client, mailbox, "a@b.com")
    with accounts_db.Session() as s:
        s.query(accounts_db.User).one().status = "blocked"
        s.commit()
    assert client.get("/api/v2/me", headers=auth(r)).status_code == 403


def test_the_computer_id_must_be_a_hash(client, mailbox):
    client.post("/api/v2/auth/code", json={"email": "a@b.com"})
    r = client.post("/api/v2/auth/verify", json={"email": "a@b.com", "code": mailbox["a@b.com"], "device": "MY-PC"})
    assert r.status_code == 400 and r.json()["detail"]["error"] == "bad_device"
