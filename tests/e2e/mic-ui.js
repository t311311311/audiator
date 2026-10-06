// Stand: how the microphone is opened (user's decision 2026-10-06, after a
// night without processing). The real index.html with a stand-in api and a
// synthetic two-channel microphone (a tone on the left, silence on the right);
// then Settings. Checks: noise suppression and automatic gain are asked for,
// echo cancellation is not; whatever channels a microphone gives, the engine
// gets their average (not just the left); the saved recording is made
// seekable; Settings have no microphone switch and fit a laptop screen.
//   node_modules\.bin\electron tests\e2e\mic-ui.js
const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs'), http = require('http');
const ROOT = path.resolve('C:/Test01/tray-translator/src');
const OUT = __dirname;
const i18n = require(path.join(ROOT, 'i18n.js'));
const { makeSeekable } = require(path.join(ROOT, 'webm-seekable.js'));
setTimeout(() => { console.error('timeout'); app.exit(2); }, 90000);

const I18N = (lang) => JSON.stringify({ lang, languages: i18n.LANGUAGES, strings: i18n.stringsFor(lang) });
const mainStub = `<script>
  const noop = () => {}; window.__cb = {}; window.__asked = []; window.__wav = []; window.__webm = [];
  window.api = new Proxy({ getI18n: () => Promise.resolve(${I18N('ru')}),
    getSettings: () => Promise.resolve({ theme: 'dark', fontSize: 16, fontFamily: 'Arial, sans-serif' }),
    onSettingsUpdated: (cb) => { window.__cb.settings = cb; },
    getEngineStatus: () => Promise.resolve({ state: 'ready', translate: { installed: ['en'], queue: [], failed: {} } }),
    translateCatalog: () => Promise.resolve([]), getAccount: () => Promise.resolve({ signedIn: true, limited: false }),
    loadHistory: () => Promise.resolve([]), transcribed: () => Promise.resolve({ copied: false }),
    transcribe: async (blob) => { window.__wav.push(new Uint8Array(await blob.arrayBuffer())); return { success: true, text: 'ok', language: 'ru' }; },
    recordingBegin: () => Promise.resolve({ id: 'p' + window.__webm.length, file: 'C:/x/audio_' + window.__webm.push([]) + '.webm' }),
    recordingChunk: (file, blob) => { window.__webm[window.__webm.length - 1].push(blob); },
    recordingEnd: (id, file) => Promise.resolve({ file, seconds: 1, id }),
  }, { get: (t, k) => (k in t ? t[k] : noop) });
  // A two-channel microphone: a 440 Hz tone (amplitude 0.6) on the left, silence on the right.
  navigator.mediaDevices.getUserMedia = async (c) => { window.__asked.push(c);
    const ctx = new AudioContext(); const o = ctx.createOscillator(); o.frequency.value = 440; const g = ctx.createGain(); g.gain.value = 0.6;
    const m = ctx.createChannelMerger(2); o.connect(g); g.connect(m, 0, 0);
    const d = ctx.createMediaStreamDestination(); d.channelCount = 2; m.connect(d); o.start(); await ctx.resume(); return d.stream; };
</script>`;
const settingsStub = (lang) => `<script>
  const noop = () => {};
  window.settingsApi = { send: (ch, data) => { if (ch === 'save-all-settings') window.__savedSettings = data; }, receive: noop,
    onInitialSettings: (cb) => { window.__init = cb; }, getAppVersion: () => Promise.resolve('1.0.8'), getI18n: () => Promise.resolve(${'${I18N}'}),
    getEngineStatus: () => Promise.resolve({ model: 'small', state: 'ready', models: { small: { installed: true, size: 486212000 } } }),
    onEngineStatus: noop, deleteModel: noop,
    getAccount: () => Promise.resolve({ signedIn: true, email: 'someone@example.com', plan: 'free', limited: true, remaining: 2600, resetsAt: Date.now() + 4 * 3600e3 }),
    onAccountUpdated: noop, signOut: noop, openTerms: noop, openSupport: noop, confirmBox: () => Promise.resolve(true),
    getSaveFolder: () => Promise.resolve('C:\\\\Users\\\\someone\\\\Downloads\\\\Audiator'), chooseFolder: noop, openFolder: noop };
</script>`.replace('${I18N}', I18N(lang));

