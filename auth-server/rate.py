# -*- coding: utf-8 -*-
"""In-memory sliding-window rate limiter (AUD-13).

Dependency-free and thread-safe. Suitable for a SINGLE-process deployment
(one uvicorn worker, as the auth server runs today). If the server is ever
scaled to multiple workers or instances, these counters — which live in one
process's memory — must move to a shared store (Redis) or an edge limiter
(nginx ``limit_req``); otherwise each worker would enforce the limit separately.
"""
import time
import threading

_hits: "dict[str, list[float]]" = {}
_lock = threading.Lock()
_last_sweep = time.time()


def _maybe_sweep(now: float, max_age: float = 86400.0) -> None:
    """Opportunistically drop keys not seen for a while, to bound memory.
    Runs at most every 10 minutes. Caller must hold the lock."""
    global _last_sweep
    if now - _last_sweep < 600:
        return
    _last_sweep = now
    for k in list(_hits.keys()):
        q = _hits[k]
        if not q or q[-1] < now - max_age:
            del _hits[k]


def check(key: str, limit: int, window_sec: int) -> "tuple[bool, int]":
    """Sliding window: allow at most ``limit`` events per ``window_sec`` for
    ``key``. Returns ``(allowed, retry_after_seconds)``; on rejection
    ``retry_after`` is when the oldest in-window event expires."""
    now = time.time()
    cutoff = now - window_sec
    with _lock:
        _maybe_sweep(now)
        q = _hits.setdefault(key, [])
        while q and q[0] < cutoff:
            q.pop(0)
        if len(q) >= limit:
            return False, max(int(q[0] + window_sec - now) + 1, 1)
        q.append(now)
        return True, 0
