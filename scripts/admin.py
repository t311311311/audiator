# -*- coding: utf-8 -*-
"""Admin CLI for Audiator accounts (testing aid).

Creates test accounts, changes access tiers and switches the desktop app between
accounts on this machine, so the whole flow can be exercised without payments.

Run with the venv python from the repo root:
  .venv\\Scripts\\python.exe scripts\\admin.py list
  .venv\\Scripts\\python.exe scripts\\admin.py create "Test 1"
  .venv\\Scripts\\python.exe scripts\\admin.py create "Boss" --role admin
  .venv\\Scripts\\python.exe scripts\\admin.py role <device_id> admin
  .venv\\Scripts\\python.exe scripts\\admin.py use <device_id>     # app runs as this account
  .venv\\Scripts\\python.exe scripts\\admin.py whoami

Tiers: admin = unlimited; paid = subscriber allowance; free = the daily gift.

Accounts by email (step 4, accounts.db):
  .venv\\Scripts\\python.exe scripts\\admin.py accounts                    # list them
  .venv\\Scripts\\python.exe scripts\\admin.py unlimited friend@mail.ru on # lifetime unlimited
  .venv\\Scripts\\python.exe scripts\\admin.py block someone@mail.ru on
  .venv\\Scripts\\python.exe scripts\\admin.py paid client@firm.com 30     # commercial for 30 days

Clients and support (the same card support letters carry):
  .venv\\Scripts\\python.exe scripts\\admin.py client ivan@mail.ru         # who the client is
  .venv\\Scripts\\python.exe scripts\\admin.py tickets [--all]             # messages to support
  .venv\\Scripts\\python.exe scripts\\admin.py ticket 17                   # the whole message
  .venv\\Scripts\\python.exe scripts\\admin.py ticket 17 answered
On the server the same as: ssh audiator audiator-admin tickets (deploy/setup-server.sh).
"""
import argparse
import hashlib
import json
import os
import secrets
import sys
import time
from datetime import datetime, timedelta

# Run from anywhere: make auth-server importable and load its .env.
HERE = os.path.dirname(os.path.abspath(__file__))
AUTH_DIR = os.path.join(os.path.dirname(HERE), "auth-server")
sys.path.insert(0, AUTH_DIR)
os.chdir(AUTH_DIR)  # db.py defaults to a SQLite file relative to the cwd

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(AUTH_DIR, ".env"))
except ImportError:
    pass

import db  # noqa: E402

ROLES = ("free", "paid", "admin")
TOKEN_PATH = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")),
                          "audiator", "token.json")


def _secret() -> str:
    key = os.environ.get("AUDIATOR_SECRET_KEY")
    if not key:
        sys.exit("AUDIATOR_SECRET_KEY is not set (auth-server/.env)")
    return key


def make_token(device_id: str, days: int = 365) -> str:
    """Same scheme the server verifies: device_id.expiry.signature."""
    exp = int(time.time()) + days * 86400
    sig = hashlib.sha256(f"{device_id}{_secret()}{exp}".encode()).hexdigest()[:16]
    return f"{device_id}.{exp}.{sig}"


def cmd_list(args):
    users = db.list_users()
    if not users:
        print("Аккаунтов нет. Создайте: admin.py create \"Имя\"")
        return
    cur = _current_device_id()
    print(f"{'':2}{'device_id':18} {'роль':6} {'имя':22} {'сегодня':>9}  подписка")
    for u in users:
        used = db.usage_today(u["device_id"])
        sub = u["subscription_end"].date() if u["subscription_end"] else "-"
        mark = "*" if u["device_id"] == cur else " "
        print(f"{mark} {u['device_id']:18} {u['role']:6} {(u['device_name'] or '')[:22]:22} "
              f"{used // 60:>4} мин  {sub}")
    print("\n* — аккаунт, под которым сейчас работает приложение")


def cmd_create(args):
    device_id = secrets.token_hex(8)  # same shape as the client's device ids
    fields = dict(device_name=args.name, created_at=datetime.now(),
                  is_trial=False, role=args.role)
    if args.role == "paid":
        fields["subscription_end"] = datetime.now() + timedelta(days=args.days)
    db.upsert_user(device_id, **fields)
    print(f"Создан аккаунт: {args.name}")
    print(f"  device_id: {device_id}")
    print(f"  роль:      {args.role}")
    print(f"  токен:     {make_token(device_id)}")
    print(f"\nПереключить приложение на него: admin.py use {device_id}")


