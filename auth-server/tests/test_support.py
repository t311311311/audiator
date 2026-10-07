# -*- coding: utf-8 -*-
"""Messages to support ("Написать нам"): kept, not mailed one by one; the inbox
gets digests (support_digest.py) — at ten new or every morning — each message
with who, topic, plan, answer time, the start of the text and a reply link;
answer times from the rules."""
from datetime import datetime, timedelta

import pytest

import accounts
import accounts_db
import clients
import mailer
import support
import support_digest

DEV = "c" * 64
MORNING = datetime(2026, 10, 9, support_digest.HOUR_UTC, 0)   # the hour of the morning digest
NOON = datetime(2026, 10, 9, (support_digest.HOUR_UTC + 7) % 24, 0)


@pytest.fixture
def mailbox(monkeypatch):
    codes, letters = {}, []
    monkeypatch.setattr(mailer, "send_code", lambda email, code, lang="en": codes.__setitem__(email, code))
    monkeypatch.setattr(mailer, "send", lambda to, subject, body, reply_to="", html="": letters.append(
        {"to": to, "subject": subject, "body": body, "reply_to": reply_to, "html": html}))
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


def tickets():
    with accounts_db.Session() as s:
        return s.query(accounts_db.SupportTicket).order_by(accounts_db.SupportTicket.id).all()


def test_a_message_is_kept_not_mailed_on_its_own(client, mailbox):
    _, letters = mailbox
    h = signed_in(client, mailbox)
    r = write(client, h, "payment", "Оплатил 3 USDT, тариф не включился. Транзакция 0xabc")
    assert r.status_code == 200
    body = r.json()
    assert body["answer_within"] == "48h" and body["reply_to"] == "ivan@mail.ru" and body["id"] > 0
    assert not letters, "no letter per message: digests only"
    (t,) = tickets()
    assert t.category == "payment" and t.plan == "free" and t.status == "new" and not t.mailed


def test_the_digest_says_who_what_by_when_and_how_to_answer(client, mailbox):
    _, letters = mailbox
    h = signed_in(client, mailbox)
    tid = write(client, h, "payment", "Оплатил 3 USDT, тариф не включился. <b>Транзакция</b> 0xabc").json()["id"]
    assert support_digest.run(force=True).startswith("Audiator: новых обращений 1")
    (letter,) = letters
    assert letter["to"] == "support@example.com"
    assert f"#{tid} · Оплата · ivan@mail.ru · бесплатный · ответить до " in letter["body"]
    assert "Оплатил 3 USDT, тариф не включился" in letter["body"]
    assert "Программа: 1.0.8, Windows 10.0.26200" in letter["body"]
    assert f"mailto:ivan@mail.ru?subject=Re%3A%20Audiator%20%23{tid}" in letter["body"]
    assert f'href="mailto:ivan@mail.ru?subject=Re%3A%20Audiator%20%23{tid}">Ответить</a>' in letter["html"]
    assert "&lt;b&gt;Транзакция&lt;/b&gt;" in letter["html"], "the client's text is shown, never run, in the HTML"
    assert "audiator-admin ticket N" in letter["body"]
    assert tickets()[0].mailed, "in one digest only"
    assert support_digest.run(force=True) is None and len(letters) == 1


def test_a_digest_at_ten_new_whatever_the_hour(client, mailbox, monkeypatch):
    _, letters = mailbox
    monkeypatch.setattr(support, "PER_HOUR", 20)   # ten messages from one account, for the test
    h = signed_in(client, mailbox)
    for _ in range(9):
        write(client, h)
    assert support_digest.run(now=NOON) is None and not letters, "nine — wait"
    write(client, h)
    assert support_digest.run(now=NOON) == "Audiator: новых обращений 10"
    assert len(letters) == 1 and all(t.mailed for t in tickets())


def test_the_morning_digest_with_what_is_new_and_what_is_due(client, mailbox, monkeypatch):
    _, letters = mailbox
    h = signed_in(client, mailbox)
    now = MORNING
    monkeypatch.setattr(support, "_utcnow", lambda: now - timedelta(days=4, hours=12))
    old = write(client, h, "bug", "Старое").json()["id"]           # due in 12 hours
    support_digest.run(force=True)                                  # was in a digest already
    monkeypatch.setattr(support, "_utcnow", lambda: now - timedelta(hours=3))
    new = write(client, h, "idea", "Новое").json()["id"]
    letters.clear()
    assert support_digest.run(now=NOON) is None, "one new at noon — wait for the morning"
    subject = support_digest.run(now=now)
    assert subject == "Audiator: утренняя сводка — новых 1, срок подходит или прошёл 1"
    body = letters[-1]["body"]
    assert f"#{new} · Предложение" in body and "без срока" in body
    assert f"#{old} · Баг" in body and body.index("Срок подходит") < body.index(f"#{old}")


def test_no_letter_when_there_is_nothing(client, mailbox):
    _, letters = mailbox
    assert support_digest.run(now=MORNING) is None and support_digest.run(force=True) is None
    assert not letters


def test_a_digest_that_fails_is_tried_again(client, mailbox, monkeypatch):
    h = signed_in(client, mailbox)
    write(client, h)

    def broken(*a, **k):
        raise RuntimeError("SMTP is down")
    monkeypatch.setattr(mailer, "send", broken)
    assert support_digest.main(["--now"]) == 1
    assert not tickets()[0].mailed, "still new — goes into the next digest"


@pytest.mark.parametrize("category,within", [
    ("payment", "48h"), ("bug", "5d"), ("account", "5d"), ("idea", None)])
def test_answer_times_follow_the_rules(category, within):
    assert support.answer_within(category) == within


def test_five_days_are_plain_days_whatever_the_plan(client, mailbox, monkeypatch):
    h = signed_in(client, mailbox)
    monkeypatch.setattr(support, "_utcnow", lambda: datetime(2026, 10, 9, 10, 0))  # a Friday
    r = write(client, h, "bug")
    assert r.json()["answer_within"] == "5d"
    assert r.json()["due_at"] == "2026-10-14T10:00:00Z", "5 days from Friday: Wednesday, the weekend counts"


def test_ideas_have_no_deadline(client, mailbox):
    _, letters = mailbox
    h = signed_in(client, mailbox)
    r = write(client, h, "idea", "Добавьте сербский язык")
    assert r.json()["answer_within"] is None and r.json()["due_at"] is None
    support_digest.run(force=True)
    assert "Предложение · ivan@mail.ru · бесплатный · без срока" in letters[-1]["body"]


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


def test_an_account_writes_at_most_twenty_a_day(client, mailbox, monkeypatch):
    """Five an hour, but not five every hour all day."""
    h = signed_in(client, mailbox)
    now = [1_000_000.0]
    monkeypatch.setattr(support.rate.time, "time", lambda: now[0])
    for hour in range(4):
        for _ in range(support.PER_HOUR):
            assert write(client, h).status_code == 200
        now[0] += 3601
    r = write(client, h)
    assert r.status_code == 429 and r.json()["detail"]["retry_after"] > 3600, "the daily cap, not the hourly one"
    now[0] += 86400
    assert write(client, h).status_code == 200, "a day later again"


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
