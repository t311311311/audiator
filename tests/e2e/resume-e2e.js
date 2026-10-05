// Stand: nothing recorded is lost (user's wish 2026-10-05). The real app with
// its own data folder, accounts server and a temporary folder for recordings;
// a stand-in speech engine on a spare port that can hold a job ("still
// transcribing") or answer it. The app is killed twice, as a crash would:
//   A. while recording        -> the file already holds what was said
//   B. next start: the file is made whole and transcribed again; killed while
//      the engine is at it
//   C. next start: the text arrives and goes in among the history by its time,
//      with ▶, a note; the queue on disk is empty
//   D. next start: nothing is transcribed twice
//   E. menu "Распознать аудиофайл…" (the pick given by AUDIATOR_TEST_PICK):
//      the file goes in at its own time; it is never deleted
//   node tests\e2e\resume-e2e.js        (Node 22+; needs app-launcher.js beside it)
const { spawn, execSync } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const ROOT = 'C:/Test01/tray-translator';
const PORT = 3119, DBG = 9343, ENGINE = 8023;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-resume-'));
const ud = path.join(tmp, 'ud'), folder = path.join(tmp, 'records');
fs.mkdirSync(ud, { recursive: true });
fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({ saveFolder: folder })); // electron-store
const pendingFile = path.join(ud, 'pending.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server, appProc, serverLog = '', failed = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const kill = () => { try { execSync(`taskkill /PID ${appProc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) {} };
const done = (c) => { kill(); try { server.kill(); } catch (e) {} try { engine.close(); } catch (e) {} process.exit(c); };
setTimeout(() => { console.log('timeout'); done(2); }, 240000);

// --- a stand-in engine: holds jobs, or answers them with their length ---
let mode = 'hold';
const jobs = [];
const engine = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/status') return json({ model: 'small', state: 'ready', models: { small: { installed: true, size: 1 } }, translate: { installed: ['en'], queue: [], failed: {} } });
  if (u.pathname === '/asr/start') {
    const parts = []; req.on('data', (d) => parts.push(d)); req.on('end', () => {
      const body = Buffer.concat(parts); const at = body.indexOf('RIFF');
      const seconds = at >= 0 ? body.readUInt32LE(at + 40) / 32000 : 0;
      const job = { id: String(jobs.length + 1), seconds, at: Date.now() }; jobs.push(job); json({ id: job.id });
    });
    return;
  }
  if (u.pathname === '/asr/job') {
    const job = jobs.find((j) => j.id === u.searchParams.get('id'));
    if (mode === 'hold') return json({ state: 'running', done: 0, total: 1 });
    return json({ state: 'done', result: { text: `текст ${job.seconds.toFixed(1)} с`, language: 'ru', duration: job.seconds, segments: [] } });
  }
  json({});
});

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
function launch(extra = {}) {
  appProc = spawn(path.join(ROOT, 'node_modules/electron/dist/electron.exe'), [`--remote-debugging-port=${DBG}`, path.join(__dirname, 'app-launcher.js')],
    { cwd: ROOT, env: { ...process.env, AUD_TEST_USERDATA: ud, AUDIATOR_ACCOUNTS_URL: `http://127.0.0.1:${PORT}`, AUDIATOR_ENGINE_PORT: String(ENGINE), ...extra } });
  return new Promise((r) => appProc.on('spawn', r));
}
const pendingNow = () => { try { return JSON.parse(fs.readFileSync(pendingFile, 'utf8')).items; } catch (e) { return []; } };
const entries = (main) => main.js(`[...document.querySelectorAll('.history-entry')].map((e) => ({ t: e.dataset.isoTimestamp,
  text: e.querySelector('.original-text').textContent, play: !e.querySelector('.entry-play').hidden, audio: e.dataset.audio || null }))`);
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(250); } return null; };
const durationOf = (file) => { const b = fs.readFileSync(file); const i = b.indexOf(Buffer.from([0x44, 0x89, 0x01, 0, 0, 0, 0, 0, 0, 0x08])); return i < 0 ? null : b.readDoubleBE(i + 10) / 1000; };

