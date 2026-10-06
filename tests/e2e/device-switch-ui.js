// Stand: the device changes mid-recording (user, 2026-10-06: wired headphones
// plugged in during "microphone + computer sound" — the computer's sound
// stopped; unplugged — the microphone stopped). The real index.html with a
// stand-in api and stand-in devices: Windows' default devices (labels) and the
// tones they give change on the fly, then "devicechange" comes, or a source
// ends by itself. Checks: one recording, never restarted; only the source
// whose device changed is opened again; the engine hears the sound from
// before and after every switch; replaced sources are closed.
//   node_modules\.bin\electron tests\e2e\device-switch-ui.js
const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs'), http = require('http');
const ROOT = path.resolve('C:/Test01/tray-translator/src');
const i18n = require(path.join(ROOT, 'i18n.js'));
setTimeout(() => { console.error('timeout'); app.exit(2); }, 90000);
const I18N = JSON.stringify({ lang: 'ru', languages: i18n.LANGUAGES, strings: i18n.stringsFor('ru') });

const stub = `<script>
  const noop = () => {}; window.__cb = {}; window.__wav = []; window.__opened = { mic: 0, sys: 0 }; window.__tracks = []; window.__starts = 0; window.__begins = 0;
  window.__defaults = { mic: 'Default - Набор микрофонов', sys: 'Default - Динамики' }; window.__hz = { mic: 440, sys: 997 };
  window.api = new Proxy({ getI18n: () => Promise.resolve(${I18N}),
    getSettings: () => Promise.resolve({ theme: 'dark', recordSource: 'both' }), onSettingsUpdated: (cb) => { window.__cb.settings = cb; },
    getEngineStatus: () => Promise.resolve({ state: 'ready', translate: { installed: ['en'], queue: [], failed: {} } }),
    translateCatalog: () => Promise.resolve([]), getAccount: () => Promise.resolve({ signedIn: true, limited: false }),
    loadHistory: () => Promise.resolve([]), pendingList: () => Promise.resolve([]), transcribed: () => Promise.resolve({ copied: false }),
    recordingStarted: () => { window.__starts++; }, recordingBegin: () => { window.__begins++; return Promise.resolve(null); },
    transcribe: async (blob) => { window.__wav.push(new Uint8Array(await blob.arrayBuffer())); return { success: true, text: 'ok', language: 'ru' }; },
  }, { get: (t, k) => (k in t ? t[k] : noop) });
  const tone = async (hz, channels) => { const c = new AudioContext(); const o = c.createOscillator(); o.frequency.value = hz;
    const g = c.createGain(); g.gain.value = 0.25; const d = c.createMediaStreamDestination(); d.channelCount = channels;
    o.connect(g); g.connect(d); o.start(); await c.resume(); return d.stream; };
  navigator.mediaDevices.enumerateDevices = async () => [
    { kind: 'audioinput', deviceId: 'default', label: window.__defaults.mic }, { kind: 'audiooutput', deviceId: 'default', label: window.__defaults.sys }];
  navigator.mediaDevices.getUserMedia = async () => { window.__opened.mic++; const s = await tone(window.__hz.mic, 1); window.__tracks.push(...s.getTracks()); return s; };
  navigator.mediaDevices.getDisplayMedia = async () => { window.__opened.sys++; const s = await tone(window.__hz.sys, 2);
    const v = document.createElement('canvas').captureStream(5).getVideoTracks()[0]; s.addTrack(v); window.__tracks.push(...s.getTracks());
    window.__sysTrack = s.getAudioTracks()[0]; return s; };
  window.__power = (b, hz) => { const v = new DataView(b.buffer, b.byteOffset); const n = Math.floor((b.length - 44) / 2);
    const k = 2 * Math.cos(2 * Math.PI * hz / 16000); let s1 = 0, s2 = 0, e = 0;
    for (let i = 0; i < n; i++) { const x = v.getInt16(44 + 2 * i, true) / 32768; const s0 = x + k * s1 - s2; s2 = s1; s1 = s0; e += x * x; }
    return +((s1 * s1 + s2 * s2 - k * s1 * s2) / (n * n / 4) / (e / n + 1e-12)).toFixed(3); };
</script>`;

