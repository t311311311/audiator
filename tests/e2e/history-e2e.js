// Scratch: the history kept between runs, in the real app (its own data folder).
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const ROOT = 'C:/Test01/tray-translator';
const PORT = 3113, DBG = 9338;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-hist-'));
const ud = path.join(tmp, 'ud');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server, appProc, serverLog = '', failed = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const done = (c) => { try { appProc && appProc.kill(); } catch (e) {} try { server.kill(); } catch (e) {} process.exit(c); };
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
function launch() {
  appProc = spawn(path.join(ROOT, 'node_modules/electron/dist/electron.exe'), [`--remote-debugging-port=${DBG}`, path.join(__dirname, 'app-launcher.js')],
    { cwd: ROOT, env: { ...process.env, AUD_TEST_USERDATA: ud, AUDIATOR_ACCOUNTS_URL: `http://127.0.0.1:${PORT}` } });
  return new Promise((r) => appProc.on('spawn', r));
}
async function quit(main) {
  const p = new Promise((r) => appProc.on('exit', r));
  main.js('window.api.quit()').catch(() => {});
  await p;
}
const texts = (main) => main.js(`[...document.querySelectorAll('.history-entry')].map((e) => e.querySelector('.original-text').textContent + (e.querySelector('.translated-text') ? ' => ' + e.querySelector('.translated-text').textContent : '')).join(' | ')`);

(async () => {
  server = spawn(path.join(ROOT, '.venv/Scripts/python.exe'), ['-m', 'uvicorn', 'main:app', '--port', String(PORT)], {
    cwd: path.join(ROOT, 'auth-server'), windowsHide: true,
    // The second account is an admin: one free account per computer would refuse it.
    env: { ...process.env, PYTHONUTF8: '1', SMTP_HOST: '', MAIL_DEV_PRINT: '1', ADMIN_EMAILS: 'other@example.com',
           ACCOUNTS_DATABASE_URL: 'sqlite:///' + path.join(tmp, 'a.db').split(path.sep).join('/') } });
  server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 100 && !/Uvicorn running/.test(serverLog); i++) await sleep(200);

  // run 1: sign in, three texts (one translated, one "no speech"), quit
  await launch();
  const login = await page('login.html'); await sleep(800);
  await login.js(`document.getElementById('email').value = 'hist@example.com'; document.getElementById('accept').click(); document.getElementById('get-code').click();`);
  let code; for (let i = 0; i < 50 && !(code = (serverLog.match(/sign-in code for hist@example\.com: (\d{6})/) || [])[1]); i++) await sleep(100);
  await login.js(`const c = document.getElementById('code'); c.value = '${code}'; c.dispatchEvent(new Event('input'));`);
  let main = await page('index.html'); await sleep(1500);
  await main.js(`(() => {
    const mk = (t, empty) => { const p = addPendingEntry(); const o = p.originalTextField; o.classList.remove('pending');
      o.textContent = empty ? S('status.noText') : t; if (empty) o.dataset.state = 'empty'; o.closest('.history-entry').dataset.lang = 'ru'; p.check.hidden = !!empty; return o.closest('.history-entry'); };
    mk('первая запись'); mk('', true); const e = mk('третья, с переводом');
    const tr = document.createElement('div'); tr.className = 'translated-text'; tr.textContent = 'the third, translated'; e.appendChild(withCopyButton(tr).row);
  })()`);
  await sleep(1600);
  const before = await texts(main);
  await quit(main);
  // One file per account: its email, hashed, in the name (2026-10-06).
  const fileOf = (email) => path.join(ud, `history-${crypto.createHash('sha256').update(email).digest('hex').slice(0, 16)}.dat`);
  const file = fileOf('hist@example.com');
  const raw = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
  check('kept in a file when the app closed', raw.length > 0, raw.length + ' bytes');
  check('the file is encrypted (no text in it)', !raw.toString('utf8').includes('первая') && !raw.toString('latin1').includes('third'));

  // run 2: the same account starts again — the history is back, in order
  await launch();
  main = await page('index.html'); await sleep(2500);
  const after = await texts(main);
  check('back after a restart, newest first, translation too', after === 'третья, с переводом => the third, translated | первая запись', after);
  const copies = await main.js(`[...document.querySelectorAll('.history-entry')].map((e) => [...e.querySelectorAll('.entry-copy')].map((b) => b.hidden ? 'hidden' : 'shown').join('+')).join(' | ')`);
  check('restored entries have their copy buttons (text and translation)', copies === 'shown+shown | shown', copies);
  await main.shot ? 0 : 0;
  check('"no speech" entries are not kept', !after.includes(await main.js(`S('status.noText')`)), before);
  check('the date is the original one', (await main.js(`document.querySelector('.history-entry').dataset.isoTimestamp`)) < new Date(Date.now() - 2000).toISOString());

  // Sign out: the history leaves the window but stays, for this account, on this
  // computer; another account sees none of it; the first one back gets it back.
  const signIn = async (email) => {
    const lg = await page('login.html'); await sleep(800);
    const from = serverLog.length;
    await lg.js(`(() => { document.getElementById('email').value = '${email}'; const a = document.getElementById('accept'); if (!a.checked) a.click();
      document.getElementById('get-code').click(); })()`);
    let c; for (let i = 0; i < 50 && !(c = (serverLog.slice(from).match(new RegExp('sign-in code for ' + email.replace(/[.]/g, '\\.') + ': (\\d{6})')) || [])[1]); i++) await sleep(100);
    await lg.js(`const c = document.getElementById('code'); c.value = '${c}'; c.dispatchEvent(new Event('input'));`);
    await sleep(2500);
  };
  const signOut = async () => {
    await main.js(`window.api.openSettings()`);
    const st = await page('settings.html'); await sleep(800);
    st.js(`window.settingsApi.signOut()`).catch(() => {}); // (the button asks a system dialog first)
    await sleep(2000);
  };
  await signOut();
  check('sign out: the history leaves the window', (await main.js(`document.querySelectorAll('.history-entry').length`)) === 0);
  check('...but stays on this computer for this account (encrypted)', fs.existsSync(file) && fs.readFileSync(file).length === raw.length);
  await signIn('other@example.com');
  check('another account signs in: none of the first one\'s history', (await texts(main)) === '', await texts(main));
  await main.js(`(() => { const p = addPendingEntry(); const o = p.originalTextField; o.classList.remove('pending'); o.textContent = 'запись другого'; p.check.hidden = false; })()`);
  await sleep(1200);
  check('...its own history in its own file', fs.existsSync(fileOf('other@example.com')));
  await signOut();
  await signIn('hist@example.com');
  check('the first account back: its history is back, as it was', (await texts(main)) === after, await texts(main));
  await main.js(`document.getElementById('clear-all-btn').click()`).catch(() => {}); // (a system dialog asks first)
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  done(failed ? 1 : 0);
})().catch((e) => { console.log('ERROR', e); done(1); });
