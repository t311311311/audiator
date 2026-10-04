# -*- coding: utf-8 -*-
"""Sends the sign-in code by email.

With SMTP configured (the mailbox audiatorr@gmail.com and its app password)
the code is mailed:
  SMTP_HOST, SMTP_PORT (465 = SSL, otherwise STARTTLS), SMTP_USER,
  SMTP_PASSWORD, SMTP_FROM (defaults to SMTP_USER)
Without it the code goes nowhere and sign-in fails ("could not send"): a code
in a log would let whoever reads the log sign in as anyone. Only on a
development machine (MAIL_DEV_PRINT=1, which `npm start` sets for the server it
starts) is the code printed in the server's console instead.
"""
import os
import smtplib
import ssl
from email.message import EmailMessage

TEXTS = {
    "en": ("Your Audiator code: {code}",
           "Your code to sign in to Audiator: {code}\n\nIt is valid for 10 minutes. "
           "If you did not ask for it, just ignore this email."),
    "ru": ("Код для входа в Audiator: {code}",
           "Ваш код для входа в Audiator: {code}\n\nОн действует 10 минут. "
           "Если вы его не запрашивали, просто не обращайте внимания на это письмо."),
    "zh": ("您的 Audiator 验证码：{code}",
           "您登录 Audiator 的验证码：{code}\n\n10 分钟内有效。如果不是您本人操作，请忽略此邮件。"),
}


def configured() -> bool:
    """A server to send through, and its password if it wants a login (a
    mailbox written down with its password still empty is not ready)."""
    return bool(os.environ.get("SMTP_HOST")) and (
        not os.environ.get("SMTP_USER") or bool(os.environ.get("SMTP_PASSWORD")))


def dev_print() -> bool:
    return os.environ.get("MAIL_DEV_PRINT") == "1"


def send_code(email: str, code: str, lang: str = "en") -> None:
    subject, body = TEXTS.get(lang, TEXTS["en"])
    subject, body = subject.format(code=code), body.format(code=code)
    if not configured():
        if not dev_print():
            raise RuntimeError("SMTP is not configured (SMTP_HOST, SMTP_USER, SMTP_PASSWORD)")
        print(f"[mail] (no SMTP configured) sign-in code for {email}: {code}", flush=True)
        return
    send(email, subject, body)


def support_inbox() -> str:
    """Where messages to support go: SUPPORT_TO, or the mailbox codes are sent from."""
    return os.environ.get("SUPPORT_TO") or os.environ.get("SMTP_USER") or ""


def send(to: str, subject: str, body: str, reply_to: str = "") -> None:
    """Send a plain-text letter. reply_to: where "Reply" in the mail program
    answers (a user's message to support: to the user)."""
    if not configured():
        if not dev_print():
            raise RuntimeError("SMTP is not configured (SMTP_HOST, SMTP_USER, SMTP_PASSWORD)")
        print(f"[mail] (no SMTP configured) to {to}: {subject}\n{body}", flush=True)
        return
    host = os.environ["SMTP_HOST"]
    port = int(os.environ.get("SMTP_PORT", "465"))
    user = os.environ.get("SMTP_USER", "")
    password = os.environ.get("SMTP_PASSWORD", "")
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = os.environ.get("SMTP_FROM") or user
    msg["To"] = to
    if reply_to:
        msg["Reply-To"] = reply_to
    msg.set_content(body)
    context = ssl.create_default_context()
    if port == 465:
        with smtplib.SMTP_SSL(host, port, context=context, timeout=20) as s:
            if user:
                s.login(user, password)
            s.send_message(msg)
    else:
        with smtplib.SMTP(host, port, timeout=20) as s:
            s.starttls(context=context)
            if user:
                s.login(user, password)
            s.send_message(msg)
