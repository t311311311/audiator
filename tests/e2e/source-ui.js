// Stand: "What to record" — the microphone, the computer's sound, or both
// (user's wish 2026-10-06). The real index.html and settings.html with a
// stand-in api; the microphone is a 440 Hz tone, the computer's sound a 997 Hz
// tone with a screen video track beside it (as getDisplayMedia gives).
// Checks per mode: what is opened and how; the screen video stopped at once;
// which tones reach the engine; everything closed after the recording; a
// refusal of the computer's sound said, nothing recorded; Settings offer the
// three modes in 3 languages x 2 themes and fit a laptop screen.
//   node_modules\.bin\electron tests\e2e\source-ui.js
const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs'), http = require('http');
const ROOT = path.resolve('C:/Test01/tray-translator/src');
const OUT = __dirname;
const i18n = require(path.join(ROOT, 'i18n.js'));
setTimeout(() => { console.error('timeout'); app.exit(2); }, 120000);
const I18N = (lang) => JSON.stringify({ lang, languages: i18n.LANGUAGES, strings: i18n.stringsFor(lang) });

const mainStub = `<script>
  const noop = () => {}; window.__cb = {}; window.__wav = []; window.__asked = { mic: [], sys: [] }; window.__tracks = [];
  window.__refuse = false; window.__started = 0;
  window.api = new Proxy({ getI18n: () => Promise.resolve(${I18N('ru')}),
    getSettings: () => Promise.resolve({ theme: 'dark', recordSource: 'mic' }), onSettingsUpdated: (cb) => { window.__cb.settings = cb; },
    getEngineStatus: () => Promise.resolve({ state: 'ready', translate: { installed: ['en'], queue: [], failed: {} } }),
    translateCatalog: () => Promise.resolve([]), getAccount: () => Promise.resolve({ signedIn: true, limited: false }),
    loadHistory: () => Promise.resolve([]), pendingList: () => Promise.resolve([]), transcribed: () => Promise.resolve({ copied: false }),
    recordingStarted: () => { window.__started++; }, recordingBegin: () => Promise.resolve(null),
    transcribe: async (blob) => { window.__wav.push(new Uint8Array(await blob.arrayBuffer())); return { success: true, text: 'ok', language: 'ru' }; },
  }, { get: (t, k) => (k in t ? t[k] : noop) });
  const tone = async (hz, channels) => { const c = new AudioContext(); const o = c.createOscillator(); o.frequency.value = hz;
    const g = c.createGain(); g.gain.value = 0.3; const d = c.createMediaStreamDestination(); d.channelCount = channels;
    o.connect(g); g.connect(d); o.start(); await c.resume(); return d.stream; };
  navigator.mediaDevices.getUserMedia = async (c) => { window.__asked.mic.push(c); const s = await tone(440, 1); window.__tracks.push(...s.getTracks()); return s; };
  navigator.mediaDevices.getDisplayMedia = async (c) => { window.__asked.sys.push(c);
    if (window.__refuse) throw new DOMException('Permission denied', 'NotAllowedError');
    const s = await tone(997, 2); const canvas = document.createElement('canvas'); const v = canvas.captureStream(5).getVideoTracks()[0];
    s.addTrack(v); window.__tracks.push(...s.getTracks()); window.__video = v; return s; };
  // How strong a frequency is in a 16 kHz WAV (Goertzel), as a share of the signal.
  window.__power = (b, hz) => { const v = new DataView(b.buffer, b.byteOffset); const n = Math.floor((b.length - 44) / 2);
    const k = 2 * Math.cos(2 * Math.PI * hz / 16000); let s1 = 0, s2 = 0, e = 0;
    for (let i = 0; i < n; i++) { const x = v.getInt16(44 + 2 * i, true) / 32768; const s0 = x + k * s1 - s2; s2 = s1; s1 = s0; e += x * x; }
    return (s1 * s1 + s2 * s2 - k * s1 * s2) / (n * n / 4) / (e / n + 1e-12); };
</script>`;
const settingsStub = (lang) => `<script>
  const noop = () => {};
  window.settingsApi = { send: (ch, data) => { if (ch === 'save-all-settings') window.__saved = data; }, receive: noop,
    onInitialSettings: (cb) => { window.__init = cb; }, getAppVersion: () => Promise.resolve('1.0.8'), getI18n: () => Promise.resolve(${I18N(lang)}),
    getEngineStatus: () => Promise.resolve({ model: 'small', state: 'ready', models: { small: { installed: true, size: 486212000 } } }),
    onEngineStatus: noop, deleteModel: noop,
    getAccount: () => Promise.resolve({ signedIn: true, email: 'someone@example.com', plan: 'free', limited: true, remaining: 2600, limit: 7200, resetsAt: Date.now() + 4 * 3600e3 }),
    onAccountUpdated: noop, signOut: noop, openTerms: noop, openSupport: noop, confirmBox: () => Promise.resolve(true),
    getSaveFolder: () => Promise.resolve('C:\\\\Users\\\\someone\\\\Downloads\\\\Audiator'), chooseFolder: noop, openFolder: noop };
</script>`;

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
  const record = async () => {
    const n = await js('window.__wav.length');
    await js(`document.getElementById('record-btn').click()`); await sleep(2200);
    await js(`document.getElementById('stop-btn').click()`);
    for (let i = 0; i < 40 && (await js('window.__wav.length')) === n; i++) await sleep(100);
    await sleep(300);
    return js(`(() => { const b = window.__wav[window.__wav.length - 1]; return { mic: window.__power(b, 440), sys: window.__power(b, 997), none: window.__power(b, 2000) }; })()`);
  };
  const allClosed = () => js(`window.__tracks.every((t) => t.readyState === 'ended')`);
  const mode = (m) => js(`window.__cb.settings({ theme: 'dark', recordSource: '${m}' })`);

  // Microphone (the default)
  let p = await record();
  let asked = await js('window.__asked');
  check('Microphone: only the microphone, with its processing', asked.mic.length === 1 && asked.sys.length === 0 && asked.mic[0].audio.noiseSuppression === true);
  check('...the engine hears the microphone (440 Hz)', p.mic > 0.2 && p.sys < 0.01, JSON.stringify(p));
  check('...closed after the recording', await allClosed());

  // Computer sound
  await mode('system');
  p = await record();
  asked = await js('window.__asked');
  const sysAsk = asked.sys[0] || {};
  check('Computer sound: only it, untouched (no call processing), both channels',
    asked.sys.length === 1 && asked.mic.length === 1 && sysAsk.video === true && sysAsk.audio.noiseSuppression === false &&
    sysAsk.audio.autoGainControl === false && sysAsk.audio.echoCancellation === false && sysAsk.audio.channelCount === 2, JSON.stringify(sysAsk));
  check('...the screen video stopped at once', (await js('window.__video.readyState')) === 'ended');
  check('...the engine hears the computer (997 Hz), not a microphone', p.sys > 0.2 && p.mic < 0.01, JSON.stringify(p));
  check('...closed after the recording', await allClosed());

  // Both
  await mode('both');
  p = await record();
  asked = await js('window.__asked');
  check('Both: the microphone and the computer', asked.sys.length === 2 && asked.mic.length === 2);
  check('...the engine hears both (440 and 997 Hz)', p.mic > 0.05 && p.sys > 0.05 && p.none < 0.01, JSON.stringify(p));
  check('...everything closed after the recording (both sources and the mix)', await allClosed());

  // The computer's sound refused
  await js('window.__refuse = true');
  const started = await js('window.__started');
  await js(`document.getElementById('record-btn').click()`); await sleep(800);
  const toast = await js(`document.getElementById('toast').textContent`);
  check('refused: said so, nothing recorded, the microphone not even opened',
    toast.startsWith(i18n.stringsFor('ru')['error.systemAudio']) && (await js('window.__started')) === started &&
    (await js(`document.getElementById('stop-btn').classList.contains('hidden')`)) && (await js('window.__asked.mic.length')) === 2, toast);

  // Settings
  for (const lang of ['ru', 'en', 'zh']) for (const theme of ['dark', 'light']) {
    const s = new BrowserWindow({ width: 450, height: 766, useContentSize: true, show: false });
    await s.loadURL(base + `settings.html?lang=${lang}&theme=${theme}`);
    await sleep(800);
    const sjs = (c) => s.webContents.executeJavaScript(c);
    const L = i18n.stringsFor(lang);
    const opts = await sjs(`[...document.querySelectorAll('#source-select option')].map((o) => o.value + ':' + o.textContent)`);
    check(`${lang}/${theme}: Settings offer the three modes`,
      JSON.stringify(opts) === JSON.stringify([`mic:${L['settings.sourceMic']}`, `system:${L['settings.sourceSystem']}`, `both:${L['settings.sourceBoth']}`]), JSON.stringify(opts));
    if (lang === 'ru' && theme === 'dark') {
      await sjs(`window.__init({ theme: 'dark', recordSource: 'mic', whisperModel: 'small' })`); await sleep(100);
      check('Settings: what is saved is shown; what it means on hover', (await sjs(`document.getElementById('source-select').value`)) === 'mic' &&
        (await sjs(`document.getElementById('source-select').title`)) === L['settings.sourceHint']);
      await sjs(`const sel = document.getElementById('source-select'); sel.value = 'both'; sel.dispatchEvent(new Event('change')); document.getElementById('save-settings-btn').click();`);
      check('picked and saved: recordSource = both', (await sjs('window.__saved.recordSource')) === 'both');
      const need = await sjs(`Math.ceil(document.querySelector('.settings-actions').getBoundingClientRect().bottom + 20)`);
      check('Settings fit a 14" laptop at 125 % (766 px)', need <= 766, `needs ${need}`);
    }
    await s.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `source-settings-${lang}-${theme}.png`), (await s.webContents.capturePage()).toPNG());
    s.destroy();
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  app.exit(failed ? 1 : 0);
});
