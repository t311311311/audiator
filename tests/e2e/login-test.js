// Scratch: the sign-in window, the minutes counter and the Settings account
// section, rendered with stubbed APIs and captured.
const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs'), http = require('http');
const ROOT = path.resolve('C:/Test01/tray-translator/src');
const OUT = __dirname;
const i18n = require(path.join(ROOT, 'i18n.js'));
setTimeout(() => { console.error('timeout'); app.exit(2); }, 90000);

const LANG = process.env.SHOT_LANG || 'ru';
const THEME = process.env.SHOT_THEME || 'dark';
const I18N = JSON.stringify({ lang: LANG, languages: i18n.LANGUAGES, strings: i18n.stringsFor(LANG) });
const ACCOUNT = { signedIn: true, email: 'someone.long.name@example.com', plan: 'free', limited: true, remaining: 43 * 60 + 20, limit: 7200,
  resetsAt: Date.now() + (4 * 3600 + 41 * 60 - 30) * 1000, paidUntil: null };

const stubs = {
  'login.html': `<script>
    window.__codeOk = false;
    window.loginApi = {
      getI18n: () => Promise.resolve(${I18N}),
      getSettings: () => Promise.resolve({ theme: '${THEME}' }),
      getAccount: () => Promise.resolve(window.__acct || { signedIn: false, reason: null, lastEmail: null }),
      requestCode: (email) => Promise.resolve(window.__reqResult || { ok: true, isNew: true }),
      verify: (email, code) => Promise.resolve(window.__verifyResult || { ok: false, error: 'wrong_code', attempts_left: 3 }),
      openTerms: () => { window.__terms = (window.__terms || 0) + 1; },
    };
  </script>`,
  'index.html': `<script>
    const noop = () => {}; window.__cb = {};
    window.api = { getI18n: () => Promise.resolve(${I18N}),
      getSettings: () => Promise.resolve({ theme: '${THEME}', fontSize: 16, fontFamily: 'Arial' }),
      onSettingsUpdated: noop, onHotkeyToggleRecord: noop, recLevel: noop, close: noop, minimize: noop, quit: noop, logError: noop,
      recordingStarted: noop, recordingStopped: noop, transcribeFailed: noop, transcribed: () => Promise.resolve({ copied: false }),
      getEngineStatus: () => Promise.resolve({ model: 'small', state: 'ready', models: {}, translate: { installed: [], queue: [], failed: {} } }),
      onEngineStatus: noop, translateCatalog: () => Promise.resolve([]),
      getAccount: () => Promise.resolve(window.__acct), onAccountUpdated: (cb) => window.__cb.acct = cb,
      limitReached: () => { window.__limitReached = (window.__limitReached || 0) + 1; } };
    window.__acct = ${JSON.stringify(ACCOUNT)};
  </script>`,
  'settings.html': `<script>
    const noop = () => {}; window.__cb = {};
    window.settingsApi = { send: noop, receive: noop, onInitialSettings: noop,
      getAppVersion: () => Promise.resolve('1.0.8'), getI18n: () => Promise.resolve(${I18N}),
      getEngineStatus: () => Promise.resolve({ model: 'small', state: 'ready', models: {
        base: { installed: false, size: 147883000 }, small: { installed: true, size: 486212000 }, 'large-v3-turbo': { installed: false, size: 1621666000 } } }),
      onEngineStatus: noop, deleteModel: noop,
      getAccount: () => Promise.resolve(window.__acct), onAccountUpdated: (cb) => window.__cb.acct = cb,
      signOut: (r) => { window.__signedOut = r; }, openTerms: () => { window.__terms = 1; } };
    window.__acct = ${JSON.stringify(ACCOUNT)};
  </script>`,
};

