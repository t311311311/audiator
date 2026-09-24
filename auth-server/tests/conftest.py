# -*- coding: utf-8 -*-
"""Test setup for the auth server.

The environment is redirected BEFORE importing the app: db.py reads DATABASE_URL
at import time and main.py creates the tables on import, so a late override would
let the suite write into the real audiator.db. Tests must never touch live data.
"""
import os
import pathlib
import sys
import tempfile

import pytest

AUTH_DIR = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(AUTH_DIR))

TMP_DB = pathlib.Path(tempfile.mkdtemp(prefix="audiator-tests-")) / "test.db"
os.environ["DATABASE_URL"] = f"sqlite:///{TMP_DB.as_posix()}"
os.environ["AUDIATOR_SECRET_KEY"] = "test-secret-not-the-real-one"
os.environ["PAYMENTS_ENABLED"] = "0"
# Nothing listens on port 1. The suite must never reach the real whisper and
# LibreTranslate that `npm start` brings up: a test that expects the proxy call
# to fail passed or failed depending on whether the app happened to be running.
os.environ["WHISPER_URL"] = "http://127.0.0.1:1"
os.environ["TRANSLATE_URL"] = "http://127.0.0.1:1"

import db    # noqa: E402
import main  # noqa: E402
import rate  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture(autouse=True)
def clean_state():
    """Empty database and fresh rate-limit counters for every test."""
    with db.SessionLocal() as s:
        s.query(db.Usage).delete()
        s.query(db.User).delete()
        s.commit()
    rate._hits.clear()
    yield


@pytest.fixture
def client():
    return TestClient(main.app)


@pytest.fixture
def token():
    """Mint a valid token for a device, as the server itself would."""
    def _make(device_id="dev-test", days=30):
        return main.create_token(device_id, days)
    return _make
