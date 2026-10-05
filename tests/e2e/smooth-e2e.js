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
  const load = (f) => fs.readFileSync(f).toString('base64');
  await main.js(`window.__w = {}; window.__seen = []; window.api.onTranscribeProgress((p) => window.__seen.push([Date.now(), p])); 0`);
  for (const [name, f] of [['short', path.join(__dirname, 'fixtures', 'test-ru.wav')], ['long', path.join(__dirname, 'fixtures', 'long-ru.wav')]]) {
    await main.js(`window.__w['${name}'] = (() => { const raw = atob('${load(f)}'); const b = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) b[i] = raw.charCodeAt(i); return new Blob([b], { type: 'audio/wav' }); })(); 0`);
  }
  let failed = 0;
  const check = (what, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
  for (const name of ['short', 'long', 'short']) {
    const r = await main.js(`(async () => { window.__seen = []; const t0 = Date.now();
      const res = await window.api.transcribe(window.__w['${name}'], undefined, true);
      return { ok: res.success, took: (Date.now() - t0) / 1000, seen: window.__seen.map(([t, p]) => [Math.round((t - t0) / 100) / 10, p]) }; })()`);
    const pcts = r.seen.map((x) => x[1]);
    console.log(`${name}: ${r.took.toFixed(1)} s | ` + r.seen.map(([t, p]) => `${t}s:${p}%`).join(' '));
    check(`${name}: transcribed`, r.ok);
    check(`${name}: never 0 %, only forward, under 100 %`, pcts.every((p, i) => p > 0 && p < 100 && (i === 0 || p > pcts[i - 1])));
    check(`${name}: the percent shows within ~1.5 s`, r.seen.length > 0 && r.seen[0][0] <= 1.6, r.seen.length ? r.seen[0][0] + ' s' : 'none');
    check(`${name}: moves every second, not more often (not in 30-s steps)`, r.seen.length >= Math.floor(r.took) - 2 && r.seen.length <= Math.ceil(r.took) + 2, `${r.seen.length} updates in ${r.took.toFixed(0)} s`);
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'ud', 'config.json'), 'utf8'));
  check('the speed of this computer was learnt', cfg.asrSpeed && cfg.asrSpeed.small > 0, JSON.stringify(cfg.asrSpeed));
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  done(failed ? 1 : 0);
})().catch((e) => { console.log('ERROR', e); done(1); });
