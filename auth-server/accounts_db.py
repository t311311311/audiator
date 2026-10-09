# -*- coding: utf-8 -*-
"""The accounting database: who the users are, which computers they use, how
many minutes they have used, and what they paid (docs/PRODUCT-PLAN.md, step 4).

Four tables, as agreed with the user:
  users     the people (by email), their plan and the sign-in code in flight
  devices   computers, by a hash of the Windows MachineGuid (never the raw id),
            and the one free account each computer may have
  usage     seconds of speech recognised, per user, computer and local day
  payments  what was paid (USDT, step 5)

A separate database from the old device-based one in db.py, which goes away
once the app has switched to these accounts. ACCOUNTS_DATABASE_URL picks it
(tests point it at a temporary file).
"""
import os
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import (Boolean, DateTime, Float, ForeignKey, Integer, String,
                        UniqueConstraint, create_engine)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

ACCOUNTS_DATABASE_URL = os.environ.get("ACCOUNTS_DATABASE_URL", "sqlite:///accounts.db")

_connect_args = {"check_same_thread": False} if ACCOUNTS_DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(ACCOUNTS_DATABASE_URL, connect_args=_connect_args, future=True)
Session = sessionmaker(bind=engine, expire_on_commit=False, future=True)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String, unique=True, index=True)   # lower-case
    email_domain: Mapped[str] = mapped_column(String, index=True)        # for looking at organisations later
    email_verified: Mapped[bool] = mapped_column(Boolean, default=False)  # a code from that mailbox was entered
    google_id: Mapped[Optional[str]] = mapped_column(String, nullable=True, unique=True)
    role: Mapped[str] = mapped_column(String, default="user")             # user | admin
    # Lifetime unlimited use, granted by hand (the owner, friends, testers).
    unlimited: Mapped[bool] = mapped_column(Boolean, default=False)
    paid_until: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)  # commercial plan
    # USDT paid and not yet spent on a period (billing.py): it pays the next one.
    balance: Mapped[float] = mapped_column(Float, default=0.0)
    status: Mapped[str] = mapped_column(String, default="active")         # active | blocked
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    last_login_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # The sign-in code in flight: only its hash is kept.
    code_hash: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    code_expires: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    code_attempts: Mapped[int] = mapped_column(Integer, default=0)
    # The free plan's 24 hours: each account's own, from its first use after
    # the last ones ran out (not a calendar day).
    window_start: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    window_used: Mapped[int] = mapped_column(Integer, default=0)       # seconds in that window
    # Which version of the rules the user accepted at sign-in, and when.
    terms_version: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    terms_accepted_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    device_hash: Mapped[str] = mapped_column(String, unique=True, index=True)
    # The free account this computer belongs to: one per computer.
    free_user_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"), nullable=True)
    first_seen: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    last_seen: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class Usage(Base):
    __tablename__ = "usage"
    __table_args__ = (UniqueConstraint("user_id", "device_hash", "day"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    device_hash: Mapped[str] = mapped_column(String, index=True)
    day: Mapped[str] = mapped_column(String, index=True)   # YYYY-MM-DD, the user's local day
    seconds: Mapped[int] = mapped_column(Integer, default=0)


class Payment(Base):
    __tablename__ = "payments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    amount: Mapped[float] = mapped_column(Float)                      # the price asked
    currency: Mapped[str] = mapped_column(String, default="USDT-BEP20")
    tx_hash: Mapped[Optional[str]] = mapped_column(String, nullable=True, unique=True)
    status: Mapped[str] = mapped_column(String, default="pending")   # pending | paid | expired | failed
    period: Mapped[str] = mapped_column(String)                       # month | year | donation
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    paid_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # How it was paid: xrocket (an invoice in Telegram) | bep20 (to the address).
    provider: Mapped[str] = mapped_column(String, default="bep20")
    invoice_id: Mapped[Optional[str]] = mapped_column(String, nullable=True, index=True)   # xRocket's
    pay_url: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    credited: Mapped[Optional[float]] = mapped_column(Float, nullable=True)   # what reached the balance


class SupportTicket(Base):
    """A message to support from the app ("Написать нам"): kept here; the
    support inbox gets it in a digest (support_digest.py), and then mailed is set."""
    __tablename__ = "support_tickets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    category: Mapped[str] = mapped_column(String, index=True)   # bug | payment | account | ...
    text: Mapped[str] = mapped_column(String)
    plan: Mapped[str] = mapped_column(String)                   # the user's plan when they wrote
    app_version: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    os: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    due_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)  # answer by (the rules)
    status: Mapped[str] = mapped_column(String, default="new")  # new | answered | closed
    mailed: Mapped[bool] = mapped_column(Boolean, default=False)


def init_accounts_db() -> None:
    Base.metadata.create_all(engine)
    _add_missing_columns(engine)


def _add_missing_columns(eng) -> None:
    """create_all makes new tables but leaves existing ones as they are: a
    column added to a model since the database was made is added here, so an
    existing accounts.db keeps working (and keeps its data)."""
    from sqlalchemy import inspect, text
    insp = inspect(eng)
    with eng.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if not insp.has_table(table.name):
                continue
            have = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name in have:
                    continue
                ddl = col.type.compile(dialect=eng.dialect)
                default = col.default.arg if col.default is not None and not callable(col.default.arg) else None
                extra = f" DEFAULT {int(default) if isinstance(default, bool) else default!r}" if default is not None else ""
                conn.execute(text(f'ALTER TABLE {table.name} ADD COLUMN {col.name} {ddl}{extra}'))
