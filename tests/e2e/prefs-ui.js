// Stand: preferences of 2026-10-06. The real index.html and settings.html with
// a stand-in api. Main window: the translation favourites, the default
// translation language and English taken off the list belong to the account —
// another account signing in starts with none, the first one back gets its
// own; English comes back from the search. Settings: "(по умолчанию)" at the
// microphone and at Стандарт, the theme "Как в Windows (по умолчанию)" first
// and followed (light / dark Windows, emulated), the font size 14 by default.
// The language: the first of the system's languages the app has.
//   node_modules\.bin\electron tests\e2e\prefs-ui.js
const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs'), http = require('http');
const ROOT = path.resolve('C:/Test01/tray-translator/src');
const i18n = require(path.join(ROOT, 'i18n.js'));
setTimeout(() => { console.error('timeout'); app.exit(2); }, 90000);
const I18N = JSON.stringify({ lang: 'ru', languages: i18n.LANGUAGES, strings: i18n.stringsFor('ru') });
const R = i18n.stringsFor('ru');

const mainStub = `<script>
  try { localStorage.clear(); } catch (e) {}
  const noop = () => {}; window.__cb = {}; window.__calls = { translate: [] };
  window.api = new Proxy({ getI18n: () => Promise.resolve(${I18N}), getSettings: () => Promise.resolve({ theme: 'dark' }),
    getEngineStatus: () => Promise.resolve({ model: 'small', state: 'ready', models: {}, translate: { installed: ['en', 'ru', 'fr'], queue: [], failed: {} } }),
    onEngineStatus: noop, translateCatalog: () => Promise.resolve([{ code: 'ru', name: 'Russian', size: 61e6 }, { code: 'fr', name: 'French', size: 60e6 }]),
    getAccount: () => Promise.resolve({ signedIn: true, email: 'anna@example.com', plan: 'admin', limited: false }),
    onAccountUpdated: (cb) => { window.__cb.acct = cb; }, loadHistory: () => Promise.resolve([]), pendingList: () => Promise.resolve([]),
    translate: (text, target) => { window.__calls.translate.push(target); return Promise.resolve({ success: true, translatedText: 'x' }); },
  }, { get: (t, k) => (k in t ? t[k] : noop) });
</script>`;
const settingsStub = `<script>
  const noop = () => {}; window.__calls = {};
  window.settingsApi = new Proxy({ send: (ch, data) => { if (ch === 'save-all-settings') window.__saved = data; },
    onInitialSettings: (cb) => { window.__init = cb; }, getAppVersion: () => Promise.resolve('1.0.8'), getI18n: () => Promise.resolve(${I18N}),
    getEngineStatus: () => Promise.resolve({ model: 'small', state: 'ready', models: { base: { installed: false, size: 147883000 }, small: { installed: true, size: 486212000 }, 'large-v3-turbo': { installed: false, size: 1621666000 } } }),
    getAccount: () => Promise.resolve({ signedIn: true, email: 'anna@example.com', plan: 'admin', limited: false }),
    getSaveFolder: () => Promise.resolve('C:\\\\Users\\\\someone\\\\Downloads\\\\Audiator') }, { get: (t, k) => (k in t ? t[k] : noop) });
</script>`;

