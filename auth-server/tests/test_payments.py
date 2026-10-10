# -*- coding: utf-8 -*-
"""Paying for the plan: the balance and the paid period (billing.py), xRocket
invoices (payments.py) — created, asked about, notified of, credited once — and
the notification's signature (xrocket.py). xRocket itself is never called: its
three calls are replaced, so nothing here touches real money or the network."""
import hashlib
import hmac
import json
import time
from datetime import timedelta

import pytest

import accounts
import accounts_db
import billing
import mailer
import payments
import xrocket

DEV = "d" * 64
SECRET = "whsec-test"


@pytest.fixture
def codes(monkeypatch):
    sent = {}
    monkeypatch.setattr(mailer, "send_code", lambda email, code, lang="en": sent.__setitem__(email, code))
    return sent


def signed_in(client, codes, email="buyer@mail.ru"):
    client.post("/api/v2/auth/code", json={"email": email})
    r = client.post("/api/v2/auth/verify", json={"email": email, "code": codes[email], "device": DEV,
                                                 "terms": accounts.TERMS_VERSION})
    return {"Authorization": f"Bearer {r.json()['token']}"}


class FakeRocket:
    """xRocket's calls, as the API answers them (a cancelled invoice is
    forgotten: 404 afterwards — seen on the real API, 2026-10-10)."""
    def __init__(self):
        self.invoices, self.calls = {}, []

    def create_invoice(self, amount, client_id, description, callback_url="", expires_ms=0):
        self.calls.append(("create", amount, client_id, description, callback_url))
        iid = str(6400000 + len(self.invoices))
        self.invoices[iid] = {"id": iid, "priceAmount": f"{amount:g}", "status": "active", "clientInvoiceId": client_id,
                              "expiresAt": "2026-10-09T12:00:00.000Z",
                              "links": {"telegramBotLink": f"https://t.me/xrocket?start=inv_{iid}"}, "received": 0.0}
        return dict(self.invoices[iid])

    def get_invoice(self, iid):
        self.calls.append(("get", iid))
        if iid not in self.invoices:
            raise xrocket.NotFound(f"GET /api/v1/invoice: 404 {iid}")
        return dict(self.invoices[iid])

    def delete_invoice(self, iid):
        self.calls.append(("delete", iid))
        if iid not in self.invoices:
            raise xrocket.NotFound(f"DELETE /api/v1/invoice: 404 {iid}")
        del self.invoices[iid]
        return {}

    def paid(self, iid):
        return self.invoices[iid]["received"]

    def pay(self, iid, received=None):
        inv = self.invoices[iid]
        inv["status"], inv["received"] = "paid", float(inv["priceAmount"]) if received is None else received


@pytest.fixture
def rocket(monkeypatch):
    fake = FakeRocket()
    monkeypatch.setenv("XROCKET_TOKEN", "test-token")
    monkeypatch.setenv("XROCKET_WEBHOOK_TOKEN", SECRET)
    for name in ("create_invoice", "get_invoice", "delete_invoice", "paid"):
        monkeypatch.setattr(xrocket, name, getattr(fake, name))
    return fake


