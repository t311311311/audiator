// Stand: the computer's own sound recorded for real (Windows loopback through
// the main process, index.js setDisplayMediaRequestHandler). The real app with
// its own data folder, accounts server, a temporary folder for recordings and
// a stand-in engine. The page itself plays a quiet 997 Hz tone (about -40 dBFS,
// a few seconds) — that is the computer's sound; with "Звук компьютера" the
// engine must hear it, and the file must have both channels. "Both" is tried
// with a stand-in microphone (a 440 Hz tone): the engine hears both.
//   node tests\e2e\source-e2e.js        (Node 22+; needs app-launcher.js beside it)
const { spawn, execSync } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const ROOT = 'C:/Test01/tray-translator';
const PORT = 3123, DBG = 9345, ENGINE = 8025;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-source-'));
const ud = path.join(tmp, 'ud'), folder = path.join(tmp, 'records');
fs.mkdirSync(ud, { recursive: true });
fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({ saveFolder: folder, recordSource: 'system' }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server, appProc, serverLog = '', failed = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const kill = () => { try { execSync(`taskkill /PID ${appProc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) {} };
const done = (c) => { kill(); try { server.kill(); } catch (e) {} try { engine.close(); } catch (e) {} process.exit(c); };
setTimeout(() => { console.log('timeout'); done(2); }, 150000);

// A stand-in engine that keeps the WAV it was sent.
const wavs = [];
const engine = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/status') return json({ model: 'small', state: 'ready', models: { small: { installed: true, size: 1 } }, translate: { installed: ['en'], queue: [], failed: {} } });
  if (u.pathname === '/asr/start') {
    const parts = []; req.on('data', (d) => parts.push(d)); req.on('end', () => {
      const body = Buffer.concat(parts); const at = body.indexOf('RIFF');
      const n = at >= 0 ? body.readUInt32LE(at + 40) : 0;
      wavs.push(body.subarray(at + 44, at + 44 + n)); json({ id: String(wavs.length) });
    });
    return;
  }
  if (u.pathname === '/asr/job') return json({ state: 'done', result: { text: 'звук', language: 'ru', duration: 2, segments: [] } });
  json({});
});
// How strong a frequency is in 16 kHz 16-bit PCM (Goertzel): its share of the
// signal (2 for a pure tone) and its own level, dB RMS.
function share(pcm, hz) {
  const n = Math.floor(pcm.length / 2), k = 2 * Math.cos(2 * Math.PI * hz / 16000);
  let s1 = 0, s2 = 0, e = 0;
  for (let i = 0; i < n; i++) { const x = pcm.readInt16LE(2 * i) / 32768; const s0 = x + k * s1 - s2; s2 = s1; s1 = s0; e += x * x; }
  const amp2 = (s1 * s1 + s2 * s2 - k * s1 * s2) / (n * n / 4); // the tone's amplitude, squared
  return { share: +(amp2 / (e / n + 1e-15)).toFixed(3), toneDb: +(10 * Math.log10(amp2 / 2 + 1e-15)).toFixed(1), rmsDb: +(10 * Math.log10(e / n + 1e-15)).toFixed(1) };
}

async function targets() { try { return await (await fetch(`http://127.0.0.1:${DBG}/json`)).json(); } catch (e) { return []; } }
function connect(url) {
  const ws = new WebSocket(url); let id = 0; const wait = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  return new Promise((res) => ws.onopen = () => res({ js: async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result.result.value;
  } }));
}
async function page(file) {
  for (let i = 0; i < 120; i++) {
    const t = (await targets()).find((x) => x.type === 'page' && x.url.split('?')[0].endsWith('/' + file));
    if (t) return connect(t.webSocketDebuggerUrl);
    await sleep(250);
  }
  throw new Error('no ' + file);
}

(async () => {
  await new Promise((r) => engine.listen(ENGINE, '127.0.0.1', r));
  server = spawn(path.join(ROOT, '.venv/Scripts/python.exe'), ['-m', 'uvicorn', 'main:app', '--port', String(PORT)], {
    cwd: path.join(ROOT, 'auth-server'), windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', SMTP_HOST: '', MAIL_DEV_PRINT: '1',
           ACCOUNTS_DATABASE_URL: 'sqlite:///' + path.join(tmp, 'a.db').split(path.sep).join('/') } });
  server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 100 && !/Uvicorn running/.test(serverLog); i++) await sleep(200);

  appProc = spawn(path.join(ROOT, 'node_modules/electron/dist/electron.exe'), [`--remote-debugging-port=${DBG}`, path.join(__dirname, 'app-launcher.js')],
    { cwd: ROOT, env: { ...process.env, AUD_TEST_USERDATA: ud, AUDIATOR_ACCOUNTS_URL: `http://127.0.0.1:${PORT}`, AUDIATOR_ENGINE_PORT: String(ENGINE) } });
  const login = await page('login.html'); await sleep(800);
  await login.js(`document.getElementById('email').value = 'source@example.com'; document.getElementById('accept').click(); document.getElementById('get-code').click();`);
  let code; for (let i = 0; i < 50 && !(code = (serverLog.match(/sign-in code for source@example\.com: (\d{6})/) || [])[1]); i++) await sleep(100);
  await login.js(`const c = document.getElementById('code'); c.value = '${code}'; c.dispatchEvent(new Event('input'));`);
  const main = await page('index.html'); await sleep(2000);

  // The computer's sound: a quiet tone played by the page, recorded through Windows.
  const recordWhilePlaying = async () => {
    const n = wavs.length;
    await main.js(`(() => { const c = new AudioContext(); const o = c.createOscillator(); o.frequency.value = 997; const g = c.createGain(); g.gain.value = 0.01;
      o.connect(g); g.connect(c.destination); o.start(); c.resume(); window.__tone = c; document.getElementById('record-btn').click(); })()`);
    await sleep(3000);
    await main.js(`document.getElementById('stop-btn').click()`);
    await sleep(600);
    await main.js(`window.__tone.close()`);
    for (let i = 0; i < 60 && wavs.length === n; i++) await sleep(250);
    return wavs.length > n ? wavs[wavs.length - 1] : null;
  };
  let pcm = await recordWhilePlaying();
  const sys = pcm && share(pcm, 997);
  check('"Звук компьютера": what the computer plays reaches the engine (997 Hz)', !!sys && sys.share > 0.3, JSON.stringify(sys));
  await sleep(1500);
  const files = fs.existsSync(folder) ? fs.readdirSync(folder).filter((f) => f.endsWith('.webm')) : [];
  const head = files.length ? fs.readFileSync(path.join(folder, files[0])) : Buffer.alloc(0);
  const ch = head.indexOf(Buffer.from([0x9F, 0x81]));
  check('...its file has both channels', ch > 0 && head[ch + 2] === 2, `${files[0]}: channels ${ch > 0 ? head[ch + 2] : '-'}`);
  const oh = head.indexOf(Buffer.from('OpusHead'));
  const gain = oh > 0 ? head.readInt16LE(oh + 16) / 256 : null;
  // The tone played quietly (about -45 dBFS at its peak): brought up by the most allowed, +24 dB, in the Opus header.
  check('...a quiet recording is made louder to play (Opus header gain)', gain !== null && gain >= 20 && gain <= 24, `gain ${gain} dB`);
  check('...no screen is being captured any more', (await main.js(`document.getElementById('stop-btn').classList.contains('hidden')`)) === true);

  // Both, with a stand-in microphone (440 Hz) — the computer's sound still the real one.
  await main.js(`(() => { navigator.mediaDevices.getUserMedia = async () => { const c = new AudioContext(); const o = c.createOscillator(); o.frequency.value = 440;
      const g = c.createGain(); g.gain.value = 0.2; const d = c.createMediaStreamDestination(); o.connect(g); g.connect(d); o.start(); await c.resume(); return d.stream; };
    recordSource = 'both'; })()`);
  pcm = await recordWhilePlaying();
  const both = pcm && { mic: share(pcm, 440), sys: share(pcm, 997) };
  // The computer's tone is as loud in the mix as on its own (the microphone does not drown it out of the recording).
  check('"Микрофон + звук компьютера": the engine hears both, the computer at its own level',
    !!both && both.mic.toneDb > -25 && Math.abs(both.sys.toneDb - sys.toneDb) < 3, JSON.stringify({ alone: sys.toneDb, ...both }));
  console.log('folder: ' + folder);
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  done(failed ? 1 : 0);
})().catch((e) => { console.error(e); done(1); });