def cmd_role(args):
    if not db.get_user(args.device_id):
        sys.exit(f"Аккаунт {args.device_id} не найден")
    db.upsert_user(args.device_id, role=args.role)
    print(f"{args.device_id}: роль -> {args.role}")


def cmd_use(args):
    if not db.get_user(args.device_id):
        sys.exit(f"Аккаунт {args.device_id} не найден")
    os.makedirs(os.path.dirname(TOKEN_PATH), exist_ok=True)
    with open(TOKEN_PATH, "w", encoding="utf-8") as f:
        json.dump({"token": make_token(args.device_id),
                   "savedAt": datetime.now().isoformat()}, f)
    # The client derives its own device id from hardware; pin it to this account.
    with open(os.path.join(os.path.dirname(TOKEN_PATH), "device.json"), "w", encoding="utf-8") as f:
        json.dump({"device_id": args.device_id,
                   "createdAt": datetime.now().isoformat()}, f)
    print(f"Приложение теперь работает как {args.device_id}. Перезапустите его.")


def cmd_whoami(args):
    dev = _current_device_id()
    if not dev:
        print("Токен не найден — приложение не авторизовано.")
        return
    u = db.get_user(dev)
    if not u:
        print(f"device_id {dev} (нет такой записи в базе)")
        return
    used = db.usage_today(dev)
    print(f"device_id: {dev}\nимя:       {u['device_name']}\nроль:      {u['role']}\n"
          f"сегодня:   {used // 60} мин\nподписка:  {u['subscription_end'] or '-'}")


def _current_device_id():
    try:
        with open(TOKEN_PATH, encoding="utf-8") as f:
            return json.load(f)["token"].split(".")[0]
    except Exception:
        return None


# --- Accounts by email (step 4): accounts.db ------------------------------------

def _account(session, email):
    import accounts_db
    u = session.query(accounts_db.User).filter(accounts_db.User.email == email.strip().lower()).one_or_none()
    if u is None:
        sys.exit(f"нет аккаунта {email} (он появляется при первом входе в приложение)")
    return u


def cmd_accounts(args):
    import accounts_db
    from sqlalchemy import func
    with accounts_db.Session() as s:
        rows = s.query(accounts_db.User).order_by(accounts_db.User.created_at).all()
        devices = dict(s.query(accounts_db.Device.free_user_id, func.count()).group_by(
            accounts_db.Device.free_user_id).all())
    if not rows:
        print("аккаунтов пока нет")
        return
    print(f"{'email':34} {'роль':6} {'безлимит':9} {'оплачено до':12} {'статус':8} ПК  последний вход")
    for u in rows:
        paid = u.paid_until.strftime("%Y-%m-%d") if u.paid_until else "-"
        last = u.last_login_at.strftime("%Y-%m-%d %H:%M") if u.last_login_at else "-"
        print(f"{u.email:34} {u.role:6} {'да' if u.unlimited else 'нет':9} {paid:12} {u.status:8} "
              f"{devices.get(u.id, 0):<3} {last}")


def cmd_unlimited(args):
    import accounts_db
    with accounts_db.Session() as s:
        u = _account(s, args.email)
        u.unlimited = args.state == "on"
        s.commit()
    print(f"{args.email}: безлимит навсегда {'включён' if args.state == 'on' else 'выключен'}")


def cmd_block(args):
    import accounts_db
    with accounts_db.Session() as s:
        u = _account(s, args.email)
        u.status = "blocked" if args.state == "on" else "active"
        s.commit()
    print(f"{args.email}: {'заблокирован' if args.state == 'on' else 'разблокирован'}")


def cmd_paid(args):
    import accounts_db
    with accounts_db.Session() as s:
        u = _account(s, args.email)
        u.paid_until = accounts_db._utcnow() + timedelta(days=args.days) if args.days > 0 else None
        s.commit()
    print(f"{args.email}: коммерческий тариф {'до ' + u.paid_until.strftime('%Y-%m-%d') if u.paid_until else 'снят'}")


def cmd_client(args):
    """Who the client is: usage, payments, messages — the card support letters carry."""
    import accounts_db
    import clients
    with accounts_db.Session() as s:
        u = _account(s, args.email)
        print(clients.card(s, u))
        tickets = s.query(accounts_db.SupportTicket).filter(accounts_db.SupportTicket.user_id == u.id).order_by(
            accounts_db.SupportTicket.created_at.desc()).limit(10).all()
        if tickets:
            print("\nОбращения:")
            for t in tickets:
                print(f"  #{t.id} {t.created_at:%Y-%m-%d} {t.category:12} {t.status:9} {t.text[:60]!r}")


