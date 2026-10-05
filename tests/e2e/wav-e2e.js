// Scratch: the real app signed in and left alone — which of its processes use
// CPU, and which pages keep animations running.
const { spawn, execSync } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os');
const ROOT = 'C:/Test01/tray-translator';
const PORT = 3111, DBG = 9336;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-idle-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server, appProc, serverLog = '';
const done = (c) => { try { appProc.kill(); } catch (e) {} try { server.kill(); } catch (e) {} process.exit(c); };
setTimeout(() => { console.log('timeout'); done(2); }, 150000);

async function targets() { try { return await (await fetch(`http://127.0.0.1:${DBG}/json`)).json(); } catch (e) { return []; } }
function connect(url) {
  const ws = new WebSocket(url); let id = 0; const wait = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  return new Promise((res) => ws.onopen = () => res({ js: async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.result.value }));
}
async function page(file) {
  for (let i = 0; i < 80; i++) {
    const t = (await targets()).find((x) => x.type === 'page' && x.url.split('?')[0].endsWith('/' + file));
    if (t) return connect(t.webSocketDebuggerUrl);
    await sleep(250);
  }
  throw new Error('no ' + file);
}
function cpuOf(pids) {
  const out = execSync(`powershell -NoProfile -Command "Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | % { '{0} {1}' -f $_.Id, $_.CPU }"`).toString();
  return Object.fromEntries(out.trim().split(/\r?\n/).map((l) => l.trim().split(' ')).map(([i, c]) => [i, parseFloat(c.replace(',', '.'))]));
}
function tree(rootPid) {
  const out = execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='electron.exe'\\" | % { '{0}|{1}|{2}' -f $_.ProcessId, $_.ParentProcessId, $_.CommandLine }"`).toString();
  const rows = out.trim().split(/\r?\n/).map((l) => l.split('|'));
  const kids = rows.filter((r) => r[1] === String(rootPid));
  return [[String(rootPid), 'main'], ...kids.map((r) => [r[0], (r[2].match(/--type=([a-z-]+)/) || [])[1] || '?'])];
}
async function measure(label, pids) {
  const a = cpuOf(pids.map((p) => p[0])); await sleep(10000); const b = cpuOf(pids.map((p) => p[0]));
  console.log(label + ': ' + pids.map(([p, t]) => `${t}=${((b[p] - a[p]) * 10).toFixed(0)}%`).join(' '));
}

(async () => {
  server = spawn(path.join(ROOT, '.venv/Scripts/python.exe'), ['-m', 'uvicorn', 'main:app', '--port', String(PORT)], {
    cwd: path.join(ROOT, 'auth-server'), windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', SMTP_HOST: '', MAIL_DEV_PRINT: '1',
           ACCOUNTS_DATABASE_URL: 'sqlite:///' + path.join(tmp, 'a.db').split(path.sep).join('/') } });
  server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 100 && !/Uvicorn running/.test(serverLog); i++) await sleep(200);
  appProc = spawn(path.join(ROOT, 'node_modules/electron/dist/electron.exe'), [`--remote-debugging-port=${DBG}`, path.join(__dirname, 'app-launcher.js')],
    { cwd: ROOT, env: { ...process.env, AUD_TEST_USERDATA: path.join(tmp, 'ud'), AUDIATOR_ACCOUNTS_URL: `http://127.0.0.1:${PORT}`, AUDIATOR_ENGINE_PORT: '8010' } });
  let appLog = ''; appProc.stdout.on('data', (d) => { appLog += d; });
  const login = await page('login.html'); await sleep(800);
  await login.js(`document.getElementById('email').value = 'long@example.com'; document.getElementById('accept').click(); document.getElementById('get-code').click();`);
  let code; for (let i = 0; i < 50 && !(code = (serverLog.match(/sign-in code for long@example\.com: (\d{6})/) || [])[1]); i++) await sleep(100);
  await login.js(`const c = document.getElementById('code'); c.value = '${code}'; c.dispatchEvent(new Event('input'));`);
  const main = await page('index.html'); await sleep(2000);
  const wav = fs.readFileSync(path.join(__dirname, 'fixtures', 'test-ru.wav')).toString('base64');
  main.js(`0`); // (wake)
  const step = (label, code, ms = 30000) => Promise.race([main.js(code), sleep(ms).then(() => 'TIMEOUT')]).then((v) => { console.log(label, JSON.stringify(v)); return v; });
  await main.js(`window.__b64 = '${wav}'; 0`);
  // A "microphone": the test speech (16-bit WAV parsed here, no decoding API) played into a stream.
  await step('stream:', `(async () => {
    const raw = atob(window.__b64); const b = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) b[i] = raw.charCodeAt(i);
    const dv = new DataView(b.buffer); const rate = dv.getUint32(24, true); let off = 12, dataAt = 0, dataLen = 0;
    while (off < b.length - 8) { const id = String.fromCharCode(b[off], b[off+1], b[off+2], b[off+3]); const len = dv.getUint32(off + 4, true); if (id === 'data') { dataAt = off + 8; dataLen = len; break; } off += 8 + len; }
    const n = dataLen / 2; const ctx = new AudioContext(); await ctx.resume();
    const buf = ctx.createBuffer(1, n, rate); const ch = buf.getChannelData(0); for (let i = 0; i < n; i++) ch[i] = dv.getInt16(dataAt + 2 * i, true) / 32768;
    const src = ctx.createBufferSource(); src.buffer = buf; const dst = ctx.createMediaStreamDestination(); src.connect(dst);
    window.__mic = { ctx, src, stream: dst.stream, seconds: n / rate }; return { rate, seconds: n / rate, state: ctx.state };
  })()`);
  await step('capture during playback:', `(async () => {
    const cap = await startPcmCapture(window.__mic.stream);
    window.__mic.src.start(); await new Promise((r) => window.__mic.src.onended = r);
    window.__wav = await cap.finish();
    return { bytes: window.__wav.size, seconds: (window.__wav.size - 44) / 32000 };
  })()`);
  const r = await step('transcribe:', `window.api.transcribe(window.__wav, undefined, true).then((res) => ({ ok: res.success, text: (res.text || res.error || '').slice(0, 70), type: window.__wav.type, rate: 16000 }))`);
  console.log(JSON.stringify(r));
  const ok = r.ok && r.type === 'audio/wav' && r.rate === 16000 && /Привет/.test(r.text);
  console.log(ok ? 'ALL PASS' : 'FAILED');
  done(ok ? 0 : 1);
})().catch((e) => { console.log('ERROR', e); done(1); });
