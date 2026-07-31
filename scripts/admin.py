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


def main():
    p = argparse.ArgumentParser(description="Управление аккаунтами Audiator")
    sub = p.add_subparsers(dest="cmd", required=True)

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
