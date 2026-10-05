// Scratch: the history while recordings wait and one is transcribed — the
// real index.html with a stand-in api whose transcriptions the test finishes.
const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs'), http = require('http');
const ROOT = path.resolve('C:/Test01/tray-translator/src');
const i18n = require(path.join(ROOT, 'i18n.js'));
setTimeout(() => { console.error('timeout'); app.exit(2); }, 60000);
const I18N = JSON.stringify({ lang: 'ru', languages: i18n.LANGUAGES, strings: i18n.stringsFor('ru') });
const stub = `<script>
  const noop = () => {}; window.__cb = {}; window.__jobs = []; window.__handed = [];
  window.api = { getI18n: () => Promise.resolve(${I18N}), getSettings: () => Promise.resolve({ theme: 'dark', fontSize: 16, fontFamily: 'Arial' }),
    onSettingsUpdated: noop, onHotkeyToggleRecord: noop, recLevel: noop, close: noop, minimize: noop, quit: noop, logError: noop,
    recordingStarted: noop, recordingStopped: noop, transcribeFailed: noop,
    transcribed: (id, text) => { window.__handed.push(text); return Promise.resolve({ copied: false }); },
    transcribe: () => new Promise((resolve) => window.__jobs.push(resolve)),
    onTranscribeProgress: (cb) => window.__cb.progress = cb,
    getEngineStatus: () => Promise.resolve({ model: 'small', state: 'ready', models: {}, translate: { installed: [], queue: [], failed: {} } }),
    onEngineStatus: noop, translateCatalog: () => Promise.resolve([]),
    getAccount: () => Promise.resolve({ signedIn: true, plan: 'admin', limited: false }), onAccountUpdated: noop, limitReached: noop };
</script>`;
app.whenReady().then(async () => {
  const srv = http.createServer((req, res) => {
    const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    fs.readFile(f, 'utf8', (e, d) => { if (e) { res.writeHead(404); res.end(); return; }
      if (f.endsWith('index.html')) d = d.replace('<head>', '<head>' + stub);
      res.writeHead(200, { 'Content-Type': f.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' }); res.end(d); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const w = new BrowserWindow({ width: 400, height: 600, show: false, frame: false });
  await w.loadURL(`http://127.0.0.1:${srv.address().port}/index.html`);
  await new Promise((r) => setTimeout(r, 600));
  const js = (c) => w.webContents.executeJavaScript(c);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const texts = () => js(`[...document.querySelectorAll('.original-text')].reverse().map((e) => e.textContent).join(' | ')`);
  let failed = 0;
  const check = (what, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

  // three recordings stopped one after another (oldest first)
  await js(`queueTranscription(new Blob(['a']), 1); queueTranscription(new Blob(['b']), 2); queueTranscription(new Blob(['c']), 3);`);
  await sleep(200);
  check('first transcribing, the others wait', (await texts()) === 'Транскрибация… | Ждёт очереди… | Ждёт очереди…', await texts());
  await sleep(2100);
  check('no running time beside it (only the percent, when known)', /^Транскрибация… \| Ждёт/.test(await texts()), await texts());
  await js(`window.__cb.progress(41)`);
  check('the percent from the engine', /^Транскрибация… 41% \|/.test(await texts()), await texts());
  await js(`window.__jobs[0]({ success: true, text: 'первая', language: 'ru' })`);
  await sleep(1300); // a tick of the old timer would have covered the text by now
  check('done text stays; the next one starts', /^первая \| Транскрибация… \| Ждёт очереди…$/.test(await texts()), await texts());
  await js(`window.__jobs[1]({ success: true, text: 'вторая' }); `);
  await sleep(300);
  await js(`window.__jobs[2]({ success: false, error: 'Бесплатные 2 часа закончились. Обновление через 22 ч.', reason: 'limit' })`);
  await sleep(1300);
  check('all three done, the limit said in words', (await texts()) === 'первая | вторая | Бесплатные 2 часа закончились. Обновление через 22 ч.', await texts());
  check('handed to the queue in order', JSON.stringify(await js('window.__handed')) === '["первая","вторая"]', JSON.stringify(await js('window.__handed')));
  await js(`queueTranscription(new Blob(['d']), 4)`);
  await sleep(150);
  check('a new one afterwards is not "waiting"', (await texts()).endsWith('| Транскрибация…'), await texts());
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  app.exit(failed ? 1 : 0);
});
