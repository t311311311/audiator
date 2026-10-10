// Starts the local backend for development runs.
//
// In development the transcription, translation and auth services run on this
// machine, and having to start them by hand before every `npm start` was a
// constant source of "connect ECONNREFUSED 127.0.0.1:3000". The app now brings
// up whatever is not already listening and shuts it down again on quit.
//
// Packaged builds skip all of this. The speech engine is not started here:
// it runs on the user's computer in every build, see engine.js.
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');

// Translation now runs in the engine too (translator.py), so LibreTranslate is
// no longer started.
const SERVICES = [
  { name: 'auth-gateway', port: 3000, script: 'main.py' },
];

const children = [];

/** Resolve to true if something is already listening on the port. */
function portOpen(port, timeout = 700) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * Start any service that is not already running.
 * Returns true once the gateway answers, which is what the app talks to.
 */
async function startLocalBackend(rootDir) {
  const venvScripts = path.join(rootDir, '.venv', 'Scripts');
  const python = path.join(venvScripts, 'python.exe');
  const authDir = path.join(rootDir, 'auth-server');

  if (!fs.existsSync(python)) {
    console.error(`[backend] no venv at ${python} — start the services manually`);
    return false;
  }

  for (const svc of SERVICES) {
    if (await portOpen(svc.port)) {
      console.log(`[backend] ${svc.name} already listening on ${svc.port}`);
      // A payment test once ran at the real prices this way, unnoticed (AUD-55).
      if (svc.port === 3000 && (process.env.PRICE_MONTH || process.env.PRICE_YEAR)) {
        console.warn('[backend] PRICE_MONTH / PRICE_YEAR are NOT applied: that server keeps the prices it was started with. '
          + 'Quit Audiator (menu -> Exit) and start again.');
      }
      continue;
    }
    const command = svc.exe ? path.join(venvScripts, svc.exe) : python;
    const args = svc.exe ? svc.args : [svc.script];
    if (!fs.existsSync(command)) {
      console.error(`[backend] ${svc.name} not installed (${command}) — skipping`);
      continue;
    }
    console.log(`[backend] starting ${svc.name} on ${svc.port}`);
    const child = spawn(command, args, {
      cwd: svc.exe ? rootDir : authDir,
      windowsHide: true,
      // UTF-8 so Russian output in the logs is readable. MAIL_DEV_PRINT: until
      // the mailbox's password is in auth-server/.env, the sign-in code is
      // printed here (a real server never does that).
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', MAIL_DEV_PRINT: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => process.stdout.write(`[${svc.name}] ${d}`));
    child.stderr.on('data', (d) => process.stderr.write(`[${svc.name}] ${d}`));
    child.on('exit', (code) => console.log(`[backend] ${svc.name} exited (${code})`));
    children.push(child);
  }

  const ready = await waitForPort(3000, 45000);
  console.log(ready ? '[backend] gateway is up' : '[backend] gateway did not start in time');
  return ready;
}

/** Kill the services this process started; anything started by hand is left alone. */
function stopLocalBackend() {
  for (const child of children) {
    try { child.kill(); } catch (e) { /* already gone */ }
  }
  children.length = 0;
}

module.exports = { startLocalBackend, stopLocalBackend, portOpen, waitForPort };
