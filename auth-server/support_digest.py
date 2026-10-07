# -*- coding: utf-8 -*-
"""Digests of the messages to support, instead of a letter each (user's
decision 2026-10-07).

Run every hour (systemd timer audiator-digest, deploy/setup-server.sh):
    python support_digest.py          # by the rules below
    python support_digest.py --now    # whatever is new, right away

One letter to the support inbox goes out when DIGEST_THRESHOLD (10) messages
have come in since the last one — however long that took — and every morning at
DIGEST_HOUR_UTC (5 = 09:00 GMT+4) with what came in since and the open messages
whose answer time is near (24 h) or past. Nothing new and nothing due: no letter.
A message goes into one digest only (mailed); a digest that fails to send is
tried again the next hour.

Each message: number, topic, who, plan, answer time, the start of the text, a
"Reply" link that opens a letter to the client, and the command for the rest
(the full text and marking it answered: audiator-admin on the server).
"""
import argparse
import html
import os
import sys
from datetime import timedelta
from typing import Optional
from urllib.parse import quote

import clients
import mailer
from accounts_db import Session, SupportTicket, User, _utcnow
from support import CATEGORIES

THRESHOLD = int(os.environ.get("DIGEST_THRESHOLD", "10"))
HOUR_UTC = int(os.environ.get("DIGEST_HOUR_UTC", "5"))
SOON = timedelta(hours=24)
EXCERPT = 300


def _due(t, now) -> str:
    if t.due_at is None:
        return "без срока"
    if t.due_at < now:
        return f"ПРОСРОЧЕНО (было до {t.due_at:%d.%m %H:%M} UTC)"
    return f"ответить до {t.due_at:%d.%m %H:%M} UTC"


def _excerpt(text: str) -> str:
    text = " ".join(text.split())
    return text if len(text) <= EXCERPT else text[:EXCERPT].rstrip() + "…"


def _reply_link(t, email: str) -> str:
    return f"mailto:{email}?subject={quote(f'Re: Audiator #{t.id}')}"


def _entry(t, email: str, now):
    head = f"#{t.id} · {CATEGORIES.get(t.category, t.category)} · {email} · {clients.PLAN_RU.get(t.plan, t.plan)} · {_due(t, now)}"
    app = f"Программа: {t.app_version or '—'}, {t.os or '—'}"
    text = "\n".join([head, f"  {_excerpt(t.text)}", f"  {app}", f"  Ответить: {_reply_link(t, email)}"])
    page = (f"<p><b>{html.escape(head)}</b><br>{html.escape(_excerpt(t.text))}<br>"
            f"<small>{html.escape(app)}</small><br>"
            f'<a href="{html.escape(_reply_link(t, email))}">Ответить</a></p>')
    return text, page


def compose(new, due, now, morning: bool):
    """(subject, text, html) for the new messages and, in the morning, the open
    ones that are due soon or overdue. new/due: [(ticket, email)]."""
    if morning:
        subject = f"Audiator: утренняя сводка — новых {len(new)}"
        if due:
            subject += f", срок подходит или прошёл {len(due)}"
    else:
        subject = f"Audiator: новых обращений {len(new)}"
    text, page = [], []
    for title, rows in (("Новые", new), ("Срок подходит или прошёл", due)):
        if not rows:
            continue
        text.append(f"{title} ({len(rows)}):\n")
        page.append(f"<h3>{html.escape(title)} ({len(rows)})</h3>")
        for t, email in rows:
            e_text, e_page = _entry(t, email, now)
            text.append(e_text + "\n")
            page.append(e_page)
    hint = ("Полностью: ssh audiator audiator-admin ticket N · все открытые: ssh audiator audiator-admin tickets · "
            "отвечено: ssh audiator audiator-admin ticket N answered")
    text.append(hint)
    page.append(f"<p><small>{html.escape(hint)}</small></p>")
    return subject, "\n".join(text), "\n".join(page)


def run(now=None, force: bool = False) -> Optional[str]:
    """Send a digest if one is due; returns its subject, or None."""
    now = now or _utcnow()
    T = SupportTicket
    with Session() as s:
        new = (s.query(T, User.email).join(User, T.user_id == User.id)
               .filter(T.mailed.is_(False)).order_by(T.id).all())
        morning = now.hour == HOUR_UTC
        if not (force or morning or len(new) >= THRESHOLD):
            return None
        due = []
        if morning:
            due = (s.query(T, User.email).join(User, T.user_id == User.id)
                   .filter(T.mailed.is_(True), T.status == "new", T.due_at.isnot(None), T.due_at <= now + SOON)
                   .order_by(T.due_at).all())
        if not new and not due:
            return None
        subject, text, page = compose(new, due, now, morning)
        mailer.send(mailer.support_inbox(), subject, text, html=page)
        for t, _ in new:
            t.mailed = True
        s.commit()
        return subject


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Digest of the messages to support")
    p.add_argument("--now", action="store_true", help="send whatever is new right away")
    args = p.parse_args(argv)
    try:
        subject = run(force=args.now)
    except Exception as e:  # noqa: BLE001 — the timer's log shows it; tried again next hour
        print(f"digest not sent: {e}", file=sys.stderr, flush=True)
        return 1
    print(subject or "no digest due", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
