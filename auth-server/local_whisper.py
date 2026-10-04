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
  POST /cancel  stop the download in progress (the partial files are removed)
  POST /delete  remove a downloaded model (not the one in use)
  POST /asr     transcribe audio — the whisper-asr-webservice shape
                (text + segments + language)
  POST /asr/start, GET /asr/job?id=  the same as a job: answers at once, then
                says how far it has got (seconds done of the recording's
                length) until the result is there. The app uses this: a long
                recording on a slow computer takes minutes, longer than an
                HTTP request is kept waiting, and the user sees the progress.
  POST /translate, GET /translate/catalog, POST /translate/install|cancel|delete
                translation on demand (translator.py); its state is in /status

Run:  python local_whisper.py   (listens on 127.0.0.1:8000)
Env:  WHISPER_PORT (default 8000)
      WHISPER_MODEL  model to load at start if it is already on this computer
      WHISPER_MODELS_DIR  where downloaded models go
                          (default: %APPDATA%\\audiator\\models)
"""
import glob
import os
import shutil
import sys
import tempfile
import threading
import types
import wave

import numpy as np
import requests
from fastapi import FastAPI, File, HTTPException, Query, UploadFile

# Reading audio. faster-whisper reads files through PyAV, whose FFmpeg build
# carries x264 under the GPL: shipped inside a closed program it would oblige
# us to publish the program's source. The app now sends a plain 16 kHz WAV,
# read here with Python's own wave module, so the installed engine leaves
# PyAV out (build-engine.js) and faster-whisper, which imports it at start,
# gets this stand-in. In development the real PyAV is still there and reads
# anything else (an older app's recordings).
try:
    import av  # noqa: F401
    HAVE_AV = True
except ImportError:
    sys.modules["av"] = types.ModuleType("av")
    HAVE_AV = False

from faster_whisper import WhisperModel  # noqa: E402
from pydantic import BaseModel

import translator

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
_cancel = threading.Event()  # the user stopped the download


class _Cancelled(Exception):
    pass


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
                    if _cancel.is_set():
                        raise _Cancelled()
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
    except _Cancelled:
        # The user does not want it: free the space, carry on as before.
        shutil.rmtree(os.path.join(MODELS_DIR, name + ".part"), ignore_errors=True)
        _set(state="ready" if _model else "idle", error=None, done=0, total=0)
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
        _cancel.clear()
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
    s["translate"] = translator.status()
    return s


@app.post("/use")
def use(name: str = Query(...)):
    if name not in MODELS:
        raise HTTPException(400, f"unknown model {name}")
    _start(name)
    return status()


@app.post("/cancel")
def cancel():
    """Stop the download in progress; the partial files are removed and the
    model in use (if any) stays. Loading, which is quick, is not interrupted."""
    with _lock:
        if _job is not None and _state["state"] == "downloading":
            _cancel.set()
    return status()


@app.post("/delete")
def delete(name: str = Query(...)):
    """Remove a downloaded model to free disk space — from our folder and from
    the Hugging Face cache. Not the one in use, nor one being downloaded."""
    if name not in MODELS:
        raise HTTPException(400, f"unknown model {name}")
    with _lock:
        if name == _state["model"] or name == _job:
            raise HTTPException(409, f"{name} is in use")
    for folder in (os.path.join(MODELS_DIR, name), os.path.join(MODELS_DIR, name + ".part"),
                   os.path.join(HF_CACHE, "models--" + MODELS[name]["repo"].replace("/", "--"))):
        shutil.rmtree(folder, ignore_errors=True)
    return status()


# --- Translation (translator.py) ---------------------------------------------

class TranslateRequest(BaseModel):
    q: str
    source: str
    target: str


@app.post("/translate")
def translate(req: TranslateRequest):
    """Translate text between installed languages (through English if needed).
    409 names the language that has to be installed first."""
    try:
        return {"translatedText": translator.translate(req.q, req.source, req.target)}
    except LookupError as e:
        raise HTTPException(409, {"missing": str(e.args[0])})


@app.get("/translate/catalog")
def translate_catalog():
    return translator.catalog()


@app.post("/translate/install")
def translate_install(code: str = Query(...)):
    if code not in translator.CATALOG:
        raise HTTPException(400, f"unknown language {code}")
    if not translator.start_install(code):
        raise HTTPException(409, "another language is being installed")
    return status()


@app.post("/translate/cancel")
def translate_cancel(code: str = Query(None)):
    """Stop the current download, or (with code) take a language out of the queue."""
    translator.cancel(code)
    return status()


@app.post("/translate/delete")
def translate_delete(code: str = Query(...)):
    try:
        translator.delete(code)
    except KeyError:
        raise HTTPException(400, f"unknown language {code}")
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    return status()


def _save_upload(audio_file: UploadFile) -> str:
    # faster-whisper decodes via PyAV, which handles webm/opus/wav from a path.
    with tempfile.NamedTemporaryFile(delete=False, suffix=".bin") as tmp:
        tmp.write(audio_file.file.read())
        return tmp.name


def _read_audio(path):
    """The recording as 16 kHz mono samples, from the WAV the app sends; for
    anything else the path itself (faster-whisper reads it with PyAV, which
    only a development setup has)."""
    with open(path, "rb") as f:
        head = f.read(12)
    if head[:4] != b"RIFF" or head[8:12] != b"WAVE":
        if not HAVE_AV:
            raise ValueError("this engine reads WAV recordings only (16-bit); update the app")
        return path
    with wave.open(path, "rb") as w:
        channels, width, rate, frames = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(frames)
    if width != 2:
        raise ValueError(f"expected 16-bit PCM WAV, got {8 * width}-bit")
    audio = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if rate != 16000 and len(audio):
        n = int(round(len(audio) * 16000 / rate))
        audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)
    return audio


def _transcribe(model, path, task, language, progress=None):
    """Text + segments + language + duration. progress(done, total) is told
    after every piece, in seconds of the recording."""
    try:
        segments, info = model.transcribe(
            _read_audio(path),
            task=task or "transcribe",
            language=language or None,
            vad_filter=True,  # skip silence -> honest empty result on no speech
        )
        total = float(getattr(info, "duration", 0) or 0)
        if progress:
            progress(0.0, total)
        segs, parts = [], []
        for s in segments:
            segs.append({
                "id": len(segs),
                "start": round(s.start, 3),
                "end": round(s.end, 3),
                "text": s.text,
            })
            parts.append(s.text)
            if progress:
                progress(min(float(s.end), total), total)
        return {
            "text": "".join(parts).strip(),
            "segments": segs,
            "language": info.language,
            # Length of the recording: what counts against the free minutes.
            "duration": round(total, 2),
        }
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


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
    return _transcribe(model, _save_upload(audio_file), task, language)


# Transcriptions as jobs (see the top of this file). Kept until the app has
# fetched the result; a job nobody asks about again goes after an hour.
_jobs = {}
_jobs_lock = threading.Lock()


def _run_job(job_id, model, path, task, language):
    def progress(done, total):
        with _jobs_lock:
            _jobs[job_id].update(done=round(done, 1), total=round(total, 1))
    try:
        result = _transcribe(model, path, task, language, progress)
        with _jobs_lock:
            _jobs[job_id].update(state="done", result=result)
    except Exception as e:  # noqa: BLE001 — told to the app, which shows it
        with _jobs_lock:
            _jobs[job_id].update(state="error", error=str(e))


@app.post("/asr/start")
def asr_start(
    audio_file: UploadFile = File(...),
    task: str = Query("transcribe"),
    language: str = Query(None),
):
    model = _model
    if model is None:
        raise HTTPException(503, "speech model is not ready")
    import time
    import uuid
    path = _save_upload(audio_file)
    job_id = uuid.uuid4().hex
    with _jobs_lock:
        now = time.time()
        for k in [k for k, j in _jobs.items() if now - j["created"] > 3600]:
            del _jobs[k]
        _jobs[job_id] = {"state": "running", "done": 0.0, "total": 0.0, "created": now}
    threading.Thread(target=_run_job, args=(job_id, model, path, task, language), daemon=True).start()
    return {"id": job_id}


@app.get("/asr/job")
def asr_job(id: str = Query(...)):
    """{state: running, done, total} — or done with the result, or error;
    a finished job is handed over once and forgotten."""
    with _jobs_lock:
        job = _jobs.get(id)
        if job is None:
            raise HTTPException(404, "no such job")
        out = {k: v for k, v in job.items() if k != "created"}
        if job["state"] != "running":
            del _jobs[id]
    return out


if __name__ == "__main__":
    import uvicorn
    # Ready at once if the model is already here; otherwise the app asks for it.
    if START_MODEL in MODELS and _local_dir(START_MODEL):
        _start(START_MODEL)
    uvicorn.run(app, host="127.0.0.1", port=PORT)