let failed = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('window-all-closed', () => {}); // one window closes before the next opens
app.whenReady().then(async () => {
  // The language, from the system's list (no choice saved).
  check('language: the first of the system\'s languages the app has',
    i18n.resolveLanguage(null, ['ru', 'en-US']) === 'ru' && i18n.resolveLanguage(null, ['de-DE', 'zh-CN']) === 'zh' &&
    i18n.resolveLanguage(null, ['de-DE']) === 'en' && i18n.resolveLanguage('en', ['ru']) === 'en' && i18n.resolveLanguage(null, 'ru-RU') === 'ru');

  const srv = http.createServer((req, res) => {
    const name = req.url.split('?')[0].replace(/^\//, '');
    fs.readFile(path.join(ROOT, name), 'utf8', (e, d) => {
      if (e) { res.writeHead(404); res.end(); return; }
      if (name === 'index.html') d = d.replace('<head>', '<head>' + mainStub);
      if (name === 'settings.html') d = d.replace('<head>', '<head>' + settingsStub);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/`;

  // --- Main window: translation preferences per account ---
  const w = new BrowserWindow({ width: 400, height: 600, show: false, frame: false });
  await w.loadURL(base + 'index.html'); await sleep(900);
  const js = (c) => w.webContents.executeJavaScript(c);
  const rowsNow = () => js(`[...document.querySelectorAll('#tp-installed .tp-lang')].map((r) => r.querySelector('.tp-name').textContent + (r.querySelector('.tp-star.on') ? '*' : '') + (r.classList.contains('tp-default') ? '!' : ''))`);
  const click = (name, sel) => js(`[...document.querySelectorAll('#tp-installed .tp-lang')].find((r) => r.querySelector('.tp-name').textContent === '${name}').querySelector('${sel}').click()`);
  const as = (acct) => js(`window.__cb.acct(${JSON.stringify(acct)})`);
  await js(`document.getElementById('translate-pick').click()`); await sleep(200);
  // Anna: Russian a favourite, French the default, English off the list.
  await click('Русский', '.tp-star'); await sleep(100);
  await click('Французский', '.tp-name'); await sleep(300);
  await js(`document.getElementById('translate-pick').click()`); await sleep(200);
  check('English can be taken off the list: its ✕ says it takes no space', (await js(`[...document.querySelectorAll('#tp-installed .tp-lang')].find((r) => r.querySelector('.tp-name').textContent === 'Английский').querySelector('.tp-delete').title`)) === R['translate.hideBuiltIn']);
  await click('Английский', '.tp-delete'); await sleep(200);
  const anna = await rowsNow();
  check('Anna: Russian starred, French the default, English off the list', JSON.stringify(anna) === JSON.stringify(['Русский*', 'Французский!']), JSON.stringify(anna));
  check('...French under Translate', (await js(`document.getElementById('tb-lang').textContent`)) === 'FR');
  // Signed out, then Boris signs in.
  await as({ signedIn: false, reason: 'user', lastEmail: 'anna@example.com' }); await sleep(200);
  check('signed out: no favourites, no default language left in the window', (await js(`document.getElementById('tb-lang').textContent`)) === '' && !(await rowsNow()).some((r) => /[*!]/.test(r)));
  await as({ signedIn: true, email: 'boris@example.com', plan: 'admin', limited: false }); await sleep(300);
  const boris = await rowsNow();
  check('Boris: none of Anna\'s — English back on his list, no stars, no default', JSON.stringify(boris) === JSON.stringify(['Английский', 'Русский', 'Французский']) &&
    (await js(`document.getElementById('tb-lang').textContent`)) === '', JSON.stringify(boris));
  await click('Русский', '.tp-name'); await sleep(300); // Boris translates into Russian once: his default
  // Anna back.
  await as({ signedIn: false, reason: 'user', lastEmail: 'boris@example.com' }); await sleep(200);
  await as({ signedIn: true, email: 'anna@example.com', plan: 'admin', limited: false }); await sleep(300);
  check('Anna back: her own again (Russian starred, French the default, no English)', JSON.stringify(await rowsNow()) === JSON.stringify(['Русский*', 'Французский!']) &&
    (await js(`document.getElementById('tb-lang').textContent`)) === 'FR', JSON.stringify(await rowsNow()));
  // English back from the search.
  await js(`document.getElementById('translate-pick').click()`); await sleep(200);
  await js(`const s = document.getElementById('tp-search'); s.value = 'англ'; s.dispatchEvent(new Event('input'))`); await sleep(200);
  const offer = await js(`(() => { const r = document.querySelector('#tp-results .tp-row'); return r ? r.textContent + '|' + r.querySelector('button').title : ''; })()`);
  check('English found by the search, to put back', offer.includes('Английский') && offer.endsWith(R['translate.showBuiltIn']), offer);
  await js(`document.querySelector('#tp-results .tp-row button').click()`); await sleep(200);
  check('...and back on the list', (await rowsNow()).some((r) => r.startsWith('Английский')));
  w.destroy();

  // --- Settings ---
  const SETTINGS_H = Number(/const SETTINGS_H = (\d+)/.exec(fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8'))[1]);
  const s = new BrowserWindow({ width: 450, height: SETTINGS_H, useContentSize: true, show: false }); // as index.js opens it
  await s.loadURL(base + 'settings.html'); await sleep(900);
  const sjs = (c) => s.webContents.executeJavaScript(c);
  await sjs(`window.__init({ whisperModel: 'small', opacity: 0.8 })`); await sleep(200); // a fresh install: nothing chosen yet
  const themes = await sjs(`[...document.querySelectorAll('#theme-select option')].map((o) => o.value + ':' + o.textContent)`);
  check('Theme: "Как в Windows (по умолчанию)" first, then dark and light', JSON.stringify(themes) === JSON.stringify([`system:${R['settings.themeSystem']}`, `dark:${R['settings.themeDark']}`, `light:${R['settings.themeLight']}`]), JSON.stringify(themes));
  check('...a fresh install shows it chosen', (await sjs(`document.getElementById('theme-select').value`)) === 'system');
  // The window follows Windows: emulated light, then dark.
  s.webContents.debugger.attach();
  // (A hidden window gets the change late — up to a second: wait for it.)
  const themeBecomes = async (light) => { for (let i = 0; i < 30; i++) { if ((await sjs(`document.body.classList.contains('light-theme')`)) === light) return true; await sleep(100); } return false; };
  await s.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  const lightNow = await themeBecomes(true);
  await s.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  const darkNow = await themeBecomes(false);
  check('"Как в Windows": light Windows -> light, dark Windows -> dark, on the fly', lightNow && darkNow, `light ${lightNow}, dark ${darkNow}`);
  await sjs(`document.getElementById('save-settings-btn').click()`);
  check('...saved as "system" (not the colour it showed)', (await sjs('window.__saved.theme')) === 'system' && !('themeChoice' in (await sjs('window.__saved'))));
  check('Device: "Микрофон (по умолчанию)" chosen', (await sjs(`document.getElementById('source-select').selectedOptions[0].textContent`)) === R['settings.sourceMic'] &&
    R['settings.sourceMic'].includes('(по умолчанию)'));
  // The quality list is a drop-down since AUD-48: "name · size ✓" per entry.
  const quality = await sjs(`[...document.querySelectorAll('#quality-select option')].map((o) => o.textContent.split(' \u00B7 ')[0])`);
  check('Quality: "Стандарт (по умолчанию)", the others without', JSON.stringify(quality) === JSON.stringify([R['quality.fast'], `${R['quality.standard']} (${R['settings.default']})`, R['quality.accurate']]), JSON.stringify(quality));
  check('Font size 14 by default, no mark', (await sjs(`document.getElementById('font-size-slider').value + '|' + document.getElementById('font-size-value').textContent`)) === '14|14px');
  await s.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'prefs-settings-ru.png'), (await s.webContents.capturePage()).toPNG());
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  app.exit(failed ? 1 : 0);
});
