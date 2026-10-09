# -*- coding: utf-8 -*-
"""The balance and the paid period (the rules, section 4).

Every payment goes to the account's balance, and the balance at once buys
periods while it covers one: a year if it can, otherwise a month. A period
bought while another runs is added to its end (owner's decision 2026-10-09:
"add another month for the client" instead of keeping the money on the
balance). Only what is less than a month waits on the balance, for the next
payment. A shortfall of up to 2% of the price (an exchange's fee) still buys
the period. No refunds: what is paid stays on the balance.

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
        if PRICE[period] > 0 and balance >= PRICE[period] * (1 - SHORTFALL) - 1e-9:
            return period
    return None


def settle(u, now) -> bool:
    """Buy periods from the balance while it covers one, each added to the end
    of the paid time (or from now, when none runs). True if anything changed.
    A period that lapsed while the user was away starts again now — the days
    in between were not paid for."""
    changed = False
    while (period := next_period(u.balance or 0.0)) is not None:
        start = u.paid_until if u.paid_until and u.paid_until > now else now
        u.paid_until = start + timedelta(days=DAYS[period])
        u.balance = max(0.0, round((u.balance or 0.0) - PRICE[period], 6))
        changed = True
    return changed


def credit(u, amount: float, now) -> None:
    """Money in: onto the balance, which starts a period if none runs."""
    u.balance = round((u.balance or 0.0) + max(0.0, amount), 6)
    settle(u, now)
