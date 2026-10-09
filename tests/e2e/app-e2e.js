// Scratch: drive the real app through sign-in over the DevTools protocol.
//   node app-e2e.js
const { spawn, spawnSync } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os');
const ROOT = 'C:/Test01/tray-translator';
const OUT = __dirname;
const PORT = 3107, DBG = 9333, INSPECT = 9339; // INSPECT: the main process, to ask Electron about its windows
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-app-'));
// The server's settings, shared with the support digest run against its database.
const serverEnv = { ...process.env, PYTHONUTF8: '1', SMTP_HOST: '', MAIL_DEV_PRINT: '1', SUPPORT_TO: 'support@example.com',
                    ACCOUNTS_DATABASE_URL: 'sqlite:///' + path.join(tmp, 'accounts.db').replace(/\\/g, '/') };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server, appProc, serverLog = '', appLog = '';
let failed = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const done = (code) => { try { mainProc && mainProc.close(); } catch (e) {} try { appProc && appProc.kill(); } catch (e) {} try { server && server.kill(); } catch (e) {} process.exit(code); };
setTimeout(() => { console.log('timeout'); console.log(appLog.slice(-3000)); done(2); }, 120000);

async function targets() {
  try { return await (await fetch(`http://127.0.0.1:${DBG}/json`)).json(); } catch (e) { return []; }
}
async function page(file, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const t = (await targets()).find((x) => x.type === 'page' && x.url.split('?')[0].endsWith('/' + file));
    if (t) return connect(t.webSocketDebuggerUrl);
    await sleep(250);
  }
  throw new Error('no window with ' + file);
}
function connect(url) {
  const ws = new WebSocket(url);
  let id = 0; const wait = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  return new Promise((resolve) => ws.onopen = () => resolve({
    js: async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : r; },
    // A snapshot can hang when the window is not being painted (screen off, another window over it,
    // seen at night 2026-10-06): skipped after 5 s, the checks go on.
    shot: async (name) => {
      const r = await Promise.race([send('Page.captureScreenshot', { format: 'png' }), new Promise((res) => setTimeout(() => res(null), 5000))]);
      if (!r || !r.result) { console.log('snapshot skipped (window not painted):', name); return; }
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64')); console.log('saved', name);
    },
    close: () => ws.close(),
    send,
  }));
}
// The main process (node inspector): what Electron itself says about its windows.
let mainProc = null;
async function electronSays(expr) {
  if (!mainProc) {
    const list = await (await fetch(`http://127.0.0.1:${INSPECT}/json/list`)).json();
    mainProc = await connect(list[0].webSocketDebuggerUrl);
  }
  const r = await mainProc.send('Runtime.evaluate', { returnByValue: true, includeCommandLineAPI: true,
    expression: `(() => { const { BrowserWindow } = require('electron');
    const by = (f) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().split('?')[0].endsWith('/' + f));
    return JSON.stringify(${expr}); })()` });
  const v = r.result && r.result.result && r.result.result.value;
  if (typeof v === 'string') return JSON.parse(v);
  console.log('main process said:', JSON.stringify(r).slice(0, 600));
  return {};
}
const codeFor = async (email) => {
  for (let i = 0; i < 80; i++) {
    const m = [...serverLog.matchAll(new RegExp(`sign-in code for ${email.replace(/[.]/g, '\\.')}: (\\d{6})`, 'g'))].pop();
    if (m) return m[1];
    await sleep(100);
  }
  throw new Error('no code for ' + email);
};

