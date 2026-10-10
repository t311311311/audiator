# -*- coding: utf-8 -*-
"""xRocket Pay (https://docs.xrocket.exchange/api/pay/pay-api-overview): invoices
paid inside Telegram from the payer's xRocket wallet (owner's decision
2026-10-09: the main way to pay; xRocket's 1.5% on incoming payments is ours,
the buyer pays the price and no more).

  XROCKET_TOKEN          the app's Bearer token (bot: Pay API → app → Settings)
  XROCKET_WEBHOOK_TOKEN  the app's webhook secret (signs the notifications)
  XROCKET_API            default https://pay.api.xrocket.exchange
                         (testnet: https://pay.api.testnet.xrocket.exchange)

Notifications are only a hint that something changed: what an invoice is and
what was received is always read back from the API (payments.reconcile), so a
notification cannot credit anything by itself.
"""
import contextvars
import hashlib
import hmac
import os
import time
from contextlib import contextmanager

import httpx

TOLERANCE_MS = 5 * 60 * 1000   # replay protection, as the docs recommend
_timeout = contextvars.ContextVar("xrocket_timeout", default=20.0)   # seconds to wait for the API


@contextmanager
def patience(seconds: float):
    """Calls inside wait for the API no longer than this: for asking on the
    way to another answer (the profile), where 20 seconds would be felt."""
    token = _timeout.set(seconds)
    try:
        yield
    finally:
        _timeout.reset(token)


def _api() -> str:
    return os.environ.get("XROCKET_API", "https://pay.api.xrocket.exchange").rstrip("/")


def _headers() -> dict:
    return {"Authorization": f"Bearer {os.environ.get('XROCKET_TOKEN', '')}", "Accept": "application/json"}


def configured() -> bool:
    return bool(os.environ.get("XROCKET_TOKEN"))


class Error(Exception):
    """The API refused or could not be reached."""


class NotFound(Error):
    """xRocket does not know the invoice: a cancelled one is forgotten
    altogether (seen on the real API 2026-10-10: 404 "Invoice not found" —
    not the "cancelled" status the docs speak of)."""


def _call(method: str, path: str, **kw) -> dict:
    try:
        r = httpx.request(method, _api() + path, headers=_headers(), timeout=_timeout.get(), **kw)
    except httpx.HTTPError as e:
        raise Error(f"{method} {path}: {e}") from e
    if r.status_code == 404:
        raise NotFound(f"{method} {path}: 404 {r.text[:200]}")
    if r.status_code >= 400:
        raise Error(f"{method} {path}: {r.status_code} {r.text[:200]}")
    return r.json() if r.content else {}


def create_invoice(amount: float, client_id: str, description: str, callback_url: str = "",
                   expires_ms: int = 30 * 60 * 1000) -> dict:
    """A USDT invoice for amount; xRocket's fee comes out of what we receive.
    Returns the invoice: id, status, expiresAt, links.telegramBotLink."""
    body = {"priceAmount": f"{amount:g}", "priceCurrency": "USDT", "payCurrencies": ["USDT"],
            "clientInvoiceId": client_id, "description": description[:1000], "expiresIn": expires_ms,
            "isFeePaidByUser": False, "callback": {"payload": {"client": client_id}}}
    if callback_url:
        body["callback"]["callbackUrl"] = callback_url
    return _call("POST", "/api/v1/invoices", json=body)


def get_invoice(invoice_id: str) -> dict:
    return _call("GET", "/api/v1/invoice", params={"invoiceId": invoice_id})


def delete_invoice(invoice_id: str) -> dict:
    """Cancel an invoice: it can no longer be paid. xRocket then forgets it
    (get_invoice -> NotFound)."""
    return _call("DELETE", "/api/v1/invoice", params={"invoiceId": invoice_id})


def paid(invoice_id: str) -> float:
    """What the buyer paid for the invoice — before xRocket's fee, which is
    ours: the sum of its finished payments (finalizedAt set — the docs' test
    for finality)."""
    total, cursor = 0.0, None
    for _ in range(20):
        params = {"invoiceId": invoice_id, "limit": 100}
        if cursor:
            params["cursor"] = cursor
        page = _call("GET", "/api/v1/invoice/payments", params=params)
        for p in page.get("items", []):
            if p.get("finalizedAt") and p.get("status") == "paid":
                total += float(p.get("payAmount") or 0)
        cursor = (page.get("pagination") or {}).get("next")
        if not cursor:
            break
    return round(total, 6)


def verify(headers, raw: bytes, now_ms: int = None) -> bool:
    """A notification really from xRocket and fresh: HMAC-SHA256 with the
    webhook secret over "{Signature-Timestamp}.{raw body}", scheme v1."""
    secret = os.environ.get("XROCKET_WEBHOOK_TOKEN", "")
    signature, version, stamp = (headers.get("Signature"), headers.get("Signature-Version"),
                                 headers.get("Signature-Timestamp"))
    if not (secret and signature and version and stamp) or version != "v1":
        return False
    try:
        if abs((now_ms if now_ms is not None else time.time() * 1000) - int(stamp)) > TOLERANCE_MS:
            return False
    except ValueError:
        return False
    expected = hmac.new(secret.encode(), f"{stamp}.".encode() + raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature.strip().lower())
