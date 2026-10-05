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
  require('child_process').execFileSync(path.join(ROOT, '.venv/Scripts/python.exe'), ['-c',
    "import sqlite3,datetime,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"update users set window_start=?, window_used=7195\", (datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None).isoformat(' '),)); c.commit()",
    path.join(tmp, 'a.db')]);
  await login.js(`const c = document.getElementById('code'); c.value = '${code}'; c.dispatchEvent(new Event('input'));`);
  const main = await page('index.html'); await sleep(2000);
  const v0 = await main.js('window.api.getAccount()');
  console.log('left at the start:', v0.remaining, 's');
  const wav = fs.readFileSync(path.join(__dirname, 'fixtures', 'test-ru.wav')).toString('base64');
  await main.js(`window.__wav = (() => { const raw = atob('${wav}'); const b = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) b[i] = raw.charCodeAt(i); return new Blob([b], { type: 'audio/wav' }); })(); 0`);
  const one = (within) => main.js(`window.api.transcribe(window.__wav, undefined, ${within}).then((r) => ({ ok: r.success, text: (r.text || r.error || '').slice(0, 70), reason: r.reason || '' }))`);
  const r1 = await one(true); await sleep(1500);
  const v1 = await main.js('window.api.getAccount()');
  const r2 = await one(true); await sleep(1500);
  const r3 = await one(false);
  console.log('1st (started with 5 s left):', JSON.stringify(r1), '| left after:', v1.remaining);
  console.log('2nd (started with minutes left, its turn after they ran out):', JSON.stringify(r2));
  console.log('3rd (started with nothing left):', JSON.stringify(r3));
  const ok = r1.ok && v1.remaining === 0 && r2.ok && !r3.ok && r3.reason === 'limit';
  console.log(ok ? 'ALL PASS' : 'FAILED');
  done(ok ? 0 : 1);
})().catch((e) => { console.log('ERROR', e); done(1); });
