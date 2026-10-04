# -*- coding: utf-8 -*-
"""Writes build/THIRD-PARTY-NOTICES.txt: everything of others that the
installer ships, with its licence and the licence's own text.

What goes in is read from the builds themselves, not from a hand-kept list:
the speech engine's PyInstaller tables (build/pyi) say which Python packages
were bundled, and package.json's dependencies which Node modules the app
carries. Models, data and a few native parts that no package metadata
describes are written out below.

Run by scripts/build-engine.js after a successful build; by hand:
  .venv\\Scripts\\python.exe scripts\\third_party_notices.py
"""
import ast
import json
import os
import re
import sys
from importlib import metadata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PYI = os.path.join(ROOT, "build", "pyi", "Audiator Engine")
OUT = os.path.join(ROOT, "build", "THIRD-PARTY-NOTICES.txt")
LICENSE_FILE = re.compile(r"(^|/)(LICEN[CS]E|COPYING|NOTICE|COPYRIGHT)[^/]*$", re.I)


def _toc(name):
    """A PyInstaller table: a Python literal list of tuples."""
    with open(os.path.join(PYI, name), encoding="utf-8") as f:
        return ast.literal_eval(f.read())


def _entries(toc):
    """The (name, source, kind) rows, wherever PyInstaller nested the list."""
    for item in toc:
        if isinstance(item, list):
            yield from (e for e in item if isinstance(e, tuple) and len(e) == 3)
        elif isinstance(item, tuple):
            yield from _entries(item)


def bundled_top_level():
    names = set()
    for entry in _entries(_toc("PYZ-00.toc")):
        names.add(entry[0].split(".")[0])
    for entry in _entries(_toc("COLLECT-00.toc")):
        dest = entry[0].replace("\\", "/")
        first = dest.split("/")[0]
        names.add(first.split(".")[0] if not first.endswith((".dll", ".pyd")) else os.path.splitext(first)[0].split(".")[0])
    std = set(sys.stdlib_module_names)
    return {n for n in names if n and n not in std and not n.startswith("_")}


def python_distributions():
    owners = metadata.packages_distributions()
    dists = {}
    for name in bundled_top_level():
        for dist in owners.get(name, []):
            dists.setdefault(dist.lower(), dist)
    return sorted(dists.values(), key=str.lower)


def license_of(meta):
    lic = meta.get("License-Expression") or ""
    if not lic:
        raw = (meta.get("License") or "").strip()
        lic = raw if raw and len(raw) < 100 and "\n" not in raw else ""
    if not lic:
        cls = [c.split(" :: ")[-1] for c in meta.get_all("Classifier") or [] if c.startswith("License ::")]
        lic = ", ".join(cls)
    return lic or "see the licence text below"


def python_section():
    out = []
    for name in python_distributions():
        try:
            dist = metadata.distribution(name)
        except metadata.PackageNotFoundError:
            continue
        meta = dist.metadata
        texts = []
        for f in dist.files or []:
            if LICENSE_FILE.search(str(f)):
                try:
                    texts.append(open(f.locate(), encoding="utf-8", errors="replace").read().strip())
                except (OSError, ValueError):
                    pass
        home = meta.get("Home-page") or next((u.split(", ", 1)[-1] for u in meta.get_all("Project-URL") or []), "")
        out.append(_entry(f"{meta['Name']} {dist.version}", license_of(meta), home, texts))
    return out


def node_section():
    with open(os.path.join(ROOT, "package.json"), encoding="utf-8") as f:
        pkg = json.load(f)
    seen, order = set(), []

    def walk(name):
        if name in seen:
            return
        d = os.path.join(ROOT, "node_modules", name)
        try:
            with open(os.path.join(d, "package.json"), encoding="utf-8") as f:
                p = json.load(f)
        except OSError:
            return
        seen.add(name)
        order.append((name, p, d))
        for dep in (p.get("dependencies") or {}):
            walk(dep)

    for dep in pkg.get("dependencies", {}):
        walk(dep)
    out = []
    for name, p, d in sorted(order, key=lambda x: x[0]):
        texts = []
        for fn in sorted(os.listdir(d)):
            if LICENSE_FILE.search(fn):
                with open(os.path.join(d, fn), encoding="utf-8", errors="replace") as f:
                    texts.append(f.read().strip())
        lic = p.get("license") if isinstance(p.get("license"), str) else json.dumps(p.get("license") or p.get("licenses"))
        repo = p.get("repository")
        url = repo.get("url") if isinstance(repo, dict) else (repo or p.get("homepage") or "")
        out.append(_entry(f"{name} {p.get('version', '')}", lic, url, texts))
    return out


