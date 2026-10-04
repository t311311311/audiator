# -*- coding: utf-8 -*-
"""Translation on demand for the engine: Argos Translate, on the user's computer.

Nothing is installed by default. A language is installed as a pair of Argos
packages — to and from English (sizes in translate_catalog.json, measured from
the package index) — so any two installed languages translate through English.
English itself needs nothing.

Packages are downloaded with progress the app can show, can be stopped
(partial files removed) and deleted again to free space. Packages Argos already
installed in its default folder (development machines) are used in place.
"""
import json
import os
import re
import shutil
import sys
import threading
import types
from pathlib import Path

import requests

# Where downloaded language packages go. Set before argostranslate is imported:
# it reads ARGOS_PACKAGES_DIR once, at import.
_models_dir = os.environ.get("WHISPER_MODELS_DIR") or os.path.join(
    os.environ.get("APPDATA") or os.path.expanduser("~"), "audiator", "models")
PACKAGES_DIR = os.path.join(_models_dir, "translate")
# Downloads in progress live beside, not inside: Argos treats every folder in
# its packages folder as a package.
DOWNLOADS_DIR = os.path.join(_models_dir, "translate-downloads")
os.makedirs(PACKAGES_DIR, exist_ok=True)
os.environ["ARGOS_PACKAGES_DIR"] = PACKAGES_DIR
os.environ.setdefault("ARGOS_DEVICE_TYPE", "cpu")

# Sentence splitting. Argos Translate (MIT) splits text with MiniSBD, which is
# under the AGPL-3.0: shipped inside a closed program it would oblige us to
# publish the program's source. So MiniSBD is not used and not bundled
# (build-engine.js excludes it): Argos imports it at start, and gets this
# stand-in instead; the splitting itself is done by _Sentencizer below.
_minisbd = types.ModuleType("minisbd")
_minisbd.SBDetect = None
_minisbd.models = types.SimpleNamespace(cache_dir=None, list_models=lambda: [])
sys.modules["minisbd"] = _minisbd

import argostranslate.package as argos_package    # noqa: E402
import argostranslate.settings as argos_settings  # noqa: E402
import argostranslate.translate as argos_translate  # noqa: E402

# Words that end in a dot without ending the sentence ("Dr. Smith", "т. е.").
_ABBREV = {
    "dr", "mr", "mrs", "ms", "prof", "st", "jr", "sr", "vs", "etc", "e.g", "i.e", "no", "fig", "vol", "approx",
    "т", "е", "т.е", "т.к", "т.д", "т.п", "др", "г", "гг", "см", "стр", "им", "ул", "д", "кв", "тыс", "млн",
    "млрд", "руб", "коп", "проф", "доц", "акад", "z.b", "bzw", "usw", "ca", "nr", "evtl",
}
_END = re.compile(r"[.!?\u2026]+[\"'\u00bb\u201d\u2019)\]]*\s+|[\u3002\uff01\uff1f]+")
_MAX = 400  # longer pieces (no punctuation) are cut at commas, then spaces


class _Sentencizer:
    """Splits text into sentences by its punctuation: after . ! ? … when the
    next word starts with a capital letter or a digit (not after an
    abbreviation), and after 。！？ in Chinese and Japanese. Dictated text
    comes punctuated by the speech recognition, which is what this needs."""

    def __init__(self, pkg=None):
        self.pkg = pkg

    def split_sentences(self, text):
        out, start = [], 0
        for m in _END.finditer(text):
            end = m.end()
            if m.group()[0] not in "\u3002\uff01\uff1f":
                nxt = text[end:end + 2].lstrip("\"'\u00ab\u201c([")[:1]
                if not nxt or not (nxt.isupper() or nxt.isdigit()):
                    continue
                if m.group()[0] == ".":
                    before = text[start:m.start()].split()
                    word = before[-1].lower().rstrip(".") if before else ""
                    if word in _ABBREV or (len(word) == 1 and word.isalpha()):
                        continue
            piece = text[start:end].strip()
            if piece:
                out.extend(_cut(piece))
            start = end
        rest = text[start:].strip()
        if rest:
            out.extend(_cut(rest))
        return out or [text]


def _cut(piece):
    """A piece too long for the model in one go, cut at commas, else spaces."""
    if len(piece) <= _MAX:
        return [piece]
    parts, cur = [], ""
    for chunk in re.split(r"(?<=[,;:])\s+|\s+", piece):
        if cur and len(cur) + 1 + len(chunk) > _MAX:
            parts.append(cur)
            cur = chunk
        else:
            cur = f"{cur} {chunk}" if cur else chunk
    if cur:
        parts.append(cur)
    return parts


# Argos picks its sentence splitter by this name when a language is first used.
argos_translate.MiniSBDSentencizer = _Sentencizer

# Argos's own default folder: packages installed there earlier keep working.
_LEGACY_DIR = Path(os.path.expanduser("~")) / ".local" / "share" / "argos-translate" / "packages"
if _LEGACY_DIR.is_dir() and _LEGACY_DIR not in argos_settings.package_dirs:
    argos_settings.package_dirs.append(_LEGACY_DIR)

