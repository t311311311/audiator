# -*- coding: utf-8 -*-
"""Messages to support from the app ("Написать нам").

The user picks a topic and writes; the message is kept (support_tickets) and
mailed to the support inbox. The subject says the topic, the number, who
wrote, their plan and by when to answer — so the inbox sorts itself — and
the letter carries the client's card (clients.py). "Reply" in the mail
program answers the user directly.

Answer times are the ones in the rules (src/terms.html, section 6):
payments 48 hours; everything else 5 days, whatever the plan; ideas — no
promise. Plain days, not working days: whose holidays would count, with
users all over the world (user's decision 2026-10-06).
"""
import logging
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Header
from pydantic import BaseModel

import clients
import mailer
import rate
from accounts import _auth, _err, _iso, _utcnow
from accounts_db import Session, SupportTicket, User

router = APIRouter(prefix="/api/v2")
log = logging.getLogger("audiator")

# Topic -> how the owner sees it in the inbox. Recognition and translation
# are third-party components, provided as they are (the rules name them), so
# they have no topic of their own (user's decision 2026-10-04).
CATEGORIES = {
    "payment": "Оплата",
    "bug": "Баг",
    "account": "Аккаунт",
    "idea": "Предложение",
}
MAX_TEXT = 5000
PER_HOUR = 5


def answer_within(category: str) -> Optional[str]:
    """48h | 5d | None (ideas: read, no promise)."""
    if category == "idea":
        return None
    if category == "payment":
        return "48h"
    return "5d"


def _due(within: Optional[str], now):
    return {"48h": now + timedelta(hours=48), "5d": now + timedelta(days=5)}.get(within)


class SupportRequest(BaseModel):
    category: str
    text: str
    app_version: Optional[str] = None
    os: Optional[str] = None


@router.post("/support")
def write_to_support(req: SupportRequest, authorization: Optional[str] = Header(None)):
    u, _device = _auth(authorization)
    if req.category not in CATEGORIES:
        raise _err(400, "bad_category")
    text = (req.text or "").strip()
    if not text:
        raise _err(400, "empty_text")
    if len(text) > MAX_TEXT:
        raise _err(400, "too_long", max=MAX_TEXT)
    ok, retry = rate.check(f"support:{u.id}", PER_HOUR, 3600)
    if not ok:
        raise _err(429, "too_many_requests", retry_after=retry)

    now = _utcnow()
    with Session() as s:
        user = s.get(User, u.id)
        plan = clients.plan_of(user)
        within = answer_within(req.category)
        t = SupportTicket(user_id=user.id, category=req.category, text=text, plan=plan,
                          app_version=(req.app_version or "")[:40] or None, os=(req.os or "")[:80] or None,
                          created_at=now, due_at=_due(within, now), status="new", mailed=False)
        s.add(t)
        s.flush()
        due = f"ответить до {t.due_at:%d.%m %H:%M} UTC" if t.due_at else "без срока"
        subject = (f"[{CATEGORIES[t.category]}] #{t.id} · {user.email} · "
                   f"{clients.PLAN_RU.get(plan, plan)} · {due}")
        body = "\n".join([
            f"Обращение #{t.id} — {CATEGORIES[t.category]}",
            f"От: {user.email}",
            f"Срок ответа: {due}",
            f"Программа: {t.app_version or '—'}, {t.os or '—'}",
            "",
            text,
            "",
            "— " * 20,
            clients.card(s, user),
            "",
            "Ответ: кнопка «Ответить» в почте — письмо уйдёт клиенту.",
            f"Отметить отвеченным: python scripts\\admin.py ticket {t.id} answered",
        ])
        s.commit()
        ticket_id, due_at = t.id, t.due_at
        try:
            mailer.send(mailer.support_inbox(), subject, body, reply_to=user.email)
            t.mailed = True
            s.commit()
        except Exception as e:  # noqa: BLE001 — kept anyway; the admin lists show it
            log.warning("support #%s not mailed: %s", ticket_id, e)
    return {"id": ticket_id, "answer_within": within, "due_at": _iso(due_at), "reply_to": u.email}
