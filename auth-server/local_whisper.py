# -*- coding: utf-8 -*-
"""The speech engine: a small local web service around faster-whisper.

Runs on the user's own computer — the app sends audio here and the voice never
leaves the machine. Exposes ``/asr`` in the shape of the whisper-asr-webservice
(text + segments + language). The installed app ships it frozen into
whisper-server.exe (``npm run build:engine``) and starts it itself
(src/engine.js); development runs this script from the .venv.

Run:  python local_whisper.py   (listens on 127.0.0.1:8000)
Env:  WHISPER_MODEL (default 'small'), WHISPER_PORT (default 8000),
      WHISPER_MODELS_DIR (default: the Hugging Face cache)
"""
import os
import tempfile

from fastapi import FastAPI, UploadFile, File, Query
from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")
PORT = int(os.environ.get("WHISPER_PORT", "8000"))
# Where models are kept. The installed app points this at the user's app data;
# unset, faster-whisper uses the default Hugging Face cache.
MODELS_DIR = os.environ.get("WHISPER_MODELS_DIR") or None

app = FastAPI(title="Local Whisper Shim")
# int8 keeps it fast and light on CPU; the model downloads once and is cached.
_model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8", download_root=MODELS_DIR)


@app.get("/")
def root():
    return {"status": "ok", "model": MODEL_NAME}


@app.post("/asr")
async def asr(
    audio_file: UploadFile = File(...),
    encode: str = Query(None),
    task: str = Query("transcribe"),
    output: str = Query("json"),
    language: str = Query(None),
):
    """Transcribe uploaded audio. Returns the same JSON shape the gateway and
    client expect from the whisper-asr-webservice: text + segments (+ language).
    The last segment's ``end`` is what the AUD-13 quota bills against."""
    data = await audio_file.read()
    # faster-whisper decodes via PyAV, which handles webm/opus/wav from a path.
    with tempfile.NamedTemporaryFile(delete=False, suffix=".bin") as tmp:
        tmp.write(data)
        path = tmp.name
    try:
        segments, info = _model.transcribe(
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
    uvicorn.run(app, host="127.0.0.1", port=PORT)
