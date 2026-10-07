# -*- coding: utf-8 -*-
"""Server logs that cannot fill the disk, however hard the server is hit.

The log is a set of files in LOG_DIR:
  server.log                         today's, being written
  server-2026-10-04_000000.log.gz    earlier ones, compressed (text shrinks ~10x)

A new file starts every midnight, and sooner if today's grows past
LOG_MAX_FILE_MB — so a sudden flood of requests (a "pump") gives several
files a day, never one huge one. Old files are compressed in the background
and deleted once they are older than LOG_KEEP_DAYS, or, oldest first, as soon
as all of them together pass LOG_MAX_TOTAL_MB. A flood can only make the
history shorter, never the disk fuller.

What is in it: one line per request (time, IP, address, status) and the
server's own warnings. No sign-in codes, tokens or texts; email addresses only
masked. IP addresses are personal data, hence days, not months.

Env (set on the server; with no LOG_DIR — development — logs go to the
console only, as before):
  LOG_DIR            where the files go
  LOG_KEEP_DAYS      default 30
  LOG_MAX_FILE_MB    default 100   (a new file sooner than midnight)
  LOG_MAX_TOTAL_MB   default 1024  (everything, today's file included)
  LOG_CONSOLE        default 1; 0 = files only (when the console is kept too,
                     e.g. by systemd's journal, which has limits of its own)
"""
import glob
import gzip
import logging
import os
import shutil
import threading
import time

MB = 1024 * 1024
LOGGERS = ("uvicorn.access", "uvicorn.error", "audiator")
FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"


def _today() -> str:
    return time.strftime("%Y-%m-%d")


class CappedFileHandler(logging.FileHandler):
    """Today's file, turned over at midnight or at max_file_bytes; the old ones
    compressed, and deleted by age and by the total cap."""

    def __init__(self, directory, name="server", keep_days=30, max_file_bytes=100 * MB,
                 max_total_bytes=1024 * MB, background=True):
        os.makedirs(directory, exist_ok=True)
        self.dir, self.stem = directory, name  # not .name: a Handler's own
        self.keep_days, self.max_file, self.max_total = keep_days, max_file_bytes, max_total_bytes
        self.background = background
        self.day = _today()
        self._workers = []
        super().__init__(os.path.join(directory, f"{name}.log"), encoding="utf-8")
        # A file left from yesterday (the server was down at midnight) is turned over first.
        if os.path.getsize(self.baseFilename) and _mday(self.baseFilename) != self.day:
            self.day = _mday(self.baseFilename)
            self._rotate()
        else:
            self._tidy()

    def emit(self, record):
        try:
            if self._due():
                self._rotate()
        except Exception:  # noqa: BLE001 — logging must never take the server down
            self.handleError(record)
        super().emit(record)

    def _due(self) -> bool:
        if _today() != self.day:
            return True
        return self.stream is not None and self.stream.tell() >= self.max_file

    def _rotate(self):
        # Called with the handler's lock held (Handler.handle takes it).
        if self.stream:
            self.stream.close()
            self.stream = None
        if os.path.exists(self.baseFilename) and os.path.getsize(self.baseFilename):
            # Named by the day the lines are from; the time keeps the names of
            # several files of one day apart.
            target = os.path.join(self.dir, f"{self.stem}-{self.day}_{time.strftime('%H%M%S')}.log")
            n = 1
            while os.path.exists(target) or os.path.exists(target + ".gz"):
                target = target.replace(".log", f"-{n}.log")
                n += 1
            os.replace(self.baseFilename, target)
            self._later(target)
        self.day = _today()
        # The next emit reopens server.log (FileHandler does when stream is None).

    def _later(self, path):
        if not self.background:
            self._compress_and_tidy(path)
            return
        # Compressing 100 MB takes a second or two: not on the request's time.
        t = threading.Thread(target=self._compress_and_tidy, args=(path,), daemon=True)
        self._workers = [w for w in self._workers if w.is_alive()] + [t]
        t.start()

    def _compress_and_tidy(self, path):
        try:
            with open(path, "rb") as src, gzip.open(path + ".gz", "wb") as dst:
                shutil.copyfileobj(src, dst)
            os.remove(path)
        except OSError:
            pass  # left uncompressed; still counted and deleted in time
        self._tidy()

    def archives(self):
        """The old files, oldest first. A file another worker has just compressed
        or deleted is skipped."""
        stamped = []
        for f in glob.glob(os.path.join(self.dir, f"{self.stem}-*.log*")):
            try:
                stamped.append((os.path.getmtime(f), f))
            except OSError:
                pass
        return [f for _, f in sorted(stamped)]

    def _tidy(self):
        cutoff = time.time() - self.keep_days * 86400
        files = []
        for f in self.archives():
            try:
                if os.path.getmtime(f) < cutoff:
                    os.remove(f)
                else:
                    files.append((f, os.path.getsize(f)))
            except OSError:
                pass
        try:
            current = os.path.getsize(self.baseFilename)
        except OSError:
            current = 0  # not reopened yet, or turned over by a request just now
        total = current + sum(size for _, size in files)
        while files and total > self.max_total:
            f, size = files.pop(0)
            try:
                os.remove(f)
            except OSError:
                pass
            total -= size

    def wait(self):
        """Let background compression finish (tests, shutdown)."""
        for w in self._workers:
            w.join()


def _mday(path) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(os.path.getmtime(path)))


_installed = None


def install():
    """Send the server's logs to capped files in LOG_DIR. Called once uvicorn
    has set up its own logging (it would replace handlers added before)."""
    global _installed
    directory = os.environ.get("LOG_DIR")
    if not directory or _installed:
        return _installed
    handler = CappedFileHandler(
        directory,
        keep_days=int(os.environ.get("LOG_KEEP_DAYS", "30")),
        max_file_bytes=int(os.environ.get("LOG_MAX_FILE_MB", "100")) * MB,
        max_total_bytes=int(os.environ.get("LOG_MAX_TOTAL_MB", "1024")) * MB,
    )
    handler.setFormatter(logging.Formatter(FORMAT))
    console = os.environ.get("LOG_CONSOLE", "1") != "0"
    for name in LOGGERS:
        log = logging.getLogger(name)
        if not console:
            for h in list(log.handlers):
                if isinstance(h, logging.StreamHandler) and not isinstance(h, logging.FileHandler):
                    log.removeHandler(h)
        log.addHandler(handler)
        if log.level == logging.NOTSET or log.level > logging.INFO:
            log.setLevel(logging.INFO)
    _installed = handler
    logging.getLogger("audiator").info("logs: %s (keep %s days, %s MB a file, %s MB in all)",
                                       directory, handler.keep_days, handler.max_file // MB, handler.max_total // MB)
    return handler
