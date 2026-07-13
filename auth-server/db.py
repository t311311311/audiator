# -*- coding: utf-8 -*-
"""Persistence layer for the Audiator auth server.

Replaces the previous in-memory ``users_db`` dict so trials, subscriptions and
payments survive restarts. Uses SQLite by default (zero extra infrastructure);
set ``DATABASE_URL`` to a Postgres URL to switch backends without code changes,
e.g. ``postgresql+psycopg://user:pass@host:5432/audiator``.
"""
import os
from datetime import datetime
from typing import Optional

from sqlalchemy import create_engine, String, Boolean, DateTime
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


def init_db() -> None:
    """Create tables on first run. Safe to call on every startup."""
    Base.metadata.create_all(engine)


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
        }


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
