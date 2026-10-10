# -*- coding: utf-8 -*-
"""Paying for the plan (the rules, section 4; docs/PRODUCT-PLAN.md, step 5).

The main way (owner's decision 2026-10-09): an xRocket invoice, paid inside
Telegram from the payer's xRocket wallet. The buyer pays the price; xRocket's
1.5% comes out of what we receive.

  POST /api/v2/pay/xrocket            {period: month|year, lang}  -> {id, url, expires_at, price}
  GET  /api/v2/pay/{id}                                            -> {status, credited, profile}
  POST /api/v2/pay/xrocket/webhook    xRocket's signed notification

The app opens url (the invoice in @xRocket) and asks GET /pay/{id} every few
seconds while its window is open; the notification only makes it quicker. Both
end in reconcile(), which reads the invoice and what reached us from xRocket's
API and credits the balance once — whichever comes first.

An invoice paid when neither happens — after "Back" or with the window closed,
and no notification reaching us (never on a dev machine; a restart or the
network on the server) — is settled by settle_pending() the next time the app
asks for the profile (GET /me): money that came is never left uncredited.

  PUBLIC_URL   the server's own address for xRocket's notifications
               (https://audiator.duckdns.org); without it, asking is enough.
"""
import json
import logging
import os
from typing import Optional

from fastapi import APIRouter, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

import billing
import rate
import xrocket
from accounts import _auth, _err, _iso, _profile, _utcnow
from accounts_db import Payment, Session, User

router = APIRouter(prefix="/api/v2")
log = logging.getLogger("audiator")

INVOICE_MINUTES = 30
PER_HOUR = 10   # invoices an account may ask for in an hour
SWEEP = 3           # an account's newest unsettled invoices asked about with one profile
SWEEP_PATIENCE = 6  # seconds to wait for xRocket then: the profile must not hang on it
DESCRIPTION = {
    "en": {"month": "Audiator — 1 month", "year": "Audiator — 1 year"},
    "ru": {"month": "Audiator — 1 месяц", "year": "Audiator — 1 год"},
    "zh": {"month": "Audiator — 1 个月", "year": "Audiator — 1 年"},
}


class InvoiceRequest(BaseModel):
    period: str
    lang: str = "en"


def _client_id(p: Payment) -> str:
    return f"aud-{p.id}"


@router.post("/pay/xrocket")
def new_invoice(req: InvoiceRequest, authorization: Optional[str] = Header(None)):
    u, _device = _auth(authorization)
    if req.period not in billing.PRICE:
        raise _err(400, "bad_period")
    if not xrocket.configured():
        raise _err(503, "payments_off")
    ok, retry = rate.check(f"pay:{u.id}", PER_HOUR, 3600)
    if not ok:
        raise _err(429, "too_many_requests", retry_after=retry)
    price = billing.PRICE[req.period]
    with Session() as s:
        p = Payment(user_id=u.id, amount=price, currency="USDT", provider="xrocket", status="pending",
                    period=req.period, created_at=_utcnow())
        s.add(p)
        s.flush()
        public = os.environ.get("PUBLIC_URL", "").rstrip("/")
        try:
            inv = xrocket.create_invoice(
                price, _client_id(p), DESCRIPTION.get(req.lang, DESCRIPTION["en"])[req.period],
                callback_url=f"{public}/api/v2/pay/xrocket/webhook" if public else "",
                expires_ms=INVOICE_MINUTES * 60 * 1000)
        except xrocket.Error as e:
            p.status = "failed"
            s.commit()
            log.warning("xrocket invoice for payment #%s failed: %s", p.id, e)
            raise _err(502, "pay_provider_error")
        p.invoice_id = str(inv.get("id"))
        p.pay_url = (inv.get("links") or {}).get("telegramBotLink")
        s.commit()
        return {"id": p.id, "url": p.pay_url, "expires_at": inv.get("expiresAt"), "price": price,
                "period": req.period}