(async () => {
  server = spawn(path.join(ROOT, '.venv/Scripts/python.exe'), ['-m', 'uvicorn', 'main:app', '--port', String(PORT)], {
    cwd: path.join(ROOT, 'auth-server'), windowsHide: true, env: serverEnv,
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 100 && !/Uvicorn running/.test(serverLog); i++) await sleep(200);

  appProc = spawn(path.join(ROOT, 'node_modules/electron/dist/electron.exe'),
    [`--remote-debugging-port=${DBG}`, `--inspect=${INSPECT}`, path.join(OUT, 'app-launcher.js')], {
      cwd: ROOT,
      env: { ...process.env, AUD_TEST_USERDATA: path.join(tmp, 'userData'), AUDIATOR_ACCOUNTS_URL: `http://127.0.0.1:${PORT}` },
    });
  appProc.stdout.on('data', (d) => { appLog += d; });
  appProc.stderr.on('data', (d) => { appLog += d; });
  let quit = false;
  appProc.on('exit', (c) => { quit = true; appLog += `\n[exit ${c}]`; });

  // 1. Signed out at start: the sign-in window, not the app.
  const login = await page('login.html');
  await sleep(800);
  check('starts with the sign-in window', !!login);
  check('main window stays hidden', (await targets()).some((t) => t.url.endsWith('/index.html')) &&
    !(await (await page('index.html')).js('document.visibilityState === "visible" && document.hasFocus()')));
  await login.shot('app-1-login.png');

  await login.js(`document.getElementById('email').value = 'tester@example.com'; document.getElementById('accept').click(); document.getElementById('get-code').click();`);
  const code = await codeFor('tester@example.com');
  await sleep(300);
  check('code mailed (printed by the server)', /^\d{6}$/.test(code));
  await login.js(`const c = document.getElementById('code'); c.value = '${code}'; c.dispatchEvent(new Event('input'));`);

  // 2. Signed in: the sign-in window goes, the main window comes with the counter.
  for (let i = 0; i < 40 && (await targets()).some((t) => t.url.endsWith('/login.html')); i++) await sleep(250);
  check('sign-in window closed', !(await targets()).some((t) => t.url.endsWith('/login.html')));
  check('app did not quit', !quit);
  const main = await page('index.html');
  await sleep(500);
  const counter = await main.js(`document.getElementById('minutes-left').textContent`);
  check('counter in the main window', /^Осталось 2 ч$/.test(counter), JSON.stringify(counter));
  // a transcription's minutes, reported as the app does after one: the 24 hours start
  await main.js(`window.api.getAccount()`);
  const acct = JSON.parse(fs.readFileSync(path.join(tmp, 'userData', 'account.json'), 'utf8'));
  check('session saved in the app data, token encrypted', acct.email === 'tester@example.com' && !!acct.tokenEnc && !('token' in acct));
  await main.shot('app-2-main.png');
  // Two finished transcripts in the history (as a transcription leaves them).
  await main.js(`['секрет один', 'секрет два'].forEach((t) => { const p = addPendingEntry();
    p.originalTextField.classList.remove('pending'); p.originalTextField.textContent = t;
    p.originalTextField.closest('.history-entry')._audio = new Blob(['x']); }); updateActionButtons();`);
  check('history has the two texts', (await main.js(`document.querySelectorAll('.history-entry').length`)) === 2);

  // 2b. "Написать нам" from the menu: a topic, a message, sent to support.
  await main.js(`window.api.openSupport()`);
  const sup = await page('support.html');
  await sleep(700);
  check('support window: answer goes to the account email', (await sup.js(`document.getElementById('email').textContent`)) === 'tester@example.com');
  check('support window: 4 topics', (await sup.js(`[...document.querySelectorAll('.topic span')].map((e) => e.textContent).join('|')`)) === 'Оплата и баланс|Ошибка в работе|Аккаунт и вход|Предложение');
  await sup.js(`document.getElementById('send').click()`);
  await sleep(200);
  check('no topic: asked to choose one', (await sup.js(`document.getElementById('error').textContent`)) === 'Выберите тему');
  await sup.shot('app-4-support.png');
  await sup.js(`document.querySelectorAll('.topic input')[1].click(); document.getElementById('text').value = 'После второй записи не вставляется текст'; document.getElementById('send').click();`);
  for (let i = 0; i < 40 && !(await sup.js(`!document.getElementById('done').classList.contains('hidden')`)); i++) await sleep(250);
  const doneText = await sup.js(`document.getElementById('done-text').textContent`);
  check('sent: number and answer time shown', /^Обращение №\d+ отправлено\. Ответим на tester@example\.com в течение 5 дней с адреса audiatorr@gmail\.com — загляните и в «Спам»\.$/.test(doneText), doneText);
  await sup.shot('app-5-support-sent.png');
  check('no letter per message (digests only)', !/to support@example\.com/.test(serverLog));
  // The hourly digest (support_digest.py), run now against this server's database.
  const digest = spawnSync(path.join(ROOT, '.venv/Scripts/python.exe'), ['support_digest.py', '--now'], {
    cwd: path.join(ROOT, 'auth-server'), windowsHide: true, encoding: 'utf8', env: serverEnv });
  const letter = digest.stdout || '';
  check('the digest to support: number, topic, who, plan, due', /to support@example\.com: Audiator: новых обращений 1/.test(letter)
    && /#\d+ · Баг · tester@example\.com · бесплатный · ответить до/.test(letter), (digest.stderr || '').slice(-300));
  check('the digest carries the text, the app version and a reply link', /После второй записи не вставляется текст/.test(letter)
    && /Программа: \d+\.\d+\.\d+, Windows/.test(letter) && /mailto:tester@example\.com\?subject=Re%3A%20Audiator%20%23\d+/.test(letter));
  await sup.js(`document.getElementById('close').click()`).catch(() => {});
  await sleep(400);
  check('support window closes', !(await targets()).some((t) => t.url.split('?')[0].endsWith('/support.html')));

  // 2c. The ☰ menu (AUD-50): while open, the title bar is no drag area, so a
  // click there reaches the page and closes it; leaving the window closes it.
  const region = () => main.js(`getComputedStyle(document.querySelector('.title-bar')).getPropertyValue('-webkit-app-region')`);
  await main.js(`document.getElementById('menu-btn').click()`);
  await sleep(100);
  check('menu open: the title bar takes clicks (no drag)', (await main.js(`!document.getElementById('app-menu').classList.contains('hidden')`)) && (await region()) === 'no-drag', await region());
  await main.js(`document.querySelector('.title-bar').click()`);
  await sleep(100);
  check('a click on the title bar closes the menu, the bar drags again', (await main.js(`document.getElementById('app-menu').classList.contains('hidden')`)) && (await region()) === 'drag', await region());
  await main.js(`document.getElementById('menu-btn').click(); window.dispatchEvent(new Event('blur'))`);
  await sleep(100);
  check('away to another window: the menu closes', await main.js(`document.getElementById('app-menu').classList.contains('hidden')`));

  // 3. Settings: the account section; signing out brings sign-in back.
  // A recording going on while Settings is in front: the bar must show it.
  await main.js(`window.api.recordingStarted(999)`);
  await main.js(`document.getElementById('settings-btn').click()`);
  const settings = await page('settings.html');
  await sleep(800);
  check('account buttons: pay, write to us, sign out (no switch; AUD-47)', (await settings.js(`[...document.querySelectorAll('.account-actions button')].filter((b) => !b.hidden).map((b) => b.textContent).join('|')`)) === 'Оплатить|Написать нам|Выйти из аккаунта');
  check('settings shows the account', (await settings.js(`document.getElementById('account-email').textContent + ' | ' + document.getElementById('account-left').textContent`)).startsWith('tester@example.com'));
  await sleep(400);
  // (The bar's page always reports "visible" — it is never throttled — so
  // the main process's own log of its show/hide decisions is what is read.)
  check('recording + Settings in front: the bar is on screen', /\[overlay\] show: barrels=1 inView=false focused=other-own/.test(appLog));
  await main.js(`window.api.transcribeFailed(999)`);
  await sleep(500);
  check('nothing going on: the bar goes again', /\[overlay\] hide: barrels=0/.test(appLog.split('[overlay] show: barrels=1 inView=false')[1] || ''));
  // "Pay" in Settings: the payment window, modal to Settings (AUD-44).
  await settings.js(`document.getElementById('pay-btn').click()`);
  const pay = await page('pay.html');
  await sleep(600);
  const st = await electronSays(`{ modal: by('pay.html').isModal(), parent: by('pay.html').getParentWindow() === by('settings.html'),
    settingsEnabled: by('settings.html').isEnabled(), minimizable: by('pay.html').isMinimizable() }`);
  check('the payment window is modal to Settings: Settings wait (AUD-44)', st.modal && st.parent && !st.settingsEnabled && !st.minimizable, JSON.stringify(st));
  await pay.shot('app-6-pay.png');
  await pay.js(`window.payApi.close()`).catch(() => {});
  await sleep(500);
  check('...closed: Settings usable again', !(await targets()).some((t) => t.url.split('?')[0].endsWith('/pay.html'))
    && (await electronSays(`by('settings.html').isEnabled()`)) === true);
  mainProc.close(); mainProc = null; // an open inspector session would keep the app from quitting at the end
  // English being tried in Settings (not saved): Contact us and the rules open in English.
  await settings.js(`window.settingsApi.openSupport('en')`);
  const supEn = await page('support.html');
  await sleep(700);
  check('support from Settings in the language shown there', (await supEn.js(`document.title + ' | ' + [...document.querySelectorAll('.topic span')].map((e) => e.textContent).join('|')`)) === 'Contact us — Audiator | Payment and balance|Something does not work|Account and sign-in|Suggestion');
  await supEn.js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`).catch(() => {});
  await settings.js(`window.settingsApi.openTerms('zh')`);
  const terms = await page('terms.html');
  await sleep(600);
  check('rules from Settings in that language (zh)', (await terms.js('document.title')) === 'Audiator 使用条款');
  await terms.js('window.close()').catch(() => {});
  await sleep(300);
  await settings.shot('app-3-settings.png');
  settings.js(`window.settingsApi.signOut()`).catch(() => {}); // (the button asks a system dialog first)
  const login2 = await page('login.html');
  await sleep(800);
  check('sign out: sign-in window back, last email offered', (await login2.js(`document.getElementById('email').value`)) === 'tester@example.com');
  // Offered selected: typing replaces it (an email input has no selectionStart to read).
  await login2.send('Input.insertText', { text: 'other@example.com' });
  check('typing replaces the offered email', (await login2.js(`document.getElementById('email').value`)) === 'other@example.com',
    JSON.stringify(await login2.js(`document.getElementById('email').value`)));
  check('sign out: history cleared', (await main.js(`document.querySelectorAll('.history-entry').length + '|' + document.body.innerText.includes('секрет')`)) === '0|false');
  check('sign out: save buttons off again', await main.js(`document.getElementById('save-btn').disabled && document.getElementById('translate-btn').disabled`));
  check('sign out: settings closed', !(await targets()).some((t) => t.url.endsWith('/settings.html')));
  check('sign out: session gone', (() => { const a = JSON.parse(fs.readFileSync(path.join(tmp, 'userData', 'account.json'), 'utf8')); return !a.token && !a.tokenEnc; })());

  // 4. Closing the sign-in window without signing in quits the app.
  login2.js('window.close()').catch(() => {});
  for (let i = 0; i < 40 && !quit; i++) await sleep(250);
  check('closing sign-in quits the app', quit);

  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  if (failed) console.log(appLog.slice(-3000));
  done(failed ? 1 : 0);
})().catch((e) => { console.log('ERROR', e); console.log(appLog.slice(-3000)); done(1); });
