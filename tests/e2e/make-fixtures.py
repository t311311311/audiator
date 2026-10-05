# -*- coding: utf-8 -*-
"""Makes what the stands in tests/e2e need beside fixtures/test-ru.wav (kept in git):

  fixtures/long-ru.wav   the test phrase 8 times with pauses (~59 s), for progress
  fixtures/test-ru.webm  the same as webm/opus, as the microphone records it
  fixtures/res/engine    a junction to build/engine/Audiator Engine, so engine.js
                         finds the built engine as a packaged app would

Run from the repo root with the dev venv (needs PyAV, which only dev has):
  .venv\\Scripts\\python.exe tests\\e2e\\make-fixtures.py
"""
import os
import subprocess
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")
ROOT = os.path.dirname(os.path.dirname(HERE))

src = wave.open(os.path.join(FIX, "test-ru.wav"), "rb")
params, frames = src.getparams(), src.readframes(src.getnframes())
silence = b"\x00" * (params.sampwidth * params.nchannels * params.framerate // 2)
with wave.open(os.path.join(FIX, "long-ru.wav"), "wb") as out:
    out.setparams(params)
    for _ in range(8):
        out.writeframes(frames + silence)
print("long-ru.wav")

try:
    import av
    inp = av.open(os.path.join(FIX, "test-ru.wav"))
    out = av.open(os.path.join(FIX, "test-ru.webm"), "w", format="webm")
    st = out.add_stream("libopus", rate=48000)
    st.layout = "mono"
    res = av.AudioResampler(format="s16", layout="mono", rate=48000)
    for frame in inp.decode(audio=0):
        for f in res.resample(frame):
            for p in st.encode(f):
                out.mux(p)
    for p in st.encode(None):
        out.mux(p)
    out.close()
    print("test-ru.webm")
except ImportError:
    print("test-ru.webm skipped (no PyAV in this Python)")

res = os.path.join(FIX, "res")
os.makedirs(res, exist_ok=True)
link = os.path.join(res, "engine")
if not os.path.exists(link):
    subprocess.run(["cmd", "/c", "mklink", "/J", link, os.path.join(ROOT, "build", "engine", "Audiator Engine")], check=False)
print("res/engine ->", os.path.join(ROOT, "build", "engine", "Audiator Engine"))
