// Stand: the moment the free plan's 24 hours end, in the windows themselves
// (2026-10-06). The real index.html and settings.html with a stand-in api: the
// account says 0 left, renewal in a second; a second later — before the main
// process sends anything new — both windows show all 2 hours back with no
// renewal time, and a recording starts.
//   node_modules\.bin\electron tests\e2e\renewal-ui.js
const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs'), http = require('http');
const ROOT = path.resolve('C:/Test01/tray-translator/src');
const i18n = require(path.join(ROOT, 'i18n.js'));
setTimeout(() => { console.error('timeout'); app.exit(2); }, 60000);
const I18N = JSON.stringify({ lang: 'ru', languages: i18n.LANGUAGES, strings: i18n.stringsFor('ru') });
const ACCT = `{ signedIn: true, email: 'a@b.c', plan: 'free', limited: true, remaining: 0, limit: 7200, resetsAt: Date.now() + 1500 }`;
const stubs = {
  'index.html': `<script>
    const noop = () => {}; window.__started = 0; window.__acct = ${ACCT};
    window.api = new Proxy({ getI18n: () => Promise.resolve(${I18N}), getAccount: () => Promise.resolve(window.__acct),
      getSettings: () => Promise.resolve({ theme: 'dark' }), loadHistory: () => Promise.resolve([]), pendingList: () => Promise.resolve([]),
      getEngineStatus: () => Promise.resolve({ state: 'ready', translate: { installed: ['en'], queue: [], failed: {} } }),
      translateCatalog: () => Promise.resolve([]), recordingStarted: () => { window.__started++; },
      recordingBegin: () => Promise.resolve(null) }, { get: (t, k) => (k in t ? t[k] : noop) });
    navigator.mediaDevices.getUserMedia = async () => { const c = new AudioContext(); const o = c.createOscillator();
      const d = c.createMediaStreamDestination(); o.connect(d); o.start(); return d.stream; };
  </script>`,
  'settings.html': `<script>
    const noop = () => {};
    window.settingsApi = new Proxy({ getI18n: () => Promise.resolve(${I18N}), getAccount: () => Promise.resolve(${ACCT}),
      getAppVersion: () => Promise.resolve('1'), getEngineStatus: () => Promise.resolve({ models: {} }) }, { get: (t, k) => (k in t ? t[k] : noop) });
  </script>`,
};
let failed = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const srv = http.createServer((req, res) => {
    const name = req.url.split('?')[0].replace(/^\//, '');
    fs.readFile(path.join(ROOT, name), 'utf8', (e, d) => {
      if (e) { res.writeHead(404); res.end(); return; }
      if (stubs[name]) d = d.replace('<head>', '<head>' + stubs[name]);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const w = new BrowserWindow({ width: 400, height: 600, show: false, frame: false, webPreferences: { autoplayPolicy: 'no-user-gesture-required' } });
  const s = new BrowserWindow({ width: 450, height: 720, show: false });
  await Promise.all([w.loadURL(base + 'index.html'), s.loadURL(base + 'settings.html')]);
  await sleep(400);
  const js = (c) => w.webContents.executeJavaScript(c);
  const sjs = (c) => s.webContents.executeJavaScript(c);
  const counter = () => js(`document.getElementById('minutes-left').textContent`);
  const before = await counter();
  check('before: nothing left, renewal soon', /^Осталось 0 мин, обновление через 1 мин/.test(before), before);
  await sleep(1500);
  await js('renderAccount()'); await sjs('renderAccount()'); // the 30-second tick, without waiting for it
  const after = await counter();
  check('a moment after the 24 hours end: all 2 hours, no renewal time', after === 'Осталось 2 ч', after);
  check('...in Settings too', (await sjs(`document.getElementById('account-left').textContent`)) === 'Осталось 2 ч',
    await sjs(`document.getElementById('account-left').textContent`));
  await js(`document.getElementById('record-btn').click()`); await sleep(800);
  check('a recording starts (it was refused until the main process sent new figures)', (await js('window.__started')) === 1);
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  app.exit(failed ? 1 : 0);
});
