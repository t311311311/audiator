// The speech-recognition engine: faster-whisper behind a small local web
// service (auth-server/local_whisper.py) running on the user's own computer.
//
// Packaged builds ship it frozen into "Audiator Engine.exe" (PyInstaller, see
// scripts/build-engine.js) under resources/engine and start it here;
// development runs the same script from the project's .venv. Either way the
// app sends audio straight to it — the voice never leaves the computer, and
// no server is needed to transcribe.
//
// Starting is not awaited at app start-up: the model takes a while to load
// (and on a first run to download), so transcribe() waits for whenReady().
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { portOpen, waitForPort } = require('./local-backend');

const ENGINE_EXE = 'Audiator Engine.exe';
const DEV_PORT = 8000;               // the port a hand-started service uses
const READY_TIMEOUT_MS = 15 * 60e3;  // a first run downloads the model first

let child = null;
let ready = null; // Promise<string|null>: the engine's base URL once it answers

/** A port nobody is listening on, for a packaged build. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Where the engine is and how to run it, or null if it is missing. */
function locate({ packaged, rootDir }) {
  const frozen = (exe) => ({ command: exe, args: [], cwd: path.dirname(exe) });
  if (packaged) {
    const exe = path.join(process.resourcesPath, 'engine', ENGINE_EXE);
    return fs.existsSync(exe) ? frozen(exe) : null;
  }
  // Development: the live script, or the frozen build to try it before
  // packaging (AUDIATOR_ENGINE=built, after `npm run build:engine`).
  const built = path.join(rootDir, 'build', 'engine', 'Audiator Engine', ENGINE_EXE);
  if (process.env.AUDIATOR_ENGINE === 'built' && fs.existsSync(built)) return frozen(built);
  const python = path.join(rootDir, '.venv', 'Scripts', 'python.exe');
  if (!fs.existsSync(python)) return null;
  return { command: python, args: ['local_whisper.py'], cwd: path.join(rootDir, 'auth-server') };
}

/**
 * Start the engine unless one already answers. Development keeps the fixed
 * port 8000, so a service started by hand is reused; a packaged build takes
 * any free port. Downloaded models go to modelsDir (the user's app data);
 * `model` is loaded straight away if it is already on this computer.
 */
