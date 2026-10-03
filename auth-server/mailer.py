# -*- coding: utf-8 -*-
"""Sends the sign-in code by email.

With SMTP configured (a mailbox such as audiator@gmail.com and its app
password) the code is mailed:
  SMTP_HOST, SMTP_PORT (465 = SSL, otherwise STARTTLS), SMTP_USER,
  SMTP_PASSWORD, SMTP_FROM (defaults to SMTP_USER)
Without it — development on this computer — the code is printed in the
server's console instead, so sign-in can be tried before a mailbox exists.
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
    return bool(os.environ.get("SMTP_HOST"))


def send_code(email: str, code: str, lang: str = "en") -> None:
    subject, body = TEXTS.get(lang, TEXTS["en"])
    subject, body = subject.format(code=code), body.format(code=code)
    if not configured():
        print(f"[mail] (no SMTP configured) sign-in code for {email}: {code}", flush=True)
        return
    host = os.environ["SMTP_HOST"]
    port = int(os.environ.get("SMTP_PORT", "465"))
    user = os.environ.get("SMTP_USER", "")
    password = os.environ.get("SMTP_PASSWORD", "")
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = os.environ.get("SMTP_FROM") or user
    msg["To"] = email
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
