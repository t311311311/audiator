# -*- coding: utf-8 -*-
"""The balance and the paid period (the rules, section 4).

Every payment goes to the account's balance. While no paid period runs, the
balance pays the next one: a year if it covers one, otherwise a month. The
rest waits and pays for the following periods when this one ends — at the
price in force then. A shortfall of up to 2% of the price (an exchange's fee)
still buys the period. No refunds: what is paid stays on the balance.

Kept free of the web layer, so the accounts endpoints and the payment ones
both use it (accounts.py would otherwise import payments.py and the other way).
"""
import os
from datetime import timedelta

PRICE = {"month": float(os.environ.get("PRICE_MONTH", "3")), "year": float(os.environ.get("PRICE_YEAR", "25"))}
DAYS = {"month": 30, "year": 365}
SHORTFALL = 0.02


def next_period(balance: float):
    """The period the balance pays for, or None when it covers none."""
    for period in ("year", "month"):
        if balance >= PRICE[period] * (1 - SHORTFALL) - 1e-9:
            return period
    return None


def settle(u, now) -> bool:
    """When no paid period runs, start one from the balance. True if anything
    changed. A period that lapsed while the user was away starts again now —
    the days in between were not paid for."""
    if u.paid_until and u.paid_until > now:
        return False
    period = next_period(u.balance or 0.0)
    if period is None:
        return False
    u.paid_until = now + timedelta(days=DAYS[period])
    u.balance = max(0.0, round((u.balance or 0.0) - PRICE[period], 6))
    return True


def credit(u, amount: float, now) -> None:
    """Money in: onto the balance, which starts a period if none runs."""
    u.balance = round((u.balance or 0.0) + max(0.0, amount), 6)
    settle(u, now)
