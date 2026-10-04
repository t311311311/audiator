# -*- coding: utf-8 -*-
"""What kind of client someone is: how they use the app, what they paid,
what they wrote to support — for the owner, in Russian.

Used by the support letters (support.py: every message comes with the
client's card) and by the admin command line (scripts/admin.py client
<email>). The web admin of step 6 will show the same.
"""
from datetime import timedelta

from sqlalchemy import func

from accounts_db import Device, Payment, SupportTicket, Usage, User, _utcnow

PLAN_RU = {"free": "бесплатный", "commercial": "платный", "unlimited": "безлимит", "admin": "админ"}


def plan_of(u: User) -> str:
    if u.role == "admin":
        return "admin"
    if u.unlimited:
        return "unlimited"
    if u.paid_until and u.paid_until > _utcnow():
        return "commercial"
    return "free"


def stats(s, u: User) -> dict:
    """Usage by the user's own days (the usage table), payments, tickets."""
    now = _utcnow()
    today = now.date()
    days = dict(s.query(Usage.day, func.sum(Usage.seconds)).filter(Usage.user_id == u.id).group_by(Usage.day).all())

    def seconds_since(n):
        first = (today - timedelta(days=n - 1)).isoformat()
        return sum(v for d, v in days.items() if d >= first)

    first30 = (today - timedelta(days=29)).isoformat()
    active30 = sum(1 for d, v in days.items() if d >= first30 and v > 0)
    computers = s.query(func.count(func.distinct(Usage.device_hash))).filter(Usage.user_id == u.id).scalar() or 0
    computers = max(computers, s.query(Device).filter(Device.free_user_id == u.id).count())
    paid = s.query(func.coalesce(func.sum(Payment.amount), 0)).filter(
        Payment.user_id == u.id, Payment.status == "paid").scalar() or 0
    tickets = s.query(SupportTicket).filter(SupportTicket.user_id == u.id).count()
    open_tickets = s.query(SupportTicket).filter(SupportTicket.user_id == u.id,
                                                 SupportTicket.status == "new").count()
    return {
        "seconds_7": seconds_since(7),
        "seconds_30": seconds_since(30),
        "seconds_total": sum(days.values()),
        "active_days_30": active30,
        "active_days_total": sum(1 for v in days.values() if v > 0),
        "last_used_day": max((d for d, v in days.items() if v > 0), default=None),
        "computers": computers,
        "paid_total": float(paid),
        "tickets": tickets,
        "open_tickets": open_tickets,
        "age_days": (now - u.created_at).days if u.created_at else 0,
    }


def kind(u: User, st: dict) -> str:
    """новый / постоянный / периодический / редкий / спящий — by the last 30 days."""
    if st["age_days"] < 7:
        return "новый"
    if st["active_days_30"] >= 15:
        return "постоянный"
    if st["active_days_30"] >= 4:
        return "периодический"
    if st["active_days_30"] >= 1:
        return "редкий"
    return "спящий"


def _minutes(seconds) -> str:
    m = int(seconds) // 60
    return f"{m // 60} ч {m % 60} мин" if m >= 60 else f"{m} мин"


def card(s, u: User) -> str:
    """The client in a few lines, in Russian."""
    st = stats(s, u)
    plan = plan_of(u)
    lines = [
        f"Клиент: {u.email} — {kind(u, st)}, {PLAN_RU.get(plan, plan)}"
        + (" (заблокирован)" if u.status == "blocked" else ""),
        f"Зарегистрирован: {u.created_at:%Y-%m-%d} ({st['age_days']} дн. назад); "
        f"последний вход: {u.last_login_at:%Y-%m-%d %H:%M} UTC" if u.last_login_at else
        f"Зарегистрирован: {u.created_at:%Y-%m-%d}; входа не было",
        f"Распознавание: за 7 дней {_minutes(st['seconds_7'])}, за 30 дней {_minutes(st['seconds_30'])}, "
        f"всего {_minutes(st['seconds_total'])}; активных дней из последних 30: {st['active_days_30']}"
        + (f"; последний раз {st['last_used_day']}" if st["last_used_day"] else ""),
        f"Оплачено всего: {st['paid_total']:g} USDT"
        + (f"; оплачено до {u.paid_until:%Y-%m-%d}" if u.paid_until else ""),
        f"Компьютеров: {st['computers']}; обращений: {st['tickets']} (без ответа: {st['open_tickets']})",
        f"Правила приняты: {u.terms_version or '—'}",
    ]
    return "\n".join(lines)