app.whenReady().then(async () => {
  const srv = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '');
    const f = path.join(ROOT, name);
    fs.readFile(f, 'utf8', (e, d) => {
      if (e) { res.writeHead(404); res.end(); return; }
      if (stubs[name]) d = d.replace('<head>', '<head>' + stubs[name]);
      if (name === 'settings.html' && THEME === 'light') d = d.replace('<body>', '<body class="light-theme">');
      res.writeHead(200, { 'Content-Type': f.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' }); res.end(d);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tag = `${LANG}-${THEME}`;
  const shot = async (w, name) => {
    await sleep(250);
    await w.webContents.capturePage(); // the first capture can be stale
    await sleep(100);
    fs.writeFileSync(path.join(OUT, name), (await w.webContents.capturePage()).toPNG());
    const b = await w.webContents.executeJavaScript('(() => { const c = document.querySelector(".card"); return c ? Math.ceil(c.getBoundingClientRect().bottom) + "/" + innerHeight : ""; })()');
    console.log('saved', name, b ? 'card bottom/window ' + b : '');
  };

  const which = process.env.SHOT_WHICH || 'login';
  if (which === 'login') {
    // The page as the real window shows it: 400 x 470 inside the frame.
    const w = new BrowserWindow({ width: 400, height: 470, useContentSize: true, show: false });
    await w.loadURL(base + 'login.html');
    await sleep(500);
    const js = (c) => w.webContents.executeJavaScript(c);
    console.log('card height / window:', await js('[Math.ceil(document.querySelector(".card").getBoundingClientRect().height), innerHeight]'));
    await shot(w, `login-1-email-${tag}.png`);
    await js(`document.getElementById('email').value = 'Someone@Example.com'; document.getElementById('get-code').click();`);
    await sleep(200);
    console.log('without the tick:', await js(`document.getElementById('error').textContent`), '| still step 1:', await js(`document.getElementById('code-step').classList.contains('hidden')`));
    await shot(w, `login-0-needterms-${tag}.png`);
    await js(`document.getElementById('terms-link').click()`);
    console.log('rules link asks for the rules window:', await js('window.__terms === 1'), '| box still unticked:', await js(`!document.getElementById('accept').checked`));
    await js(`document.getElementById('accept').click(); document.getElementById('get-code').click();`);
    await sleep(300);
    console.log('step 2 shown:', await js(`!document.getElementById('code-step').classList.contains('hidden')`),
      '| sent to:', await js(`document.getElementById('sent-to').textContent`),
      '| resend:', await js(`document.getElementById('resend').textContent`));
    await shot(w, `login-2-code-${tag}.png`);
    await js(`const c = document.getElementById('code'); c.value = '12a3456'; c.dispatchEvent(new Event('input'));`);
    await sleep(300);
    console.log('code field after "12a3456":', await js(`document.getElementById('code').value`), '| error:', await js(`document.getElementById('error').textContent`));
    await shot(w, `login-3-wrong-${tag}.png`);
    // One free account per computer.
    await js(`window.__reqResult = { ok: false, error: 'device_has_free_account', other_email: 'fr***@mail.ru' };
              document.getElementById('other-email').click(); document.getElementById('email').value = 'second@mail.ru'; document.getElementById('accept').checked = true;
              document.getElementById('get-code').click();`);
    await sleep(300);
    console.log('second free account:', await js(`document.getElementById('error').textContent`));
    await shot(w, `login-4-device-${tag}.png`);
    // Sent back by the server.
    await js(`window.__acct = { signedIn: false, reason: 'session_expired', lastEmail: 'someone@example.com' }; showError(''); init();`);
    await sleep(400);
    console.log('expired: notice =', await js(`document.getElementById('notice').textContent`), '| email =', await js(`document.getElementById('email').value`));
    await shot(w, `login-5-expired-${tag}.png`);
  } else if (which === 'main') {
    const w = new BrowserWindow({ width: 400, height: 600, show: false, frame: false });
    await w.loadURL(base + 'index.html');
    await sleep(700);
    const js = (c) => w.webContents.executeJavaScript(c);
    console.log('counter:', await js(`document.getElementById('minutes-left').textContent`), '| hover:', await js(`document.getElementById('minutes-left').title`),
      '| region:', await js(`getComputedStyle(document.getElementById('minutes-left')).webkitAppRegion + '/' + getComputedStyle(document.querySelector('.title-bar')).webkitAppRegion`));
    await shot(w, `main-counter-${tag}.png`);
    await js(`window.__cb.acct({ ...window.__acct, remaining: 0 }); document.getElementById('record-btn').click();`);
    await sleep(300);
    console.log('used up: counter =', await js(`document.getElementById('minutes-left').textContent`),
      '| red:', await js(`document.getElementById('minutes-left').classList.contains('empty')`),
      '| limitReached sent:', await js('window.__limitReached'), '| toast:', await js(`document.getElementById('toast').textContent`),
      '| still idle:', await js(`!document.getElementById('record-btn').classList.contains('hidden')`));
    await shot(w, `main-limit-${tag}.png`);
    await js(`window.__cb.acct({ ...window.__acct, plan: 'unlimited', limited: false, remaining: null })`);
    await sleep(100);
    console.log('unlimited: counter hidden =', await js(`document.getElementById('minutes-left').classList.contains('hidden')`));
    // History: dates in the app's language, the quiet tick boxes, the copy-latest tooltip.
    await js(`window.__cb.acct(window.__acct);
      const mk = (t, empty) => { const p = addPendingEntry(); p.originalTextField.classList.remove('pending');
        p.originalTextField.textContent = empty ? S('status.noText') : t; if (empty) p.originalTextField.dataset.state = 'empty';
        p.check.hidden = !!empty; p.originalCopy.btn.hidden = !!empty; return p; };
      mk('Надо добавить подсказку, копировать последнее.'); mk('', true); const c = mk('Blah, blah.'); c.check.checked = true; updateActionButtons();`);
    await sleep(200);
    console.log('history:', await js(`[...document.querySelectorAll('.entry-header')].map((e) => e.textContent).slice(0, 1).join() + ' | ' + document.querySelector('.original-text[data-state=empty]').textContent + ' | copy tip: ' + document.getElementById('copy-btn').title`));
    await shot(w, `main-history-${tag}.png`);
  } else {
    const w = new BrowserWindow({ width: 450, height: +(process.env.SHOT_H || 615), useContentSize: true, show: false });
    await w.loadURL(base + 'settings.html');
    await sleep(800);
    const js = (c) => w.webContents.executeJavaScript(c);
    console.log('settings left line:', await js(`document.getElementById('account-left').textContent + ' | hover: ' + document.getElementById('account-left').title`));
    await js(`window.__cb.acct({ ...window.__acct, remaining: 0 })`);
    console.log('settings used up:', await js(`document.getElementById('account-left').textContent`));
    await js(`window.__cb.acct(window.__acct)`);
    console.log('settings: needed height =', await js(`(() => { const a = document.querySelector('.settings-actions').getBoundingClientRect(); return Math.ceil(a.bottom + 20); })()`), 'window', await js('innerHeight'));
    await shot(w, `settings-account-${tag}.png`);
    await js(`window.__cb.acct({ ...window.__acct, plan: 'commercial', limited: false, remaining: null, paidUntil: '2026-11-02T10:00:00' })`);
    await sleep(100);
    console.log('commercial:', await js(`document.getElementById('account-plan').textContent + ' | ' + document.getElementById('account-left').textContent`));
    await js(`window.__cb.acct({ ...window.__acct, plan: 'admin', limited: false, remaining: null })`);
    await sleep(100);
    console.log('admin:', await js(`document.getElementById('account-plan').textContent + ' | left hidden: ' + document.getElementById('account-left').hidden`));
    console.log('buttons in the account box:', await js(`[...document.querySelectorAll('.account-actions button')].map((b) => b.textContent).join(' / ')`));
    await js(`window.confirm = () => true; window.__signedOut = 'not sent'; document.getElementById('sign-out-btn').click()`);
    console.log('sign out sent:', await js(`window.__signedOut !== 'not sent'`));
  }
  app.exit(0);
});