def invoice(client, h, period="month", lang="ru"):
    r = client.post("/api/v2/pay/xrocket", json={"period": period, "lang": lang}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


def user(email="buyer@mail.ru"):
    with accounts_db.Session() as s:
        return s.query(accounts_db.User).filter_by(email=email).one()


# --- the balance and the period ------------------------------------------------------

class U:
    def __init__(self, balance=0.0, paid_until=None):
        self.balance, self.paid_until = balance, paid_until


@pytest.mark.parametrize("paid,days,left", [(3, 30, 0), (2.95, 30, 0), (2.9, None, 2.9), (10, 90, 1),
                                            (25, 365, 0), (24.6, 365, 0), (30, 395, 2), (53, 760, 0)])
def test_the_balance_buys_years_then_months_while_it_covers_one(paid, days, left):
    now = accounts_db._utcnow()
    u = U()
    billing.credit(u, paid, now)
    if days is None:
        assert u.paid_until is None, "short by more than 2%: waits on the balance"
    else:
        assert u.paid_until == now + timedelta(days=days)
    assert u.balance == pytest.approx(left), "only less than a month stays on the balance"


def test_a_payment_while_a_period_runs_adds_to_its_end():
    """Owner 2026-10-09: paying again while paid adds another month, it does
    not sit on the balance."""
    now = accounts_db._utcnow()
    u = U()
    billing.credit(u, 3, now)
    end = now + timedelta(days=30)
    billing.credit(u, 3, now + timedelta(days=10))
    assert u.paid_until == end + timedelta(days=30) and u.balance == 0
    billing.credit(u, 25, now + timedelta(days=11))
    assert u.paid_until == end + timedelta(days=30 + 365) and u.balance == 0, "a year on top"
    billing.credit(u, 2, now + timedelta(days=12))
    assert u.paid_until == end + timedelta(days=395) and u.balance == 2, "less than a month waits"
    billing.credit(u, 1, now + timedelta(days=13))
    assert u.paid_until == end + timedelta(days=425) and u.balance == 0, "and joins the next payment"


def test_a_lapsed_period_starts_again_from_now():
    now = accounts_db._utcnow()
    u = U(balance=0.0, paid_until=now - timedelta(days=5))
    billing.credit(u, 3, now)
    assert u.paid_until == now + timedelta(days=30), "the days in between were not paid for"
    assert not billing.settle(u, now + timedelta(days=1)), "nothing left to buy"


def test_a_free_price_never_loops(monkeypatch):
    monkeypatch.setitem(billing.PRICE, "month", 0)
    monkeypatch.setitem(billing.PRICE, "year", 0)
    u = U(balance=5.0)
    assert not billing.settle(u, accounts_db._utcnow()) and u.balance == 5


def test_the_profile_extends_a_running_period_from_the_balance(client, codes, monkeypatch):
    """The owner's case: paid till 08.11 with 0.01 on the balance and a month
    at 0.01 — the next /me makes it 08.12 and the balance 0."""
    monkeypatch.setitem(billing.PRICE, "month", 0.01)
    h = signed_in(client, codes)
    end = accounts_db._utcnow().replace(microsecond=0) + timedelta(days=30)
    with accounts_db.Session() as s:
        u = s.query(accounts_db.User).one()
        u.balance, u.paid_until = 0.01, end
        s.commit()
    me = client.get("/api/v2/me", headers=h).json()
    assert me["plan"] == "commercial" and me["balance"] == 0
    assert user().paid_until == end + timedelta(days=30)


# --- xRocket invoices ------------------------------------------------------------------

def test_an_invoice_for_a_month_opens_in_telegram(client, codes, rocket, monkeypatch):
    monkeypatch.setenv("PUBLIC_URL", "https://audiator.example")
    h = signed_in(client, codes)
    r = invoice(client, h)
    assert r["url"].startswith("https://t.me/xrocket?start=inv_") and r["price"] == 3
    (_, amount, client_id, description, callback) = rocket.calls[0]
    assert amount == 3 and client_id == f"aud-{r['id']}" and description == "Audiator — 1 месяц"
    assert callback == "https://audiator.example/api/v2/pay/xrocket/webhook"
    with accounts_db.Session() as s:
        p = s.get(accounts_db.Payment, r["id"])
        assert p.status == "pending" and p.provider == "xrocket" and p.period == "month" and p.invoice_id


def test_paid_invoice_is_credited_once_and_starts_the_month(client, codes, rocket):
    h = signed_in(client, codes)
    r = invoice(client, h)
    assert client.get(f"/api/v2/pay/{r['id']}", headers=h).json()["status"] == "pending"
    rocket.pay(next(iter(rocket.invoices)))
    body = client.get(f"/api/v2/pay/{r['id']}", headers=h).json()
    assert body["status"] == "paid" and body["credited"] == 3
    assert body["profile"]["plan"] == "commercial" and body["profile"]["balance"] == 0
    first = user().paid_until
    client.get(f"/api/v2/pay/{r['id']}", headers=h)
    assert user().paid_until == first and user().balance == 0, "asked again: not credited twice"


def test_a_year(client, codes, rocket):
    h = signed_in(client, codes)
    r = invoice(client, h, "year", "en")
    assert rocket.calls[0][3] == "Audiator — 1 year"
    rocket.pay(next(iter(rocket.invoices)))
    body = client.get(f"/api/v2/pay/{r['id']}", headers=h).json()
    paid_until = user().paid_until
    assert body["profile"]["plan"] == "commercial"
    assert timedelta(days=364) < paid_until - accounts_db._utcnow() <= timedelta(days=365)


def test_an_expired_invoice_credits_nothing(client, codes, rocket):
    h = signed_in(client, codes)
    r = invoice(client, h)
    rocket.invoices[next(iter(rocket.invoices))]["status"] = "expired"
    assert client.get(f"/api/v2/pay/{r['id']}", headers=h).json()["status"] == "expired"
    assert user().paid_until is None and user().balance == 0


def test_someone_elses_payment_is_not_shown(client, codes, rocket):
    r = invoice(client, signed_in(client, codes))
    other = signed_in(client, codes, "owner@example.com")   # an admin: no free-account rule on this computer
    assert client.get(f"/api/v2/pay/{r['id']}", headers=other).status_code == 404


def test_without_xrocket_configured_payments_are_off(client, codes, monkeypatch):
    monkeypatch.setenv("XROCKET_TOKEN", "")
    r = client.post("/api/v2/pay/xrocket", json={"period": "month"}, headers=signed_in(client, codes))
    assert r.status_code == 503 and r.json()["detail"]["error"] == "payments_off"


def test_bad_period_and_too_many_invoices(client, codes, rocket):
    h = signed_in(client, codes)
    assert client.post("/api/v2/pay/xrocket", json={"period": "week"}, headers=h).status_code == 400
    for _ in range(payments.PER_HOUR):
        invoice(client, h)
    assert client.post("/api/v2/pay/xrocket", json={"period": "month"}, headers=h).status_code == 429


def test_a_provider_error_is_told_not_hidden(client, codes, rocket, monkeypatch):
    def down(*a, **k):
        raise xrocket.Error("POST /api/v1/invoices: 500")
    monkeypatch.setattr(xrocket, "create_invoice", down)
    r = client.post("/api/v2/pay/xrocket", json={"period": "month"}, headers=signed_in(client, codes))
    assert r.status_code == 502 and r.json()["detail"]["error"] == "pay_provider_error"
    with accounts_db.Session() as s:
        assert s.query(accounts_db.Payment).one().status == "failed"


# --- the notification ------------------------------------------------------------------

def notify(client, client_id, secret=SECRET, stamp=None, version="v1", event="invoice_status_changed"):
    raw = json.dumps({"id": "777", "type": "invoice", "timestamp": "2026-10-09T10:30:00.000Z",
                      "data": {"event": event, "invoice": {"id": "x", "status": "paid",
                                                          "clientInvoiceId": client_id}}}).encode()
    stamp = str(int(time.time() * 1000)) if stamp is None else stamp
    sig = hmac.new(secret.encode(), f"{stamp}.".encode() + raw, hashlib.sha256).hexdigest()
    return client.post("/api/v2/pay/xrocket/webhook", content=raw, headers={
        "Content-Type": "application/json", "Signature": sig, "Signature-Version": version,
        "Signature-Timestamp": stamp})


def test_a_signed_notification_credits_at_once(client, codes, rocket):
    h = signed_in(client, codes)
    r = invoice(client, h)
    rocket.pay(next(iter(rocket.invoices)))
    assert notify(client, f"aud-{r['id']}").status_code == 200
    assert user().paid_until is not None, "credited without the app asking"
    notify(client, f"aud-{r['id']}")   # delivered again (retries): still once
    body = client.get(f"/api/v2/pay/{r['id']}", headers=h).json()
    assert body["status"] == "paid" and user().balance == 0


def test_a_notification_alone_cannot_credit(client, codes, rocket):
    """It says "paid", but xRocket's API says the invoice is not: nothing."""
    r = invoice(client, signed_in(client, codes))
    assert notify(client, f"aud-{r['id']}").status_code == 200
    assert user().paid_until is None


@pytest.mark.parametrize("kwargs", [{"secret": "forged"}, {"version": "v2"},
                                    {"stamp": str(int(time.time() * 1000) - 10 * 60 * 1000)}])
def test_forged_wrong_version_or_stale_notifications_are_refused(client, codes, rocket, kwargs):
    r = invoice(client, signed_in(client, codes))
    rocket.pay(next(iter(rocket.invoices)))
    assert notify(client, f"aud-{r['id']}", **kwargs).status_code == 401
    assert user().paid_until is None


def test_signature_needs_every_header(monkeypatch):
    monkeypatch.setenv("XROCKET_WEBHOOK_TOKEN", SECRET)
    assert not xrocket.verify({}, b"{}")
    monkeypatch.setenv("XROCKET_WEBHOOK_TOKEN", "")
    stamp = str(int(time.time() * 1000))
    sig = hmac.new(b"", f"{stamp}.{{}}".encode(), hashlib.sha256).hexdigest()
    assert not xrocket.verify({"Signature": sig, "Signature-Version": "v1", "Signature-Timestamp": stamp}, b"{}"), \
        "no secret configured: nothing is trusted"


def test_the_profile_tells_the_prices(client, codes, monkeypatch):
    """The payment window shows what the server asks (AUD-55): the usual
    prices, or a test's cheap ones — seen at a glance."""
    h = signed_in(client, codes)
    assert client.get("/api/v2/me", headers=h).json()["prices"] == {"month": 3, "year": 25}
    monkeypatch.setitem(billing.PRICE, "month", 0.1)
    monkeypatch.setitem(billing.PRICE, "year", 1.2)
    assert client.get("/api/v2/me", headers=h).json()["prices"] == {"month": 0.1, "year": 1.2}


# --- paid while nobody was asking (AUD-58) ---------------------------------------------

def gets(rocket, iid=None):
    return [c for c in rocket.calls if c[0] == "get" and (iid is None or c[1] == iid)]


def test_an_invoice_paid_after_the_window_stopped_asking_is_credited_with_the_profile(client, codes, rocket):
    """The owner's case, 2026-10-10: an invoice asked for, "Back" pressed in
    the payment window (it stops asking), then paid in Telegram — and no
    notification reaches a dev machine. The next profile credits it, once."""
    h = signed_in(client, codes)
    r = invoice(client, h)
    rocket.pay(next(iter(rocket.invoices)))                 # paid in Telegram; nobody asks GET /pay/{id}
    assert user().paid_until is None, "not known here yet"
    me = client.get("/api/v2/me", headers=h).json()
    assert me["plan"] == "commercial" and me["balance"] == 0, "the profile found it and credited it"
    first = user().paid_until
    with accounts_db.Session() as s:
        p = s.get(accounts_db.Payment, r["id"])
        assert p.status == "paid" and p.credited == 3
    asked = len(gets(rocket))
    client.get("/api/v2/me", headers=h)
    assert user().paid_until == first and len(gets(rocket)) == asked, "settled: not credited or asked about again"


def test_an_unpaid_invoice_stays_and_an_expired_one_is_closed(client, codes, rocket):
    h = signed_in(client, codes)
    r = invoice(client, h)
    iid = next(iter(rocket.invoices))
    assert client.get("/api/v2/me", headers=h).json()["plan"] == "free"
    with accounts_db.Session() as s:
        assert s.get(accounts_db.Payment, r["id"]).status == "pending", "still payable: left as it is"
    rocket.invoices[iid]["status"] = "expired"
    client.get("/api/v2/me", headers=h)
    with accounts_db.Session() as s:
        assert s.get(accounts_db.Payment, r["id"]).status == "expired"
    asked = len(gets(rocket))
    client.get("/api/v2/me", headers=h)
    assert len(gets(rocket)) == asked, "closed: xRocket is not asked about it any more"
    assert user().paid_until is None and user().balance == 0


def test_the_profile_answers_when_xrocket_does_not(client, codes, rocket, monkeypatch):
    h = signed_in(client, codes)
    r = invoice(client, h)
    rocket.pay(next(iter(rocket.invoices)))
    waited = []

    def down(iid):
        waited.append(xrocket._timeout.get())
        raise xrocket.Error("timeout")
    monkeypatch.setattr(xrocket, "get_invoice", down)
    res = client.get("/api/v2/me", headers=h)
    assert res.status_code == 200 and res.json()["plan"] == "free", "the profile comes anyway"
    assert waited == [payments.SWEEP_PATIENCE], "asked once, with little patience, then left for the next time"
    assert xrocket._timeout.get() == 20, "the usual patience is back afterwards"
    monkeypatch.setattr(xrocket, "get_invoice", rocket.get_invoice)
    assert client.get("/api/v2/me", headers=h).json()["plan"] == "commercial", "xRocket back: credited then"
    assert user().balance == 0 and r["id"]


def test_only_the_accounts_own_newest_invoices_are_asked_about(client, codes, rocket):
    h = signed_in(client, codes)
    mine = [invoice(client, h)["id"] for _ in range(payments.SWEEP + 2)]
    other = signed_in(client, codes, "owner@example.com")   # an admin: no free-account rule on this computer
    theirs = invoice(client, other)["id"]
    rocket.calls.clear()
    client.get("/api/v2/me", headers=h)
    with accounts_db.Session() as s:
        asked = {s.query(accounts_db.Payment).filter_by(invoice_id=c[1]).one().id for c in gets(rocket)}
    assert asked == set(mine[-payments.SWEEP:]), "the newest few of this account, nobody else's"
    assert theirs not in asked


def test_no_xrocket_no_sweep(client, codes, rocket, monkeypatch):
    h = signed_in(client, codes)
    invoice(client, h)
    monkeypatch.setenv("XROCKET_TOKEN", "")
    rocket.calls.clear()
    assert client.get("/api/v2/me", headers=h).status_code == 200 and not gets(rocket)


# --- "Cancel" really cancels (AUD-59) -----------------------------------------------------

def cancel(client, h, payment_id):
    r = client.post(f"/api/v2/pay/{payment_id}/cancel", headers=h)
    assert r.status_code == 200, r.text
    return r.json()


def test_cancel_deletes_the_invoice_at_xrocket_and_closes_the_payment(client, codes, rocket):
    """Owner 2026-10-10: cancelling in the app must make the invoice invalid —
    "Back" had left it payable in Telegram."""
    h = signed_in(client, codes)
    r = invoice(client, h)
    iid = next(iter(rocket.invoices))
    body = cancel(client, h, r["id"])
    assert body["status"] == "cancelled" and body["credited"] is None and body["profile"]["plan"] == "free"
    assert iid not in rocket.invoices, "gone at xRocket: it cannot be paid there any more"
    assert ("delete", iid) in rocket.calls
    rocket.calls.clear()
    client.get("/api/v2/me", headers=h)
    assert cancel(client, h, r["id"])["status"] == "cancelled" and not rocket.calls, "closed: xRocket is not asked again"


def test_cancel_after_the_money_came_is_a_payment(client, codes, rocket):
    h = signed_in(client, codes)
    r = invoice(client, h)
    iid = next(iter(rocket.invoices))
    rocket.pay(iid)                                  # paid in Telegram a moment before "Cancel"
    body = cancel(client, h, r["id"])
    assert body["status"] == "paid" and body["credited"] == 3 and body["profile"]["plan"] == "commercial"
    assert ("delete", iid) not in rocket.calls and iid in rocket.invoices, "a paid invoice is not deleted"
    assert user().balance == 0


def test_cancel_that_xrocket_would_not_do_leaves_the_invoice_payable(client, codes, rocket, monkeypatch):
    h = signed_in(client, codes)
    r = invoice(client, h)
    iid = next(iter(rocket.invoices))

    def refused(i):
        raise xrocket.Error("DELETE /api/v1/invoice: timeout")
    monkeypatch.setattr(xrocket, "delete_invoice", refused)
    assert cancel(client, h, r["id"])["status"] == "pending", "not cancelled: the app says so"
    rocket.pay(iid)                                  # and it is paid after all
    assert client.get("/api/v2/me", headers=h).json()["plan"] == "commercial", "then it counts"


def test_cancel_when_xrocket_is_down_answers_all_the_same(client, codes, rocket, monkeypatch):
    h = signed_in(client, codes)
    r = invoice(client, h)

    def down(i):
        raise xrocket.Error("timeout")
    monkeypatch.setattr(xrocket, "get_invoice", down)
    assert cancel(client, h, r["id"])["status"] == "pending"


def test_only_ones_own_pending_payment_is_cancelled(client, codes, rocket):
    h = signed_in(client, codes)
    r = invoice(client, h)
    iid = next(iter(rocket.invoices))
    other = signed_in(client, codes, "owner@example.com")
    assert client.post(f"/api/v2/pay/{r['id']}/cancel", headers=other).status_code == 404
    assert iid in rocket.invoices
    rocket.invoices[iid]["status"] = "expired"
    assert cancel(client, h, r["id"])["status"] == "expired" and ("delete", iid) not in rocket.calls


def test_an_invoice_xrocket_has_forgotten_is_closed_once_past_its_life(client, codes, rocket):
    """Cancelled at xRocket while our record stayed pending (the app killed in
    between): young — left alone; past the invoice's life — closed."""
    h = signed_in(client, codes)
    r = invoice(client, h)
    del rocket.invoices[next(iter(rocket.invoices))]
    assert client.get("/api/v2/me", headers=h).status_code == 200
    with accounts_db.Session() as s:
        p = s.get(accounts_db.Payment, r["id"])
        assert p.status == "pending", "it may still be a passing error: not closed on a 404 alone"
        p.created_at = accounts_db._utcnow() - timedelta(minutes=payments.INVOICE_MINUTES + 11)
        s.commit()
    client.get("/api/v2/me", headers=h)
    with accounts_db.Session() as s:
        assert s.get(accounts_db.Payment, r["id"]).status == "expired"


def test_a_404_from_xrocket_is_told_apart(monkeypatch):
    class Answer:
        def __init__(self, code):
            self.status_code, self.text, self.content = code, '{"title":"Invoice not found"}', b"{}"

        def json(self):
            return {}
    monkeypatch.setattr(xrocket.httpx, "request", lambda *a, **kw: Answer(404))
    with pytest.raises(xrocket.NotFound):
        xrocket.get_invoice("1")
    monkeypatch.setattr(xrocket.httpx, "request", lambda *a, **kw: Answer(500))
    with pytest.raises(xrocket.Error) as e:
        xrocket.delete_invoice("1")
    assert not isinstance(e.value, xrocket.NotFound)
    sent = {}
    monkeypatch.setattr(xrocket.httpx, "request", lambda method, url, **kw: sent.update(method=method, url=url, **kw) or Answer(200))
    xrocket.delete_invoice("6436387")
    assert sent["method"] == "DELETE" and sent["url"].endswith("/api/v1/invoice") and sent["params"] == {"invoiceId": "6436387"}


def test_the_profile_tells_the_balance_and_renews_on_sign_in(client, codes):
    h = signed_in(client, codes)
    with accounts_db.Session() as s:
        u = s.query(accounts_db.User).one()
        u.balance, u.paid_until = 5.0, accounts_db._utcnow() - timedelta(minutes=1)   # a month ran out, 5 left
        s.commit()
    me = client.get("/api/v2/me", headers=h).json()
    assert me["plan"] == "commercial" and me["balance"] == 2, "the next month from the balance"


def test_the_buyer_pays_the_price_and_the_fee_is_ours(monkeypatch):
    """Owner's decision 2026-10-09: no fee on top for the buyer; xRocket's 1.5%
    comes out of what we receive, and the balance gets what the buyer paid."""
    sent = {}
    monkeypatch.setattr(xrocket, "_call", lambda method, path, **kw: sent.update(kw.get("json") or {}) or {"id": "1"})
    xrocket.create_invoice(3, "aud-1", "Audiator — 1 месяц")
    assert sent["isFeePaidByUser"] is False and sent["priceAmount"] == "3"
    pages = {"items": [{"status": "paid", "finalizedAt": "2026-10-09T10:30:00Z", "payAmount": "3", "receiveAmount": "2.955"},
                       {"status": "pending", "finalizedAt": None, "payAmount": "3", "receiveAmount": "2.955"}]}
    monkeypatch.setattr(xrocket, "_call", lambda method, path, **kw: pages)
    assert xrocket.paid("1") == 3, "what the buyer paid, not what reached us after the fee"
