// The speech-recognition engine: faster-whisper behind a small local web
// service (auth-server/local_whisper.py) running on the user's own computer.
//
// Packaged builds ship it frozen into whisper-server.exe (PyInstaller, see
// scripts/build-engine.js) under resources/whisper-server and start it here;
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
    const exe = path.join(process.resourcesPath, 'whisper-server', 'whisper-server.exe');
    return fs.existsSync(exe) ? frozen(exe) : null;
  }
  // Development: the live script, or the frozen build to try it before
  // packaging (AUDIATOR_ENGINE=built, after `npm run build:engine`).
  const built = path.join(rootDir, 'build', 'engine', 'whisper-server', 'whisper-server.exe');
  if (process.env.AUDIATOR_ENGINE === 'built' && fs.existsSync(built)) return frozen(built);
  const python = path.join(rootDir, '.venv', 'Scripts', 'python.exe');
  if (!fs.existsSync(python)) return null;
  return { command: python, args: ['local_whisper.py'], cwd: path.join(rootDir, 'auth-server') };
}

/**
 * Start the engine unless one already answers. Development keeps the fixed
 * port 8000, so a service started by hand is reused; a packaged build takes
 * any free port. Models are kept in modelsDir when given (packaged: the
 * user's app data), otherwise in the default Hugging Face cache.
 */
function startEngine({ packaged, rootDir, modelsDir = null, model = 'small' }) {
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
    if (modelsDir) env.WHISPER_MODELS_DIR = modelsDir;
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

/** Stop the engine this app started; one started by hand is left alone. */
function stopEngine() {
  if (!child) return;
  try { child.kill(); } catch (e) { /* already gone */ }
  child = null;
}

module.exports = { startEngine, whenReady, stopEngine };