# The languages on offer: code -> name and its two packages (url, size).
_here = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
with open(os.path.join(_here, "translate_catalog.json"), encoding="utf-8") as f:
    CATALOG = json.load(f)

# Speech recognition (Whisper) and Argos name a few languages differently.
WHISPER_TO_ARGOS = {"no": "nb"}

_lock = threading.Lock()
_job = None                       # the language being downloaded, if any
_queue = []                       # languages waiting their turn, in order asked
_failed = {}                      # code -> why its download failed (until retried)
_state = {"state": "idle", "done": 0, "total": 0, "error": None}
_cancel = threading.Event()


class _Cancelled(Exception):
    pass


def _set(**kw):
    with _lock:
        _state.update(kw)


def _installed_pairs():
    """{(from, to): Package} for the translate packages on this computer."""
    return {(p.from_code, p.to_code): p for p in argos_package.get_installed_packages()
            if getattr(p, "type", "translate") == "translate"}


def installed():
    """Languages that translate both ways with English (English included)."""
    pairs = _installed_pairs()
    codes = {"en"}
    for code in CATALOG:
        if ("en", code) in pairs and (code, "en") in pairs:
            codes.add(code)
    return sorted(codes)


def status():
    with _lock:
        s = dict(_state, job=_job, queue=list(_queue), failed=dict(_failed))
    s["installed"] = installed()
    return s


def catalog():
    """Every language on offer with its download size (both packages)."""
    return [{"code": c, "name": v["name"], "size": sum(p["size"] for p in v["packages"])}
            for c, v in CATALOG.items()]


def _download(url, dest, done, total):
    """Fetch one package file into dest, adding to the shared progress."""
    tmp = dest + ".part"
    with requests.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                if _cancel.is_set():
                    raise _Cancelled()
                f.write(chunk)
                done += len(chunk)
                _set(done=done, total=total)
    os.replace(tmp, dest)
    return done


def _install(code):
    global _job
    downloads = DOWNLOADS_DIR
    os.makedirs(downloads, exist_ok=True)
    try:
        pairs = _installed_pairs()
        todo = [p for p in CATALOG[code]["packages"] if (p["from"], p["to"]) not in pairs]
        total = sum(p["size"] for p in todo)
        done = 0
        _set(state="downloading", done=0, total=total, error=None)
        files = []
        for p in todo:
            dest = os.path.join(downloads, f"{p['from']}_{p['to']}.argosmodel")
            done = _download(p["url"], dest, done, total)
            files.append(dest)
        _set(state="installing")
        for path in files:
            argos_package.install_from_path(Path(path))
            os.remove(path)
        _set(state="idle", done=0, total=0)
    except _Cancelled:
        _set(state="idle", done=0, total=0, error=None)
    except Exception as e:  # shown to the user, who can retry
        with _lock:
            _failed[code] = str(e)
        _set(state="idle", done=0, total=0, error=str(e))
    finally:
        shutil.rmtree(downloads, ignore_errors=True)
        # On to the next language in the queue, if any.
        with _lock:
            _job = _queue.pop(0) if _queue else None
            nxt = _job
            _cancel.clear()
        if nxt:
            threading.Thread(target=_install, args=(nxt,), daemon=True).start()


def start_install(code):
    """Download and install a language in the background. While another is
    downloading it joins the queue, so the user can pick several at once and
    let them come in one after another."""
    global _job
    if code not in CATALOG:
        raise KeyError(code)
    with _lock:
        _failed.pop(code, None)
        if _job == code or code in _queue:
            return True
        if _job is not None:
            _queue.append(code)
            return True
        _job = code
        _cancel.clear()
    threading.Thread(target=_install, args=(code,), daemon=True).start()
    return True


def cancel(code=None):
    """Stop the download in progress (code None or the current one), or take a
    waiting language out of the queue. A failed one is just forgotten."""
    with _lock:
        if code is None or code == _job:
            if _job is not None and _state["state"] == "downloading":
                _cancel.set()
        elif code in _queue:
            _queue.remove(code)
        else:
            _failed.pop(code, None)


def delete(code):
    """Remove a language's packages to free disk space."""
    if code not in CATALOG:
        raise KeyError(code)
    with _lock:
        if _job == code:
            raise RuntimeError(f"{code} is being installed")
    for (a, b), pkg in _installed_pairs().items():
        if code in (a, b) and "en" in (a, b):
            argos_package.uninstall(pkg)


def translate(text, source, target):
    """Translate text; through English when neither side is English. Raises
    LookupError naming the language that is not installed."""
    source = WHISPER_TO_ARGOS.get(source, source)
    if source == target or not text.strip():
        return text
    have = installed()
    for code in (source, target):
        if code not in have:
            raise LookupError(code)
    if "en" in (source, target):
        return argos_translate.translate(text, source, target)
    # Argos 1.9 does not chain packages by itself (it returns no translation for
    # ru -> fr), so go through English explicitly.
    english = argos_translate.translate(text, source, "en")
    return argos_translate.translate(english, "en", target)
