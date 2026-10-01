# -*- coding: utf-8 -*-
"""The speech engine: a small local web service around faster-whisper.

Runs on the user's own computer — the app sends audio here and the voice never
leaves the machine. The installed app ships it frozen into "Audiator Engine.exe"
(``npm run build:engine``) and starts it itself (src/engine.js); development
runs this script from the .venv.

Models are not shipped. The app asks for one (``POST /use?name=small``) and the
engine downloads it from Hugging Face with progress the app can show
(``GET /status``), then loads it. A download that breaks off carries on where
it stopped next time. Models already in the Hugging Face cache (development
machines) are used in place, without downloading again.

Endpoints:
  GET  /        health check
  GET  /status  the model in use, what the engine is doing, download progress,
                and which of the offered models are on this computer
  POST /use     switch to a model (download if needed, then load)
  POST /asr     transcribe audio — the whisper-asr-webservice shape
                (text + segments + language)

Run:  python local_whisper.py   (listens on 127.0.0.1:8000)
Env:  WHISPER_PORT (default 8000)
      WHISPER_MODEL  model to load at start if it is already on this computer
      WHISPER_MODELS_DIR  where downloaded models go
                          (default: %APPDATA%\\audiator\\models)
"""
import glob
import os
import shutil
import tempfile
import threading

import requests
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from faster_whisper import WhisperModel

PORT = int(os.environ.get("WHISPER_PORT", "8000"))
START_MODEL = os.environ.get("WHISPER_MODEL") or None
MODELS_DIR = os.environ.get("WHISPER_MODELS_DIR") or os.path.join(
    os.environ.get("APPDATA") or os.path.expanduser("~"), "audiator", "models")

# The models offered in the app's settings ("Быстро / Стандарт / Точно") and
# where faster-whisper keeps them. Sizes are the download (model + tokenizer),
# shown before anything is downloaded.
MODELS = {
    "base": {"repo": "Systran/faster-whisper-base", "size": 147_883_000},
    "small": {"repo": "Systran/faster-whisper-small", "size": 486_212_000},
    "large-v3-turbo": {"repo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo", "size": 1_621_666_000},
}
# The files faster-whisper needs from a model repository (as its own
# download_model fetches them); READMEs and the like are skipped.
WANTED = ("config.json", "preprocessor_config.json", "model.bin", "tokenizer.json", "vocabulary.")
HF = "https://huggingface.co"
HF_CACHE = os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub")

app = FastAPI(title="Audiator Engine")

_lock = threading.Lock()
_model = None          # the loaded WhisperModel
_state = {"model": None, "state": "idle", "done": 0, "total": 0, "error": None}
_job = None            # the model being downloaded / loaded, if any


def _set(**kw):
    with _lock:
        _state.update(kw)


def _complete(folder):
    return bool(folder) and os.path.isfile(os.path.join(folder, "model.bin"))


def _local_dir(name):
    """Where the model is on this computer, or None. Our own download first,
    then a copy faster-whisper already put in the Hugging Face cache."""
    own = os.path.join(MODELS_DIR, name)
    if _complete(own):
        return own
    repo = MODELS[name]["repo"].replace("/", "--")
    for snap in glob.glob(os.path.join(HF_CACHE, f"models--{repo}", "snapshots", "*")):
        if _complete(snap):
            return snap
    return None


def _repo_files(repo):
    """[(path, size)] of the files a model needs. requests follows the redirect
    when a repository has moved (large-v3-turbo has)."""
    r = requests.get(f"{HF}/api/models/{repo}/tree/main", timeout=30)
    r.raise_for_status()
    return [(f["path"], f.get("size") or 0) for f in r.json()
            if f.get("type") == "file" and f["path"].startswith(WANTED)]