function startEngine({ packaged, rootDir, modelsDir, model = 'small' }) {
  ready = (async () => {
    const port = packaged ? await freePort() : DEV_PORT;
    const url = `http://127.0.0.1:${port}`;
    if (!packaged && await portOpen(port)) {
      console.log(`[engine] already listening on ${port}`);
      return url;
    }
    const where = locate({ packaged, rootDir });
    if (!where) {
      console.error('[engine] speech engine not found — transcription is unavailable');
      return null;
    }
    const env = {
      ...process.env,
      WHISPER_PORT: String(port),
      WHISPER_MODEL: model,
      PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', // readable Russian in the logs
    };
    env.WHISPER_MODELS_DIR = modelsDir;
    console.log(`[engine] starting ${path.basename(where.command)} on ${port}`);
    child = spawn(where.command, where.args, {
      cwd: where.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => process.stdout.write(`[engine] ${d}`));
    child.stderr.on('data', (d) => process.stderr.write(`[engine] ${d}`));
    child.on('exit', (code) => { console.log(`[engine] exited (${code})`); child = null; });

    const up = await waitForPort(port, READY_TIMEOUT_MS);
    console.log(up ? `[engine] ready on ${port}` : '[engine] did not start in time');
    return up ? url : null;
  })();
  return ready;
}

/** The engine's base URL once it answers, or null if it could not start. */
function whenReady() {
  return ready || Promise.resolve(null);
}

// --- The model ----------------------------------------------------------------
// The engine downloads and loads models itself (see local_whisper.py); the app
// says which one to use and watches its progress, passing every change on to
// the windows (a progress bar in the main window, the list in Settings).

let status = null;        // the engine's last /status
let wanted = null;        // the model the user chose
let declined = false;     // the user stopped the download and has no model yet
let poller = null;
const listeners = new Set();

// The speech model is downloading or loading.
const modelBusy = (s) => !!s && (s.job || s.state === 'downloading' || s.state === 'loading');
// ...or a translation language is being installed: either keeps the poller on.
const busy = (s) => modelBusy(s) || !!(s && s.translate && s.translate.job);

// Every status the windows see also says whether the user turned the download
// down, so the main window can offer to download instead of looking stuck.
function setStatus(s) {
  status = { ...s, declined: declined && !s.model };
  for (const cb of listeners) cb(status);
}

/** Call cb with every status change: { model, state, done, total, error, job, models }. */
function onStatus(cb) { listeners.add(cb); }

/** The last known status (null until the engine has answered). */
function currentStatus() { return status; }

async function fetchStatus() {
  const base = await whenReady();
  if (!base) {
    setStatus({ model: null, state: 'error', error: 'Speech engine is not running', job: null, models: {} });
    return status;
  }
  const r = await fetch(`${base}/status`);
  if (r.status === 404) {
    // An older engine started by hand (development): one fixed model, always
    // loaded, no downloads.
    setStatus({ model: 'fixed', state: 'ready', error: null, job: null, models: {} });
    return status;
  }
  setStatus(await r.json());
  return status;
}

// Poll while the engine is busy, so the progress bar moves. When it settles on
// a model other than the one the user chose since (a choice made while another
// download was running), ask for that one next.
function watch() {
  if (poller) return;
  poller = setInterval(async () => {
    try {
      const s = await fetchStatus();
      if (busy(s)) return;
      clearInterval(poller); poller = null;
      if (wanted && s.model !== wanted && s.state !== 'error') useModel(wanted);
    } catch (e) {
      console.error('[engine] status', e.message);
    }
  }, 500);
}

/** Switch to a model: the engine downloads it if needed, then loads it. */
async function useModel(name) {
  wanted = name;
  declined = false;
  const base = await whenReady();
  if (!base) return fetchStatus();
  try {
    const r = await fetch(`${base}/use?name=${encodeURIComponent(name)}`, { method: 'POST' });
    if (r.status !== 409) setStatus(await r.json()); // 409: busy with another, picked up by watch()
  } catch (e) {
    console.error('[engine] use', e.message);
  }
  watch();
  return status;
}

/**
 * Stop the download in progress. The model in use (if any) stays, and becomes
 * the one wanted again — resolves to its name (null if there is none).
 */
async function cancelDownload() {
  wanted = null; // or watch() would ask for it again the moment the engine settles
  const base = await whenReady();
  if (!base) return null;
  const r = await fetch(`${base}/cancel`, { method: 'POST' });
  setStatus(await r.json());
  // The engine stops at its next chunk; wait for it to settle.
  for (let i = 0; i < 50 && modelBusy(status); i++) {
    await new Promise((res) => setTimeout(res, 200));
    await fetchStatus();
  }
  wanted = status.model;
  declined = !status.model;
  setStatus(status);
  return status.model;
}

/** Remove a downloaded model (not the one in use) to free disk space. */
async function deleteModel(name) {
  const base = await whenReady();
  if (!base) return status;
  const r = await fetch(`${base}/delete?name=${encodeURIComponent(name)}`, { method: 'POST' });
  if (r.ok) setStatus(await r.json());
  return status;
}

/**
 * The engine's URL once a model is loaded, for transcribing. Waits through a
 * download or load (a recording made meanwhile is transcribed once it is
 * done); throws if there is no model and none on the way.
 */
async function whenModelReady() {
  const base = await whenReady();
  if (!base) throw new Error('Speech engine is not running');
  for (;;) {
    const s = await fetchStatus();
    if (s.model) return base;        // a model serves even while another downloads
    if (!modelBusy(s)) throw new Error(s.error || 'Speech model is not ready');
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// --- Translation on demand (translator.py in the engine) ---------------------
// Languages are installed one at a time, as pairs with English; their state
// arrives with every status (status.translate) like the model's.

async function call(pathAndQuery, options) {
  const base = await whenReady();
  if (!base) throw new Error('Speech engine is not running');
  return fetch(base + pathAndQuery, options);
}

/**
 * Translate text on this computer. Throws an error with .missing set to the
 * language code to install first, when source or target is not installed.
 */
async function translateText(q, source, target) {
  const r = await call('/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, source, target }),
  });
  if (r.status === 409) {
    const body = await r.json();
    const err = new Error('Translation language is not installed');
    err.missing = body.detail && body.detail.missing;
    throw err;
  }
  if (!r.ok) throw new Error(`${r.status} - ${await r.text()}`);
  return (await r.json()).translatedText;
}

let catalog = null;
/** Every language on offer: [{ code, name, size }] (fixed, so fetched once). */
async function translateCatalog() {
  if (!catalog) catalog = await (await call('/translate/catalog')).json();
  return catalog;
}

async function installLanguage(code) {
  const r = await call(`/translate/install?code=${encodeURIComponent(code)}`, { method: 'POST' });
  if (r.ok) setStatus(await r.json());
  watch();
  return status;
}

/** Stop the current download, or (with a code) take a language out of the queue. */
async function cancelLanguage(code) {
  const query = code ? `?code=${encodeURIComponent(code)}` : '';
  setStatus(await (await call(`/translate/cancel${query}`, { method: 'POST' })).json());
  watch();
  return status;
}

async function deleteLanguage(code) {
  const r = await call(`/translate/delete?code=${encodeURIComponent(code)}`, { method: 'POST' });
  if (r.ok) setStatus(await r.json());
  return status;
}

/** Stop the engine this app started; one started by hand is left alone. */
function stopEngine() {
  if (poller) { clearInterval(poller); poller = null; }
  if (!child) return;
  try { child.kill(); } catch (e) { /* already gone */ }
  child = null;
}

module.exports = {
  startEngine, whenReady, stopEngine,
  useModel, cancelDownload, deleteModel, whenModelReady, onStatus, currentStatus, fetchStatus,
  translateText, translateCatalog, installLanguage, cancelLanguage, deleteLanguage,
};