def reconcile(payment_id: int) -> str:
    """Read the invoice back from xRocket and settle the payment: paid — the
    received amount onto the balance (once); expired or cancelled — expired.
    Returns the payment's status."""
    with Session() as s:
        p = s.get(Payment, payment_id)
        if p is None or p.status != "pending" or p.provider != "xrocket" or not p.invoice_id:
            return p.status if p else "missing"
        inv = xrocket.get_invoice(p.invoice_id)
        status = inv.get("status")
        if status in ("expired", "cancelled"):
            p.status = "expired"
            s.commit()
            return p.status
        if status != "paid":
            return p.status
        # What the buyer paid goes to the balance; xRocket's fee is ours.
        amount = xrocket.paid(p.invoice_id) or float(inv.get("priceAmount") or 0)
        now = _utcnow()
        # Only the request that moves it from pending credits it: a notification
        # and the app's question can arrive together.
        moved = (s.query(Payment).filter(Payment.id == p.id, Payment.status == "pending")
                 .update({"status": "paid", "paid_at": now, "credited": amount,
                          "tx_hash": f"xrocket:{p.invoice_id}"}, synchronize_session=False))
        if moved != 1:
            s.rollback()
            return "paid"
        u = s.get(User, p.user_id)
        billing.credit(u, amount, now)
        s.commit()
        log.info("payment #%s: %s USDT credited (xrocket invoice %s)", p.id, amount, p.invoice_id)
        return "paid"


def settle_pending(user_id: int) -> bool:
    """The account's invoices still "pending" here, asked of xRocket again:
    a paid one is credited, an expired one closed (and never asked about
    again). For what the waiting screen and the notification both missed (see
    the top). The newest few at a time, with little patience; xRocket not
    answering just leaves them for the next time. True if any was credited."""
    if not xrocket.configured():
        return False
    with Session() as s:
        ids = [p.id for p in s.query(Payment)
               .filter(Payment.user_id == user_id, Payment.provider == "xrocket", Payment.status == "pending",
                       Payment.invoice_id.isnot(None))
               .order_by(Payment.id.desc()).limit(SWEEP)]
    credited = False
    for payment_id in ids:
        try:
            with xrocket.patience(SWEEP_PATIENCE):
                credited = reconcile(payment_id) == "paid" or credited
        except xrocket.Error as e:
            log.warning("payment #%s: xrocket not reachable, left for the next time: %s", payment_id, e)
            break
    return credited


@router.get("/pay/{payment_id}")
def payment_status(payment_id: int, authorization: Optional[str] = Header(None)):
    u, _device = _auth(authorization)
    with Session() as s:
        p = s.get(Payment, payment_id)
        if p is None or p.user_id != u.id:
            raise _err(404, "no_payment")
    status = p.status
    if status == "pending":
        try:
            status = reconcile(payment_id)
        except xrocket.Error as e:
            log.warning("payment #%s: xrocket not reachable: %s", payment_id, e)
    with Session() as s:
        p = s.get(Payment, payment_id)
        u = s.get(User, u.id)
        if billing.settle(u, _utcnow()):
            s.commit()
        return {"id": p.id, "status": p.status, "credited": p.credited, "paid_at": _iso(p.paid_at),
                "profile": _profile(u)}


@router.post("/pay/xrocket/webhook")
async def xrocket_webhook(request: Request):
    raw = await request.body()
    if not xrocket.verify(request.headers, raw):
        return JSONResponse({"error": "bad_signature"}, status_code=401)
    try:
        event = json.loads(raw)
        invoice = (event.get("data") or {}).get("invoice") or {}
        client_id = invoice.get("clientInvoiceId") or ""
    except (ValueError, AttributeError):
        return JSONResponse({"ok": True})
    if event.get("type") == "invoice" and client_id.startswith("aud-") and client_id[4:].isdigit():
        try:
            # reconcile asks xRocket's API: off the event loop.
            await run_in_threadpool(reconcile, int(client_id[4:]))
        except xrocket.Error as e:   # answered 200 anyway: the app's question settles it later
            log.warning("xrocket notification %s: %s", event.get("id"), e)
    return {"ok": True}