let failed = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const srv = http.createServer((req, res) => {
    const name = req.url.split('?')[0].replace(/^\//, '');
    fs.readFile(path.join(ROOT, name), 'utf8', (e, d) => {
      if (e) { res.writeHead(404); res.end(); return; }
      if (name === 'index.html') d = d.replace('<head>', '<head>' + stub);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const w = new BrowserWindow({ width: 400, height: 600, show: false, frame: false, webPreferences: { autoplayPolicy: 'no-user-gesture-required' } });
  await w.loadURL(`http://127.0.0.1:${srv.address().port}/index.html`);
  await sleep(800);
  const js = (c) => w.webContents.executeJavaScript(c);
  const change = (kind, label, hz) => js(`window.__defaults.${kind} = '${label}'; window.__hz.${kind} = ${hz}; navigator.mediaDevices.dispatchEvent(new Event('devicechange'))`);
  const finish = async () => {
    await js(`document.getElementById('stop-btn').click()`);
    for (let i = 0; i < 40 && !(await js('window.__wav.length')); i++) await sleep(100);
  };

  // "Both": headphones plugged in (the default output changes), then a headset
  // microphone becomes the default, then the computer's sound ends by itself.
  await js(`document.getElementById('record-btn').click()`); await sleep(1500);
  await change('sys', 'Default - Наушники', 660); await sleep(1800);
  let o = await js('window.__opened');
  check('headphones plugged in: the computer\'s sound opened again, the microphone left alone', o.sys === 2 && o.mic === 1, JSON.stringify(o));
  await change('mic', 'Default - Микрофон (гарнитура)', 550); await sleep(1800);
  o = await js('window.__opened');
  check('a new default microphone: the microphone opened again, the computer\'s sound left alone', o.sys === 2 && o.mic === 2, JSON.stringify(o));
  await js(`window.__hz.sys = 770; window.__sysTrack.dispatchEvent(new Event('ended'))`); await sleep(1500);
  o = await js('window.__opened');
  check('a source that ends by itself is opened again', o.sys === 3, JSON.stringify(o));
  check('still the one recording (never restarted, one file)', (await js('window.__starts')) === 1 && (await js('window.__begins')) === 1 &&
    (await js(`!document.getElementById('stop-btn').classList.contains('hidden')`)));
  await finish();
  const p = await js(`(() => { const b = window.__wav[0]; return { mic440: window.__power(b, 440), mic550: window.__power(b, 550), sys997: window.__power(b, 997), sys660: window.__power(b, 660), sys770: window.__power(b, 770), none: window.__power(b, 2000) }; })()`);
  check('the engine hears every source, before and after each switch', p.mic440 > 0.05 && p.mic550 > 0.05 && p.sys997 > 0.05 && p.sys660 > 0.05 && p.sys770 > 0.03 && p.none < 0.01, JSON.stringify(p));
  check('replaced and finished sources are all closed', await js(`window.__tracks.every((t) => t.readyState === 'ended')`));

  // Microphone only: a change of the default output does not touch it.
  await js(`window.__cb.settings({ theme: 'dark', recordSource: 'mic' }); window.__opened = { mic: 0, sys: 0 }; window.__wav = []`);
  await js(`document.getElementById('record-btn').click()`); await sleep(1200);
  await change('sys', 'Default - Динамики', 997); await sleep(1500);
  o = await js('window.__opened');
  check('microphone only: an output change leaves it alone', o.mic === 1 && o.sys === 0, JSON.stringify(o));
  await change('mic', 'Default - Набор микрофонов', 440); await sleep(1500);
  check('...a microphone change opens it again', (await js('window.__opened.mic')) === 2);
  await finish();
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  app.exit(failed ? 1 : 0);
});
