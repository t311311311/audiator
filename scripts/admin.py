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
              " — приложение увидит после перезапуска или после следующей записи")


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
    args.func(args)


if __name__ == "__main__":
    main()
