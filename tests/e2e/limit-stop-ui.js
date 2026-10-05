// Scratch: the free time running out during a recording — the real index.html,
// a stand-in api and a synthetic microphone.
const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs'), http = require('http');
const ROOT = path.resolve('C:/Test01/tray-translator/src');
const i18n = require(path.join(ROOT, 'i18n.js'));
setTimeout(() => { console.error('timeout'); app.exit(2); }, 60000);
const I18N = JSON.stringify({ lang: 'ru', languages: i18n.LANGUAGES, strings: i18n.stringsFor('ru') });
const stub = `<script>
  const noop = () => {}; window.__cb = {}; window.__jobs = []; window.__sent = []; window.__limit = 0;
  window.api = { getI18n: () => Promise.resolve(${I18N}), getSettings: () => Promise.resolve({ theme: '${process.env.THEME || 'dark'}', fontSize: 16, fontFamily: 'Arial' }),
    onSettingsUpdated: noop, onHotkeyToggleRecord: noop, recLevel: noop, close: noop, minimize: noop, quit: noop, logError: noop,
    recordingStarted: noop, recordingStopped: noop, transcribeFailed: noop, transcribed: () => Promise.resolve({ copied: false }),
    transcribe: (blob, lang, within) => { window.__sent.push({ size: blob.size, within }); return new Promise((r) => window.__jobs.push(r)); },
    onTranscribeProgress: noop, limitReached: () => { window.__limit++; },
    getEngineStatus: () => Promise.resolve({ model: 'small', state: 'ready', models: {}, translate: { installed: [], queue: [], failed: {} } }),
    onEngineStatus: noop, translateCatalog: () => Promise.resolve([]),
    getAccount: () => Promise.resolve(window.__acct), onAccountUpdated: (cb) => window.__cb.acct = cb };
  window.__acct = { signedIn: true, plan: 'free', limited: true, remaining: 3, limit: 7200, resetsAt: Date.now() + 3600e3 };
  // a microphone: a quiet tone
  navigator.mediaDevices.getUserMedia = async () => { const c = new AudioContext(); const o = c.createOscillator(); const g = c.createGain(); g.gain.value = ${+(process.env.GAIN || 0.3)};
    const d = c.createMediaStreamDestination(); o.connect(g); g.connect(d); o.start(); return d.stream; };
</script>`;
app.whenReady().then(async () => {
  const srv = http.createServer((req, res) => {
    const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    fs.readFile(f, 'utf8', (e, d) => { if (e) { res.writeHead(404); res.end(); return; }
      if (f.endsWith('index.html')) d = d.replace('<head>', '<head>' + stub);
      res.writeHead(200, { 'Content-Type': f.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' }); res.end(d); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const w = new BrowserWindow({ width: 400, height: 600, show: false, frame: false, webPreferences: { autoplayPolicy: 'no-user-gesture-required' } });
  w.webContents.on('render-process-gone', (e, d) => console.log('RENDERER GONE', JSON.stringify(d)));
  await w.loadURL(`http://127.0.0.1:${srv.address().port}/index.html`);
  await new Promise((r) => setTimeout(r, 700));
  const js = (c) => w.webContents.executeJavaScript(c);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const recording = () => js(`!document.getElementById('stop-btn').classList.contains('hidden')`);
  let failed = 0;
  const check = (what, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

  // 0. the button's own meter moves while recording (the tone is a steady level)
  await js(`window.__acct.remaining = 60; window.__cb.acct(window.__acct); document.getElementById('record-btn').click()`);
  await sleep(1500);
  const bars = await js(`[...document.querySelectorAll('#btn-eq i')].map((b) => parseInt(b.style.height) || 2)`);
  check('the button shows a live meter while recording', bars.length === 7 && Math.max(...bars) > 2, JSON.stringify(bars));
  fs.writeFileSync(path.join(__dirname, 'rec-button-' + (process.env.THEME || 'dark') + '-' + (process.env.GAIN || '0.3') + '.png'), (await w.webContents.capturePage({ x: 0, y: 520, width: 140, height: 80 })).toPNG());
  await js(`document.getElementById('stop-btn').click()`);
  await sleep(600);
  check('flat again after stopping', (await js(`[...document.querySelectorAll('#btn-eq i')].every((b) => b.style.height === '2px')`)));
  await js(`window.__jobs[0]({ success: true, text: 'x' }); window.__jobs.length = 0; window.__sent.length = 0; window.__acct.remaining = 3; window.__cb.acct(window.__acct)`);
  await sleep(500);

  // 1. 3 s left: the recording stops by itself after about 3 s
  await js(`document.getElementById('record-btn').click()`);
  const t0 = Date.now();
  while (!(await recording()) && Date.now() - t0 < 3000) await sleep(50);
  check('recording started', await recording());
  const tRec = Date.now();
  while ((await recording()) && Date.now() - tRec < 8000) await sleep(100);
  const stoppedAfter = (Date.now() - tRec) / 1000;
  check('stopped by itself when the 3 s ran out', stoppedAfter > 2.5 && stoppedAfter < 4, stoppedAfter.toFixed(1) + ' s');
  await sleep(1800);
  check('the window was asked to come up, with the reason', (await js('window.__limit')) === 1 &&
        /^Бесплатное время закончилось — запись остановлена/.test(await js(`document.getElementById('toast').textContent`)), await js(`document.getElementById('toast').textContent`));
  check('what was recorded goes to transcription', (await js('window.__sent.length')) === 1 && (await js('window.__sent[0].within')) === true);
  check('counter shows 0 at once (not waiting for the server)', /Осталось 0 мин/.test(await js(`document.getElementById('minutes-left').textContent`)), await js(`document.getElementById('minutes-left').textContent`));
  // 2. nothing left (its text not back yet): a new recording does not start
  await js(`document.getElementById('record-btn').click()`);
  await sleep(600);
  check('no time left: a new recording does not start', !(await recording()));

  // 3. two in a row: 4 s left, the first takes 2 s and is not counted yet -> the second gets the other 2 s
  await js(`window.__jobs[0]({ success: true, text: 'один' }); window.__cb.acct({ ...window.__acct, remaining: 4 })`);
  await sleep(500);
  await js(`document.getElementById('record-btn').click()`);
  await sleep(2300);
  await js(`document.getElementById('stop-btn').click()`);
  await sleep(1500);
  check('first of two stopped by hand at ~2 s', !(await recording()));
  const t2 = Date.now();
  await js(`document.getElementById('record-btn').click()`);
  while (!(await recording()) && Date.now() - t2 < 3000) await sleep(50);
  const t3 = Date.now();
  while ((await recording()) && Date.now() - t3 < 8000) await sleep(100);
  const second = (Date.now() - t3) / 1000;
  check('second gets only what is left (~2 s), the first still uncounted', second > 1.2 && second < 3, second.toFixed(1) + ' s');
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  app.exit(failed ? 1 : 0);
});