let failed = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const name = u.pathname.replace(/^\//, ''), lang = u.searchParams.get('lang') || 'ru', theme = u.searchParams.get('theme') || 'dark';
    fs.readFile(path.join(ROOT, name), 'utf8', (e, d) => {
      if (e) { res.writeHead(404); res.end(); return; }
      if (name === 'index.html') d = d.replace('<head>', '<head>' + mainStub);
      if (name === 'settings.html') { d = d.replace('<head>', '<head>' + settingsStub(lang)); if (theme === 'light') d = d.replace('<body>', '<body class="light-theme">'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/`;

  const w = new BrowserWindow({ width: 400, height: 600, show: false, frame: false, webPreferences: { autoplayPolicy: 'no-user-gesture-required' } });
  await w.loadURL(base + 'index.html');
  await sleep(800);
  const js = (c) => w.webContents.executeJavaScript(c);
  const record = async () => { await js(`document.getElementById('record-btn').click()`); await sleep(2500); await js(`document.getElementById('stop-btn').click()`); await sleep(1500); };

  await record();
  const asked = await js('window.__asked[0]');
  check('noise suppression and automatic gain on, echo cancellation off',
    asked.audio.echoCancellation === false && asked.audio.noiseSuppression === true && asked.audio.autoGainControl === true,
    JSON.stringify(asked));
  // The engine's WAV: the average of both channels — the left tone at half its level.
  const rms = await js(`(() => { const b = window.__wav[0]; const v = new DataView(b.buffer); let s = 0, n = 0;
    for (let i = 44 + 16000; i + 1 < b.length - 1600; i += 2) { const x = v.getInt16(i, true) / 32768; s += x * x; n++; }
    return { rms: Math.sqrt(s / n), seconds: (b.length - 44) / 32000 }; })()`);
  // A sine of amplitude 0.6 has RMS 0.424; its average with silence, 0.212.
  check('the engine gets both channels as one (their average), not just the left', Math.abs(rms.rms - 0.212) < 0.04, JSON.stringify(rms));
  // The saved recording: two channels, made seekable as before.
  const webm = Buffer.from(await js(`new Blob(window.__webm[0]).arrayBuffer().then((b) => Array.from(new Uint8Array(b)))`));
  const chIdx = webm.indexOf(Buffer.from([0x9F, 0x81]));
  // A microphone alone goes into the file in mono (what a microphone with its processing gives; 2026-10-06).
  check('a microphone alone is recorded in mono', chIdx > 0 && webm[chIdx + 2] === 1, `channels byte: ${chIdx > 0 ? webm[chIdx + 2] : '-'}`);
  check('...and is made seekable', !!makeSeekable(webm));
  // How much of the recording the engine got: the saved file against the WAV.
  const fixed = makeSeekable(webm); const di = fixed.indexOf(Buffer.from([0x44, 0x89, 0x01, 0, 0, 0, 0, 0, 0, 0x08]));
  const fileSeconds = fixed.readDoubleBE(di + 10) / 1000;
  console.log('   file', fileSeconds.toFixed(2), 's, engine WAV', rms.seconds.toFixed(2), 's: missing', (fileSeconds - rms.seconds).toFixed(2), 's');

  // Settings: no microphone switch; they fit a 14" laptop at 125 %.
  for (const lang of ['ru', 'en', 'zh']) for (const theme of ['dark', 'light']) {
    const s = new BrowserWindow({ width: 450, height: 766, useContentSize: true, show: false });
    await s.loadURL(base + `settings.html?lang=${lang}&theme=${theme}`);
    await sleep(800);
    const sjs = (c) => s.webContents.executeJavaScript(c);
    if (lang === 'ru' && theme === 'dark') {
      check('Settings: no microphone switch', (await sjs(`!document.getElementById('noise-check')`)) === true);
      const need = await sjs(`Math.ceil(document.querySelector('.settings-actions').getBoundingClientRect().bottom + 20)`);
      check('Settings fit a 14\" laptop at 125 % (766 px: 816 less 50)', need <= 766, `needs ${need}`);
      console.log('   settings: height needed =', need);
    }
    await s.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `mic-settings-${lang}-${theme}.png`), (await s.webContents.capturePage()).toPNG());
    s.destroy();
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  app.exit(failed ? 1 : 0);
});