(async () => {
  await new Promise((r) => engine.listen(ENGINE, '127.0.0.1', r));
  server = spawn(path.join(ROOT, '.venv/Scripts/python.exe'), ['-m', 'uvicorn', 'main:app', '--port', String(PORT)], {
    cwd: path.join(ROOT, 'auth-server'), windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', SMTP_HOST: '', MAIL_DEV_PRINT: '1',
           ACCOUNTS_DATABASE_URL: 'sqlite:///' + path.join(tmp, 'a.db').split(path.sep).join('/') } });
  server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 100 && !/Uvicorn running/.test(serverLog); i++) await sleep(200);

  // --- A: two texts in the history (one later, one earlier), then a recording, killed while recording ---
  await launch();
  const login = await page('login.html'); await sleep(800);
  await login.js(`document.getElementById('email').value = 'resume@example.com'; document.getElementById('accept').click(); document.getElementById('get-code').click();`);
  let code; for (let i = 0; i < 50 && !(code = (serverLog.match(/sign-in code for resume@example\.com: (\d{6})/) || [])[1]); i++) await sleep(100);
  await login.js(`const c = document.getElementById('code'); c.value = '${code}'; c.dispatchEvent(new Event('input'));`);
  let main = await page('index.html'); await sleep(1500);
  const T0 = Date.now();
  await main.js(`(() => {
    const mk = (t, text) => { const p = addPendingEntry(new Date(t)); const o = p.originalTextField; o.classList.remove('pending'); o.textContent = text;
      o.closest('.history-entry').dataset.lang = 'ru'; p.check.hidden = false; p.originalCopy.btn.hidden = false; };
    mk(${T0 - 2 * 3600e3}, 'раньше'); mk(${T0 + 3600e3}, 'позже'); })()`);
  // Closed properly once: Chromium keeps the key the session and the history
  // are encrypted with only some seconds after the very first start — a kill
  // before that loses the sign-in (not what is tested here).
  await sleep(800);
  { const exited = new Promise((r) => appProc.on('exit', r)); main.js('window.api.quit()').catch(() => {}); await exited; }
  await launch();
  main = await page('index.html'); await sleep(2000);
  await main.js(`(() => {
    navigator.mediaDevices.getUserMedia = async () => { const c = new AudioContext(); const o = c.createOscillator(); const g = c.createGain(); g.gain.value = 0.3;
      const d = c.createMediaStreamDestination(); o.connect(g); g.connect(d); o.start(); await c.resume(); return d.stream; };
    document.getElementById('record-btn').click();
  })()`);
  await sleep(1800);
  const file = await until(() => (fs.existsSync(folder) && fs.readdirSync(folder).find((f) => /^audio_.*\.webm$/.test(f))) || null, 3000);
  const size1 = file ? fs.statSync(path.join(folder, file)).size : 0;
  await sleep(1700);
  const size2 = file ? fs.statSync(path.join(folder, file)).size : 0;
  check('A: the file is there while recording, and grows every second', !!file && size1 > 0 && size2 > size1, `${file}: ${size1} -> ${size2} bytes`);
  check('A: queued on disk as "recording"', pendingNow().length === 1 && pendingNow()[0].state === 'recording', JSON.stringify(pendingNow()));
  kill(); await sleep(1500);
  const recFile = path.join(folder, file);

  // --- B: started again — made whole, transcribed; killed while the engine holds it ---
  mode = 'hold';
  await launch();
  main = await page('index.html');
  const job = await until(() => jobs[0], 25000);
  const seconds = durationOf(recFile);
  check('B: the cut-off file is made whole (length written)', seconds !== null && seconds > 1.5 && seconds < 5, `${seconds && seconds.toFixed(2)} s`);
  check('B: transcribed again from its file (the sound as recorded)', !!job && Math.abs(job.seconds - seconds) < 0.3, job && `${job.seconds.toFixed(2)} s sent to the engine`);
  const listB = await entries(main);
  check('B: in the history at its own time, between "позже" and "раньше"',
    listB.length === 3 && listB[0].text === 'позже' && listB[2].text === 'раньше' && /Транскрибация/.test(listB[1].text), JSON.stringify(listB.map((e) => e.text)));
  check('B: queued on disk with its length', pendingNow().length === 1 && pendingNow()[0].state === 'queued' && Math.abs(pendingNow()[0].seconds - seconds) < 0.01);
  kill(); await sleep(1500);

  // --- C: started again — the engine answers this time ---
  mode = 'answer';
  await launch();
  main = await page('index.html');
  const got = await until(async () => { const l = await entries(main); return l.find((e) => /^текст/.test(e.text)) ? l : null; }, 25000);
  check('C: its text arrives, in its place by time', !!got && got[1] && /^текст/.test(got[1].text) && got[0].text === 'позже' && got[2].text === 'раньше',
    JSON.stringify(got && got.map((e) => e.text)));
  check('C: with ▶ for its file', !!got && got[1].play && got[1].audio === recFile);
  check('C: a note says it is done', /^Распознана запись от /.test(await main.js(`document.getElementById('toast').textContent`)), await main.js(`document.getElementById('toast').textContent`));
  await sleep(600);
  check('C: the queue on disk is empty', pendingNow().length === 0, JSON.stringify(pendingNow()));
  const jobsC = jobs.length;

  // --- D and E: started again with a file to pick ---
  kill(); await sleep(1500);
  const older = path.join(folder, 'audio_101010_011026.webm');
  fs.copyFileSync(recFile, older);
  await launch({ AUDIATOR_TEST_PICK: older });
  main = await page('index.html'); await sleep(3000);
  const listD = await entries(main);
  check('D: after a restart the text is kept, nothing transcribed twice', jobs.length === jobsC && listD.length === 3 && /^текст/.test(listD[1].text) && listD[1].play,
    `${jobs.length - jobsC} new jobs; ${JSON.stringify(listD.map((e) => e.text))}`);
  await main.js(`document.getElementById('transcribe-file-btn').click()`);
  const listE = await until(async () => { const l = await entries(main); return l.length === 4 && /^текст/.test(l[3].text) ? l : null; }, 20000);
  check('E: a picked file is transcribed and goes in at its own time (1 Oct 2026 10:10:10 — the oldest)',
    !!listE && listE[3].audio === older && listE[3].play && new Date(listE[3].t).getTime() === new Date(2026, 9, 1, 10, 10, 10).getTime(),
    JSON.stringify(listE && listE.map((e) => e.text + ' @ ' + e.t)));
  await sleep(600);
  check('E: out of the queue, and the picked file is still there', pendingNow().length === 0 && fs.existsSync(older));
  console.log('folder: ' + folder);
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  done(failed ? 1 : 0);
})().catch((e) => { console.error(e); done(1); });
