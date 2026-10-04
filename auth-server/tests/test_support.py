# -*- coding: utf-8 -*-
"""Messages to support ("Написать нам"): kept, mailed to the inbox with a
subject that says the topic, the number, who and by when; the client's card
in the letter; answer times from the rules."""
from datetime import datetime, timedelta

import pytest

import accounts
import accounts_db
import clients
import mailer
import support

DEV = "c" * 64


@pytest.fixture
def mailbox(monkeypatch):
    codes, letters = {}, []
    monkeypatch.setattr(mailer, "send_code", lambda email, code, lang="en": codes.__setitem__(email, code))
    monkeypatch.setattr(mailer, "send", lambda to, subject, body, reply_to="": letters.append(
        {"to": to, "subject": subject, "body": body, "reply_to": reply_to}))
    monkeypatch.setenv("SUPPORT_TO", "support@example.com")
    return codes, letters


def signed_in(client, mailbox, email="ivan@mail.ru"):
    codes, _ = mailbox
    client.post("/api/v2/auth/code", json={"email": email})
    r = client.post("/api/v2/auth/verify", json={"email": email, "code": codes[email], "device": DEV,
                                                 "terms": accounts.TERMS_VERSION})
    return {"Authorization": f"Bearer {r.json()['token']}"}


def write(client, headers, category="bug", text="Не вставляется текст после второй записи"):
    return client.post("/api/v2/support", json={"category": category, "text": text, "app_version": "1.0.8",
                                                "os": "Windows 10.0.26200"}, headers=headers)


def test_a_message_is_kept_and_mailed_with_a_telling_subject(client, mailbox):
    _, letters = mailbox
    h = signed_in(client, mailbox)
    r = write(client, h, "payment", "Оплатил 3 USDT, тариф не включился. Транзакция 0xabc")
    assert r.status_code == 200
    body = r.json()
    assert body["answer_within"] == "48h" and body["reply_to"] == "ivan@mail.ru" and body["id"] > 0
    (letter,) = letters
    assert letter["to"] == "support@example.com" and letter["reply_to"] == "ivan@mail.ru"
    assert letter["subject"].startswith(f"[Оплата] #{body['id']} · ivan@mail.ru · бесплатный · ответить до ")
    assert "Оплатил 3 USDT, тариф не включился" in letter["body"]
    assert "Клиент: ivan@mail.ru — новый, бесплатный" in letter["body"], "the client's card comes along"
    assert "Программа: 1.0.8, Windows 10.0.26200" in letter["body"]
    with accounts_db.Session() as s:
        t = s.query(accounts_db.SupportTicket).one()
        assert t.category == "payment" and t.plan == "free" and t.mailed and t.status == "new"


@pytest.mark.parametrize("category,plan,within", [
    ("payment", "free", "48h"), ("bug", "free", "5wd"), ("bug", "commercial", "2wd"),
    ("account", "free", "5wd"), ("idea", "commercial", None)])
def test_answer_times_follow_the_rules(category, plan, within):
    assert support.answer_within(category, plan) == within


def test_working_days_skip_the_weekend(client, mailbox, monkeypatch):
    _, letters = mailbox
    h = signed_in(client, mailbox)
    monkeypatch.setattr(support, "_utcnow", lambda: datetime(2026, 10, 9, 10, 0))  # a Friday
    r = write(client, h, "bug")
    assert r.json()["due_at"] == "2026-10-16T10:00:00Z", "5 working days from Friday: next Friday"
    assert "ответить до 16.10 10:00 UTC" in letters[-1]["subject"]
    assert support._working_days_later(datetime(2026, 10, 9), 2) == datetime(2026, 10, 13), "Fri + 2 = Tue"


def test_ideas_have_no_deadline(client, mailbox):
    _, letters = mailbox
    h = signed_in(client, mailbox)
    r = write(client, h, "idea", "Добавьте сербский язык")
    assert r.json()["answer_within"] is None and r.json()["due_at"] is None
    assert letters[-1]["subject"].endswith("· без срока")


@pytest.mark.parametrize("payload,error", [
    ({"category": "spam", "text": "x"}, "bad_category"),
    ({"category": "delete", "text": "x"}, "bad_category"),   # topics removed 2026-10-04
    ({"category": "bug", "text": "   "}, "empty_text"),
    ({"category": "bug", "text": "x" * 5001}, "too_long")])
def test_bad_messages_are_refused(client, mailbox, payload, error):
    h = signed_in(client, mailbox)
    r = client.post("/api/v2/support", json=payload, headers=h)
    assert r.status_code == 400 and r.json()["detail"]["error"] == error


def test_only_signed_in_users_write_and_not_too_often(client, mailbox):
    assert client.post("/api/v2/support", json={"category": "bug", "text": "x"}).status_code == 401
    h = signed_in(client, mailbox)
    for _ in range(support.PER_HOUR):
        assert write(client, h).status_code == 200
    r = write(client, h)
    assert r.status_code == 429 and r.json()["detail"]["error"] == "too_many_requests"


def test_kept_even_when_the_mail_fails(client, mailbox, monkeypatch, caplog):
    h = signed_in(client, mailbox)

    def broken(*a, **k):
        raise RuntimeError("SMTP is down")
    monkeypatch.setattr(mailer, "send", broken)
    caplog.set_level("WARNING", logger="audiator")
    r = write(client, h)
    assert r.status_code == 200
    with accounts_db.Session() as s:
        assert s.query(accounts_db.SupportTicket).one().mailed is False
    assert f"support #{r.json()['id']} not mailed" in caplog.text


def test_what_kind_of_client(client, mailbox):
    signed_in(client, mailbox, "a@b.com")
    today = accounts_db._utcnow().date()
    with accounts_db.Session() as s:
        u = s.query(accounts_db.User).one()
        u.created_at = accounts_db._utcnow() - timedelta(days=60)
        s.commit()

        def with_days(n):
            s.query(accounts_db.Usage).delete()
            for i in range(n):
                s.add(accounts_db.Usage(user_id=u.id, device_hash=DEV, day=(today - timedelta(days=i)).isoformat(),
                                        seconds=600))
            s.commit()
            return clients.kind(u, clients.stats(s, u))
        assert with_days(20) == "постоянный"
        assert with_days(6) == "периодический"
        assert with_days(2) == "редкий"
        assert with_days(0) == "спящий"
        with_days(3)
        card = clients.card(s, u)
        assert "a@b.com — редкий, бесплатный" in card and "за 7 дней 30 мин" in card
        u.created_at = accounts_db._utcnow() - timedelta(days=2)
        assert clients.kind(u, clients.stats(s, u)) == "новый"