def cmd_tickets(args):
    """Messages to support, the unanswered first by how soon they are due."""
    import accounts_db
    T = accounts_db.SupportTicket
    now = accounts_db._utcnow()
    with accounts_db.Session() as s:
        q = s.query(T, accounts_db.User.email).join(accounts_db.User, T.user_id == accounts_db.User.id)
        if not args.all:
            q = q.filter(T.status == "new")
        rows = q.order_by(T.status != "new", T.due_at.is_(None), T.due_at, T.created_at).all()
    if not rows:
        print("обращений нет" if args.all else "неотвеченных обращений нет")
        return
    for t, email in rows:
        if t.due_at is None:
            due = "без срока"
        elif t.status == "new" and t.due_at < now:
            due = f"ПРОСРОЧЕНО ({t.due_at:%d.%m %H:%M})"
        else:
            due = f"до {t.due_at:%d.%m %H:%M}"
        mail = "" if t.mailed else "  [ещё не было в сводке]"
        print(f"#{t.id:<4} {t.status:9} {t.category:12} {email:30} {due:26} {t.text[:50]!r}{mail}")


def cmd_ticket(args):
    """The whole message and who wrote it; with a status — mark it."""
    import accounts_db
    import clients
    with accounts_db.Session() as s:
        t = s.get(accounts_db.SupportTicket, args.id)
        if t is None:
            sys.exit(f"нет обращения #{args.id}")
        if args.status:
            t.status = args.status
            s.commit()
            print(f"#{args.id}: {args.status}")
            return
        u = s.get(accounts_db.User, t.user_id)
        due = f"до {t.due_at:%d.%m %H:%M} UTC" if t.due_at else "без срока"
        print(f"#{t.id} · {t.category} · {t.status} · {u.email} · {t.created_at:%Y-%m-%d %H:%M} UTC · ответить {due}")
        print(f"Программа: {t.app_version or '—'}, {t.os or '—'}\n")
        print(t.text)
        print("\n" + "— " * 20)
        print(clients.card(s, u))


def cmd_left(args):
    """For testing the free limit: leave N minutes in the account's current
    24 hours (started now if none are running), or 'reset' — none running,
    all 2 hours back. Prints what was there, to put it back."""
    import accounts
    import accounts_db
    with accounts_db.Session() as s:
        u = _account(s, args.email)
        print(f"было: window_start={u.window_start} window_used={u.window_used}")
        now = accounts_db._utcnow()
        if args.minutes == "reset":
            u.window_start, u.window_used = None, 0
        else:
            if not (u.window_start and now < u.window_start + accounts.WINDOW):
                u.window_start = now
            u.window_used = max(0, accounts.FREE_DAILY_SECONDS - int(float(args.minutes) * 60))
        s.commit()
        print(f"стало: window_start={u.window_start} window_used={u.window_used}"
              " — приложение увидит, когда откроете его окно, или после перезапуска")


def cmd_spend(args):
    """For testing: take N minutes off what is left in the account's current
    24 hours (started now if none are running)."""
    import accounts
    import accounts_db
    with accounts_db.Session() as s:
        u = _account(s, args.email)
        now = accounts_db._utcnow()
        if not (u.window_start and now < u.window_start + accounts.WINDOW):
            u.window_start, u.window_used = now, 0
        before = max(0, accounts.FREE_DAILY_SECONDS - (u.window_used or 0))
        u.window_used = min(accounts.FREE_DAILY_SECONDS, (u.window_used or 0) + int(args.minutes * 60))
        s.commit()
        after = max(0, accounts.FREE_DAILY_SECONDS - u.window_used)
        print(f"было осталось {before // 60} мин {before % 60} с -> стало {after // 60} мин {after % 60} с "
              "(приложение увидит, когда откроете его окно, или после перезапуска)")


def cmd_renew(args):
    """For testing the renewal: the account's 24 hours end in N minutes, with
    M minutes left in them until then (default: none left)."""
    import accounts
    import accounts_db
    with accounts_db.Session() as s:
        u = _account(s, args.email)
        print(f"было: window_start={u.window_start} window_used={u.window_used}")
        u.window_start = accounts_db._utcnow() - accounts.WINDOW + timedelta(minutes=args.minutes)
        u.window_used = max(0, accounts.FREE_DAILY_SECONDS - int(args.left * 60))
        s.commit()
        print(f"стало: осталось {args.left:g} мин, обновление через {args.minutes:g} мин "
              "(приложение увидит, когда откроете его окно, или после перезапуска)")


