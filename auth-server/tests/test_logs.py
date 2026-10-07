# -*- coding: utf-8 -*-
"""Log files that cannot fill the disk (log_setup.py): a new file at midnight
or at the size limit, old ones compressed, deleted by age and by the total cap
— also under a flood of requests from many threads at once."""
import gzip
import logging
import os
import threading
import time

import pytest

import log_setup

KB = 1024


def _logger(handler, name="test-logs"):
    log = logging.getLogger(name)
    log.handlers[:] = [handler]
    log.setLevel(logging.INFO)
    log.propagate = False
    return log


def _total(directory):
    return sum(os.path.getsize(os.path.join(directory, f)) for f in os.listdir(directory))


def _read_all(handler):
    text = ""
    for f in handler.archives():
        opener = gzip.open if f.endswith(".gz") else open
        with opener(f, "rt", encoding="utf-8") as fh:
            text += fh.read()
    with open(handler.baseFilename, encoding="utf-8") as fh:
        return text + fh.read()


def test_size_limit_turns_the_file_over_and_the_total_stays_capped(tmp_path):
    h = log_setup.CappedFileHandler(str(tmp_path), max_file_bytes=20 * KB, max_total_bytes=60 * KB,
                                    background=False)
    log = _logger(h)
    for i in range(40000):  # ~2.5 MB of lines
        log.info("127.0.0.1:5000 - \"GET /api/v2/me?tz=-240 HTTP/1.1\" 200 OK line %06d", i)
    h.flush()
    assert _total(tmp_path) <= 60 * KB + 20 * KB, "never more than the cap (+ the file being written)"
    archives = h.archives()
    assert archives and all(f.endswith(".gz") for f in archives), "old files are compressed"
    text = _read_all(h)
    assert "line 039999" in text, "the newest lines are kept"
    assert "line 000000" not in text, "the oldest went to make room"
    h.close()


def test_a_new_file_at_midnight_named_by_its_day(tmp_path, monkeypatch):
    monkeypatch.setattr(log_setup, "_today", lambda: "2026-10-04")
    h = log_setup.CappedFileHandler(str(tmp_path), background=False)
    log = _logger(h)
    log.info("before midnight")
    monkeypatch.setattr(log_setup, "_today", lambda: "2026-10-05")
    log.info("after midnight")
    h.flush()
    (old,) = h.archives()
    assert os.path.basename(old).startswith("server-2026-10-04_") and old.endswith(".gz")
    with gzip.open(old, "rt", encoding="utf-8") as f:
        assert "before midnight" in f.read()
    with open(h.baseFilename, encoding="utf-8") as f:
        assert f.read().strip().endswith("after midnight")
    h.close()


def test_files_older_than_the_keep_days_are_deleted(tmp_path):
    old = tmp_path / "server-2026-08-01_000000.log.gz"
    recent = tmp_path / "server-2026-09-30_000000.log.gz"
    for f, days in ((old, 40), (recent, 4)):
        f.write_bytes(b"x")
        t = time.time() - days * 86400
        os.utime(f, (t, t))
    h = log_setup.CappedFileHandler(str(tmp_path), keep_days=30, background=False)
    assert not old.exists() and recent.exists()
    h.close()


def test_a_file_left_from_yesterday_is_turned_over_at_start(tmp_path):
    left = tmp_path / "server.log"
    left.write_text("from yesterday\n", encoding="utf-8")
    t = time.time() - 86400
    os.utime(left, (t, t))
    h = log_setup.CappedFileHandler(str(tmp_path), background=False)
    (old,) = h.archives()
    assert time.strftime("%Y-%m-%d", time.localtime(t)) in os.path.basename(old)
    assert not os.path.exists(h.baseFilename), "today's file starts afresh with the next line"
    h.close()


def test_a_file_that_vanishes_while_tidying_is_skipped(tmp_path, monkeypatch):
    """Background workers compress and delete files while another one tidies:
    a file found a moment ago may be gone by the time it is looked at. Before
    this fix that killed the worker (FileNotFoundError), about 1 run in 15 of
    the flood test below."""
    h = log_setup.CappedFileHandler(str(tmp_path), background=False)
    kept = tmp_path / "server-2026-10-05_000000.log.gz"
    kept.write_bytes(b"x")
    gone = str(tmp_path / "server-2026-10-05_010000.log")  # compressed and removed meanwhile
    found = log_setup.glob.glob
    monkeypatch.setattr(log_setup.glob, "glob", lambda pattern: found(pattern) + [gone])
    assert h.archives() == [str(kept)]

    # server.log turned over by a request between "is it there" and "how big".
    real_getsize = os.path.getsize

    def getsize(path):
        if path == h.baseFilename:
            raise FileNotFoundError(path)
        return real_getsize(path)

    monkeypatch.setattr(log_setup.os.path, "getsize", getsize)
    h._tidy()
    assert kept.exists()
    h.close()


@pytest.mark.filterwarnings("error::pytest.PytestUnhandledThreadExceptionWarning")
def test_a_flood_from_many_threads(tmp_path):
    """A "pump": requests from many threads at once, small limits so the files
    turn over constantly; compression in the background, as on the server."""
    h = log_setup.CappedFileHandler(str(tmp_path), max_file_bytes=64 * KB, max_total_bytes=512 * KB)
    log = _logger(h, "test-flood")
    errors = []

    def hammer(n):
        try:
            for i in range(15000):
                log.info("10.0.%d.%d - \"POST /api/v2/usage HTTP/1.1\" 200 OK", n, i % 256)
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=hammer, args=(n,)) for n in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    h.wait()
    h.acquire()
    try:
        h._tidy()  # what the next turnover would do
    finally:
        h.release()
    assert not errors
    assert _total(tmp_path) <= 512 * KB + 64 * KB * 2
    h.close()


def test_install_only_with_a_log_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(log_setup, "_installed", None)
    monkeypatch.delenv("LOG_DIR", raising=False)
    assert log_setup.install() is None, "development: console only"
    monkeypatch.setenv("LOG_DIR", str(tmp_path))
    monkeypatch.setenv("LOG_CONSOLE", "1")
    h = log_setup.install()
    try:
        logging.getLogger("uvicorn.access").info('1.2.3.4:1 - "GET /api/v2/me HTTP/1.1" 200')
        logging.getLogger("audiator").warning("mail to i***@mail.ru failed: test")
        h.flush()
        text = (tmp_path / "server.log").read_text(encoding="utf-8")
        assert '"GET /api/v2/me HTTP/1.1" 200' in text and "mail to i***@mail.ru failed" in text
        assert log_setup.install() is h, "once"
    finally:
        for name in log_setup.LOGGERS:
            logging.getLogger(name).removeHandler(h)
        h.close()