def _download(name):
    """Fetch the model into MODELS_DIR/<name>, reporting bytes as they arrive.
    Files land in <name>.part and the folder is renamed only once every file is
    in, so a half-downloaded model is never mistaken for a complete one. A
    partial file is resumed with an HTTP range request."""
    repo = MODELS[name]["repo"]
    files = _repo_files(repo)
    total = sum(size for _, size in files)
    part = os.path.join(MODELS_DIR, name + ".part")
    os.makedirs(part, exist_ok=True)
    done = 0
    _set(state="downloading", done=0, total=total)
    for path, size in files:
        target = os.path.join(part, path)
        if os.path.isfile(target) and os.path.getsize(target) == size:
            done += size
            _set(done=done)
            continue
        tmp = target + ".tmp"
        have = os.path.getsize(tmp) if os.path.isfile(tmp) else 0
        if size and have >= size:  # fully fetched before the break, never renamed
            os.replace(tmp, target)
            done += size
            _set(done=done)
            continue
        headers = {"Range": f"bytes={have}-"} if have else {}
        _set(done=done + have)  # the bar carries on from where it broke off
        with requests.get(f"{HF}/{repo}/resolve/main/{path}", headers=headers,
                          stream=True, timeout=60) as r:
            r.raise_for_status()
            if r.status_code != 206:   # the server sent it whole: start over
                have = 0
            done += have
            _set(done=done)
            with open(tmp, "ab" if have else "wb") as f:
                for chunk in r.iter_content(chunk_size=1 << 20):
                    f.write(chunk)
                    done += len(chunk)
                    _set(done=done)
        os.replace(tmp, target)
    final = os.path.join(MODELS_DIR, name)
    if os.path.isdir(final):
        shutil.rmtree(final)
    os.replace(part, final)
    return final


def _use(name):
    """Background job: download the model if needed, then load it. The model in
    use keeps serving /asr until the new one is ready."""
    global _model, _job
    try:
        folder = _local_dir(name) or _download(name)
        _set(state="loading")
        # int8 keeps it fast and light on CPU.
        model = WhisperModel(folder, device="cpu", compute_type="int8")
        with _lock:
            _model = model
            _state.update(model=name, state="ready", error=None)
    except Exception as e:  # shown to the user, who can retry
        _set(state="error", error=str(e))
    finally:
        with _lock:
            _job = None


def _start(name):
    global _job
    with _lock:
        if _job == name or (_state["model"] == name and _state["state"] == "ready"):
            return
        if _job is not None:
            raise HTTPException(409, f"busy with {_job}")
        _job = name
        _state.update(error=None, done=0, total=0)
    threading.Thread(target=_use, args=(name,), daemon=True).start()


@app.get("/")
def root():
    return {"status": "ok", "model": _state["model"]}


@app.get("/status")
def status():
    with _lock:
        s = dict(_state, job=_job)
    s["models"] = {n: {"installed": _local_dir(n) is not None, "size": m["size"]}
                   for n, m in MODELS.items()}
    return s


@app.post("/use")
def use(name: str = Query(...)):
    if name not in MODELS:
        raise HTTPException(400, f"unknown model {name}")
    _start(name)
    return status()


@app.post("/asr")
def asr(
    audio_file: UploadFile = File(...),
    encode: str = Query(None),
    task: str = Query("transcribe"),
    output: str = Query("json"),
    language: str = Query(None),
):
    """Transcribe uploaded audio: text + segments (+ language), the shape of the
    whisper-asr-webservice. A plain (not async) handler, so FastAPI runs it in a
    worker thread and /status keeps answering during a long transcription."""
    model = _model
    if model is None:
        raise HTTPException(503, "speech model is not ready")
    data = audio_file.file.read()
    # faster-whisper decodes via PyAV, which handles webm/opus/wav from a path.
    with tempfile.NamedTemporaryFile(delete=False, suffix=".bin") as tmp:
        tmp.write(data)
        path = tmp.name
    try:
        segments, info = model.transcribe(
            path,
            task=task or "transcribe",
            language=language or None,
            vad_filter=True,  # skip silence -> honest empty result on no speech
        )
        segs, parts = [], []
        for s in segments:
            segs.append({
                "id": len(segs),
                "start": round(s.start, 3),
                "end": round(s.end, 3),
                "text": s.text,
            })
            parts.append(s.text)
        return {
            "text": "".join(parts).strip(),
            "segments": segs,
            "language": info.language,
        }
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


if __name__ == "__main__":
    import uvicorn
    # Ready at once if the model is already here; otherwise the app asks for it.
    if START_MODEL in MODELS and _local_dir(START_MODEL):
        _start(START_MODEL)
    uvicorn.run(app, host="127.0.0.1", port=PORT)