def cmd_window_set(args):
    """Put the 24 hours back exactly as they were (the values `left` printed)."""
    import accounts_db
    from datetime import datetime as dt
    with accounts_db.Session() as s:
        u = _account(s, args.email)
        u.window_start = None if args.start == "none" else dt.fromisoformat(args.start)
        u.window_used = args.used
        s.commit()
    print(f"{args.email}: window_start={u.window_start} window_used={u.window_used}")


def main():
    p = argparse.ArgumentParser(description="Управление аккаунтами Audiator")
    sub = p.add_subparsers(dest="cmd", required=True)

    # Clients and their messages to support.
    cl = sub.add_parser("client", help="карточка клиента: использование, оплаты, обращения")
    cl.add_argument("email")
    cl.set_defaults(func=cmd_client)
    tk = sub.add_parser("tickets", help="обращения в поддержку (по умолчанию — без ответа)")
    tk.add_argument("--all", action="store_true", help="все, включая отвеченные")
    tk.set_defaults(func=cmd_tickets)
    t1 = sub.add_parser("ticket", help="обращение целиком; со статусом — отметить")
    t1.add_argument("id", type=int)
    t1.add_argument("status", nargs="?", choices=("answered", "closed", "new"))
    t1.set_defaults(func=cmd_ticket)

    # Accounts by email (step 4).
    sub.add_parser("accounts", help="аккаунты по email").set_defaults(func=cmd_accounts)
    un = sub.add_parser("unlimited", help="безлимит навсегда: on / off")
    un.add_argument("email")
    un.add_argument("state", choices=("on", "off"))
    un.set_defaults(func=cmd_unlimited)
    bl = sub.add_parser("block", help="заблокировать: on / off")
    bl.add_argument("email")
    bl.add_argument("state", choices=("on", "off"))
    bl.set_defaults(func=cmd_block)
    pd = sub.add_parser("paid", help="коммерческий тариф на N дней (0 — снять)")
    pd.add_argument("email")
    pd.add_argument("days", type=int)
    pd.set_defaults(func=cmd_paid)
    lf = sub.add_parser("left", help="тест лимита: оставить N минут в текущих 24 часах, или reset")
    lf.add_argument("email")
    lf.add_argument("minutes", help="минут осталось (например 5) или reset")
    lf.set_defaults(func=cmd_left)
    sp = sub.add_parser("spend", help="тест лимита: списать N минут из оставшихся")
    sp.add_argument("email")
    sp.add_argument("minutes", type=float)
    sp.set_defaults(func=cmd_spend)
    rn = sub.add_parser("renew", help="тест обновления: 24 часа кончаются через N минут")
    rn.add_argument("email")
    rn.add_argument("minutes", type=float, help="через сколько минут обновление")
    rn.add_argument("--left", type=float, default=0, help="сколько минут осталось до тех пор (по умолчанию 0)")
    rn.set_defaults(func=cmd_renew)
    ws = sub.add_parser("window", help="вернуть 24 часа как были: <email> <start|none> <used>")
    ws.add_argument("email")
    ws.add_argument("start", help="window_start как напечатал left, или none")
    ws.add_argument("used", type=int)
    ws.set_defaults(func=cmd_window_set)

    # The old device-based accounts (until the app has switched over).
    sub.add_parser("list", help="список аккаунтов").set_defaults(func=cmd_list)

    c = sub.add_parser("create", help="создать аккаунт")
    c.add_argument("name")
    c.add_argument("--role", choices=ROLES, default="free")
    c.add_argument("--days", type=int, default=365, help="срок подписки для роли paid")
    c.set_defaults(func=cmd_create)

    r = sub.add_parser("role", help="сменить роль")
    r.add_argument("device_id")
    r.add_argument("role", choices=ROLES)
    r.set_defaults(func=cmd_role)

    u = sub.add_parser("use", help="переключить приложение на аккаунт")
    u.add_argument("device_id")
    u.set_defaults(func=cmd_use)

    sub.add_parser("whoami", help="под кем работает приложение").set_defaults(func=cmd_whoami)

    args = p.parse_args()
    db.init_db()
    import accounts_db  # the email accounts: tables and new columns made as the server does
    accounts_db.init_accounts_db()
    args.func(args)


if __name__ == "__main__":
    main()
