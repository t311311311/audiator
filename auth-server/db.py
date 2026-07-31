# -*- coding: utf-8 -*-
"""Persistence layer for the Audiator auth server.

Replaces the previous in-memory ``users_db`` dict so trials, subscriptions and
payments survive restarts. Uses SQLite by default (zero extra infrastructure);
set ``DATABASE_URL`` to a Postgres URL to switch backends without code changes,
e.g. ``postgresql+psycopg://user:pass@host:5432/audiator``.
"""
import os
from datetime import datetime, date
from typing import Optional

from sqlalchemy import create_engine, String, Boolean, DateTime, Integer
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

# Default to a local SQLite file next to the app. Override via env for Postgres.
DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./audiator.db")

# SQLite + FastAPI's thread pool requires check_same_thread=False.
_connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=_connect_args, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    device_id: Mapped[str] = mapped_column(String, primary_key=True)
    device_name: Mapped[str] = mapped_column(String, default="Unknown")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)
    is_trial: Mapped[bool] = mapped_column(Boolean, default=False)
    subscription_end: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_payment: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    # Access tier. 'admin' bypasses quotas (for testing), 'free' gets the daily
    # gift allowance, 'paid' is a real subscriber.
    role: Mapped[str] = mapped_column(String, default="free")


class Usage(Base):
    """Per-device, per-day transcription usage in seconds (AUD-13 quota).

    Keyed by (device_id, day) where day is an ISO 'YYYY-MM-DD' string so the
    daily bucket is trivial to query and survives restarts.
    """
    __tablename__ = "usage"

    device_id: Mapped[str] = mapped_column(String, primary_key=True)
    day: Mapped[str] = mapped_column(String, primary_key=True)
    seconds: Mapped[int] = mapped_column(Integer, default=0)


def init_db() -> None:
    """Create tables on first run and add columns introduced later.

    ``create_all`` only creates missing *tables*, so a database made by an older
    version keeps its old columns. Add those in place, which SQLite supports and
    which keeps existing users and their subscriptions intact."""
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        existing = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(users)")}
        if existing and "role" not in existing:
            conn.exec_driver_sql("ALTER TABLE users ADD COLUMN role VARCHAR DEFAULT 'free'")


def get_user(device_id: str) -> Optional[dict]:
    """Return the user as a plain dict (same shape as the old users_db entry),
    or None if not found. Returning a dict keeps callers decoupled from the ORM
    session lifecycle."""
    with SessionLocal() as s:
        u = s.get(User, device_id)
        if u is None:
            return None
        return {
            "device_id": u.device_id,
            "device_name": u.device_name,
            "created_at": u.created_at,
            "is_trial": u.is_trial,
            "subscription_end": u.subscription_end,
            "last_payment": u.last_payment,
            "role": u.role or "free",
        }


def list_users() -> list:
    """All accounts, newest first — used by the admin CLI."""
    with SessionLocal() as s:
        rows = s.query(User).order_by(User.created_at.desc()).all()
        return [{
            "device_id": u.device_id,
            "device_name": u.device_name,
            "role": u.role or "free",
            "is_trial": u.is_trial,
            "subscription_end": u.subscription_end,
        } for u in rows]


def upsert_user(device_id: str, **fields) -> None:
    """Insert or update a user row. Only the provided fields are written."""
    with SessionLocal() as s:
        u = s.get(User, device_id)
        if u is None:
            u = User(device_id=device_id)
            s.add(u)
        for key, value in fields.items():
            setattr(u, key, value)
        s.commit()


def usage_today(device_id: str) -> int:
    """Return seconds of audio transcribed by this device today (0 if none)."""
    today = date.today().isoformat()
    with SessionLocal() as s:
        u = s.get(Usage, (device_id, today))
        return int(u.seconds) if u else 0


def add_usage(device_id: str, seconds: int) -> None:
    """Add transcribed seconds to today's bucket for this device."""
    if seconds <= 0:
        return
    today = date.today().isoformat()
    with SessionLocal() as s:
        u = s.get(Usage, (device_id, today))
        if u is None:
            u = Usage(device_id=device_id, day=today, seconds=0)
            s.add(u)
        u.seconds = int(u.seconds) + int(seconds)
        s.commit()