MANUAL = [
    ("Python 3.12 (the interpreter inside the speech engine)", "PSF-2.0", "https://www.python.org/",
     "Python Software Foundation License Version 2 — https://docs.python.org/3/license.html"),
    ("libuiohook (inside uiohook-napi: the keyboard hook that sees Ctrl+V)", "LGPL-3.0-or-later",
     "https://github.com/kwhat/libuiohook",
     "Copyright (C) 2006-2023 Alexander Barker. Licensed under the GNU Lesser General Public License, version 3 "
     "or later: https://www.gnu.org/licenses/lgpl-3.0.html . The library is part of the separate native module "
     "file uiohook_napi.node in the program folder, which can be replaced with one built from the sources above."),
    ("Electron and Chromium (the application frame)", "MIT and others", "https://www.electronjs.org/",
     "Electron: MIT License, Copyright (c) Electron contributors, GitHub Inc. Chromium and its components: see "
     "LICENSES.chromium.html in the program folder."),
    ("Whisper speech recognition models (OpenAI)", "MIT", "https://github.com/openai/whisper",
     "Copyright (c) 2022 OpenAI. MIT License. Downloaded on first use in the CTranslate2 conversions "
     "Systran/faster-whisper-base and Systran/faster-whisper-small (MIT, https://huggingface.co/Systran) and "
     "mobiuslabsgmbh/faster-whisper-large-v3-turbo (MIT, https://huggingface.co/mobiuslabsgmbh)."),
    ("Silero VAD (voice activity detection model, inside faster-whisper)", "MIT", "https://github.com/snakers4/silero-vad",
     "Copyright (c) 2020-present Silero Team. MIT License."),
    ("Argos Translate language packages (downloaded on demand)", "CC-BY-4.0 and others", "https://www.argosopentech.com/",
     "Translation models derived from OPUS-MT: J. Tiedemann and S. Thottingal, \"OPUS-MT — Building open "
     "translation services for the World\", EAMT 2020; licensed CC-BY 4.0 "
     "(https://creativecommons.org/licenses/by/4.0/). Training data compiled by OPUS (https://opus.nlpl.eu/). "
     "Some packages include models from Stanza (Apache-2.0, Stanford NLP) and dictionary data from Wiktionary "
     "(CC-BY-SA). Each package's README, installed beside it, names its own sources and licence."),
]


def _entry(title, lic, url, texts):
    lines = ["=" * 78, title, f"Licence: {lic}"]
    if url:
        lines.append(f"Source: {url}")
    for t in texts:
        lines += ["", t]
    return "\n".join(lines)


def main():
    parts = [
        "Audiator — third-party components",
        "",
        "Audiator includes or downloads the following software and models by others. Each is used under its",
        "own licence, given below; nothing of them has been modified. Components licensed under the GPL or",
        "AGPL are deliberately not included (see docs in the source repository).",
        "",
        "PART 1. Models, data and native parts",
    ]
    parts += [_entry(t, l, u, [x]) for t, l, u, x in MANUAL]
    parts += ["", "PART 2. Python packages inside the speech engine (Audiator Engine)"]
    parts += python_section()
    parts += ["", "PART 3. Node.js modules inside the application"]
    parts += node_section()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(parts) + "\n")
    print(f"Written: {os.path.relpath(OUT, ROOT)} ({os.path.getsize(OUT) // 1024} KB)")


if __name__ == "__main__":
    main()
