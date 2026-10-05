// Scratch: the real app signed in and left alone — which of its processes use
// CPU, and which pages keep animations running.
const { spawn, execSync } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os');
const ROOT = 'C:/Test01/tray-translator';
const PORT = 3109, DBG = 9334;
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
           ACCOUNTS_DATABASE_URL: 'sqlite:///' + path.join(tmp, 'a.db').replace(/\\/g, '/') } });
  server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 100 && !/Uvicorn running/.test(serverLog); i++) await sleep(200);
  appProc = spawn(path.join(ROOT, 'node_modules/electron/dist/electron.exe'), [`--remote-debugging-port=${DBG}`, path.join(__dirname, 'app-launcher.js')],
    { cwd: ROOT, env: { ...process.env, AUD_TEST_USERDATA: path.join(tmp, 'ud'), AUDIATOR_ACCOUNTS_URL: `http://127.0.0.1:${PORT}` } });
  const login = await page('login.html'); await sleep(800);
  await login.js(`document.getElementById('email').value = 'idle@example.com'; document.getElementById('accept').click(); document.getElementById('get-code').click();`);
  let code; for (let i = 0; i < 50 && !(code = (serverLog.match(/sign-in code for idle@example\.com: (\d{6})/) || [])[1]); i++) await sleep(100);
  await login.js(`const c = document.getElementById('code'); c.value = '${code}'; c.dispatchEvent(new Event('input'));`);
  const main = await page('index.html'); await sleep(2500);
  const ov = await page('recorder-overlay.html');
  const pids = tree(appProc.pid);
  console.log('processes:', pids.map((p) => p.join(':')).join(' '));
  const anims = async () => 'main anims=' + await main.js(`document.getAnimations().filter((a) => a.playState === 'running').map((a) => (a.effect.target.id || a.effect.target.className) + ':' + (a.animationName || a.constructor.name)).join(',') || 'none'`) +
    ' | overlay anims=' + await ov.js(`document.getAnimations().filter((a) => a.playState === 'running').length`);
  console.log('idle, main shown:', await anims());
  await measure('idle, main window shown', pids);
  await main.js(`window.api.minimize()`); await sleep(1000);
  await measure('idle, main window minimised', pids);
  // A barrel on the bar: "transcribing" (blinking), then "Ctrl+V" (glowing).
  await main.js(`window.api.recordingStarted(1); window.api.recordingStopped(1)`); await sleep(800);
  console.log('bar:', await ov.js(`document.getElementById('row').innerText.replace(/\s+/g, ' ')`), '| anims=', await ov.js(`document.getAnimations().length`));
  await measure('bar shown, "transcribing" barrel', pids);
  await ov.js(`document.querySelectorAll('.bar').forEach((b) => { b.classList.remove('busy'); b.classList.add('done'); b.querySelector('.status').innerHTML = '<b>Готово!</b>Ctrl+V'; })`); await sleep(300);
  await measure('bar shown, "Ctrl+V" barrel (glow)', pids);
  await main.js(`window.api.transcribeFailed(1)`);
  done(0);
})().catch((e) => { console.log('ERROR', e); done(1); });
