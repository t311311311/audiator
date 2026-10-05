// Stand: the recordings and texts as files, in the real app (its own data
// folder, its own accounts server; the folder for recordings is a temporary
// one set in its settings — the user's Downloads are not touched).
//   node tests\e2e\library-e2e.js        (Node 22+; needs app-launcher.js beside it)
// Checks: a recording lands as audio_HHMMSS_DDMMYY.webm, seekable; a second
// with the same time gets _2; only a file this run wrote can be taken back;
// texts land one file each, named after their recording; ▶ on a missing file
// says so and nothing but a recording/text/folder is ever opened; the path
// survives a restart; signing out leaves every file where it is.
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os');
const ROOT = 'C:/Test01/tray-translator';
const { makeSeekable } = require(path.join(ROOT, 'src/webm-seekable.js'));
const PORT = 3117, DBG = 9341;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-lib-'));
const ud = path.join(tmp, 'ud'), folder = path.join(tmp, 'Audiator records');
fs.mkdirSync(ud, { recursive: true });
fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({ saveFolder: folder })); // electron-store
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server, appProc, serverLog = '', failed = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const done = (c) => { try { appProc && appProc.kill(); } catch (e) {} try { server.kill(); } catch (e) {} process.exit(c); };
setTimeout(() => { console.log('timeout'); done(2); }, 150000);

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
  for (let i = 0; i < 80; i++) {
    const t = (await targets()).find((x) => x.type === 'page' && x.url.split('?')[0].endsWith('/' + file));
    if (t) return connect(t.webSocketDebuggerUrl);
    await sleep(250);
  }
  throw new Error('no ' + file);
}
function launch() {
  appProc = spawn(path.join(ROOT, 'node_modules/electron/dist/electron.exe'), [`--remote-debugging-port=${DBG}`, path.join(__dirname, 'app-launcher.js')],
    { cwd: ROOT, env: { ...process.env, AUD_TEST_USERDATA: ud, AUDIATOR_ACCOUNTS_URL: `http://127.0.0.1:${PORT}` } });
  return new Promise((r) => appProc.on('spawn', r));
}
async function quit(main) {
  const p = new Promise((r) => appProc.on('exit', r));
  main.js('window.api.quit()').catch(() => {});
  await p;
}
// "135607_051026" for a time, as the app names files.
const stamp = (d) => { const t = (n) => String(n).padStart(2, '0');
  return `${t(d.getHours())}${t(d.getMinutes())}${t(d.getSeconds())}_${t(d.getDate())}${t(d.getMonth() + 1)}${t(d.getFullYear() % 100)}`; };

(async () => {
  server = spawn(path.join(ROOT, '.venv/Scripts/python.exe'), ['-m', 'uvicorn', 'main:app', '--port', String(PORT)], {
    cwd: path.join(ROOT, 'auth-server'), windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', SMTP_HOST: '', MAIL_DEV_PRINT: '1',
           ACCOUNTS_DATABASE_URL: 'sqlite:///' + path.join(tmp, 'a.db').split(path.sep).join('/') } });
  server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 100 && !/Uvicorn running/.test(serverLog); i++) await sleep(200);

  await launch();
  const login = await page('login.html'); await sleep(800);
  await login.js(`document.getElementById('email').value = 'lib@example.com'; document.getElementById('accept').click(); document.getElementById('get-code').click();`);
  let code; for (let i = 0; i < 50 && !(code = (serverLog.match(/sign-in code for lib@example\.com: (\d{6})/) || [])[1]); i++) await sleep(100);
  await login.js(`const c = document.getElementById('code'); c.value = '${code}'; c.dispatchEvent(new Event('input'));`);
  let main = await page('index.html'); await sleep(1500);

  // A real MediaRecorder recording (a tone), handed to the main process as the app does.
  const when = new Date(Date.now() - 3600e3);
  const saved = await main.js(`new Promise(async (done) => {
    const c = new AudioContext(); const o = c.createOscillator(); const d = c.createMediaStreamDestination(); o.connect(d); o.start();
    await c.resume(); while (c.currentTime < 0.3) await new Promise((r) => setTimeout(r, 50));
    const r = new MediaRecorder(d.stream); const parts = []; r.ondataavailable = (e) => parts.push(e.data);
    r.onstop = async () => { const blob = new Blob(parts, { type: 'audio/webm' });
      const a = await window.api.saveRecording(blob, '${when.toISOString()}');
      const b = await window.api.saveRecording(blob, '${when.toISOString()}');
      done({ a, b, size: blob.size }); };
    r.start(); setTimeout(() => r.stop(), 2000);
  })`);
  const s = stamp(when);
  check('a recording lands in the folder as audio_HHMMSS_DDMMYY.webm', saved.a.file === path.join(folder, `audio_${s}.webm`) && fs.existsSync(saved.a.file), JSON.stringify(saved.a));
  check('the same time again: _2, nothing overwritten', saved.b.file === path.join(folder, `audio_${s}_2.webm`) && fs.existsSync(saved.b.file));
  const bytes = fs.readFileSync(saved.a.file);
  const again = makeSeekable(bytes);
  check('the file is the seekable one (length and index written; a rewrite changes nothing)',
    bytes.length > saved.size && !!again && again.equals(bytes) && bytes.includes(Buffer.from([0x44, 0x89, 0x01, 0, 0, 0, 0, 0, 0, 0x08])) /* Duration, 8-byte float */, `${saved.size} -> ${bytes.length} bytes`);

  // Taking back: only a file this run wrote.
  const other = path.join(folder, 'my notes.webm'); fs.writeFileSync(other, 'mine');
  const back = await main.js(`Promise.all([window.api.discardRecording(${JSON.stringify(saved.b.file)}), window.api.discardRecording(${JSON.stringify(other)})])`);
  check('"no speech": the file just written is taken back', back[0] === true && !fs.existsSync(saved.b.file));
  check('any other file cannot be taken back through the page', back[1] === false && fs.existsSync(other));

  // Texts: a file each, named after the recording; UTF-8.
  const when2 = new Date(when.getTime() + 61000);
  const texts = await main.js(`window.api.saveTexts([
    { text: 'Оригинал: первая — с файлом записи\\n', when: '${when.toISOString()}', audio: ${JSON.stringify(saved.a.file)} },
    { text: '原文：第二条', when: '${when2.toISOString()}', audio: null }])`);
  const t1 = path.join(folder, `transcribe_${s}.txt`), t2 = path.join(folder, `transcribe_${stamp(when2)}.txt`);
  check('texts: one file each, named after the recording (or the time)', JSON.stringify(texts.files) === JSON.stringify([t1, t2]) && texts.folder === folder, JSON.stringify(texts));
  check('their contents, in UTF-8', fs.readFileSync(t1, 'utf8') === 'Оригинал: первая — с файлом записи\n' && fs.readFileSync(t2, 'utf8') === '原文：第二条');

  // ▶: missing -> said so; never anything but a recording, a text or a folder.
  const bat = path.join(folder, 'run.bat'); fs.writeFileSync(bat, '@echo off\r\necho should never run > "' + path.join(tmp, 'ran.txt') + '"\r\n');
  const opened = await main.js(`Promise.all([window.api.openFile(${JSON.stringify(path.join(folder, 'gone.webm'))}), window.api.openFile(${JSON.stringify(bat)})])`);
  await sleep(1000);
  check('▶ on a moved or deleted file: { missing }', opened[0] && opened[0].missing === true, JSON.stringify(opened[0]));
  check('▶ never opens a program', opened[1] && opened[1].error && !fs.existsSync(path.join(tmp, 'ran.txt')), JSON.stringify(opened[1]));

  // The path is kept with the history: ▶ after a restart.
  await main.js(`(() => { const p = addPendingEntry(new Date('${when.toISOString()}')); const o = p.originalTextField; o.classList.remove('pending');
    o.textContent = 'с файлом'; const e = o.closest('.history-entry'); e._saved = Promise.resolve({ file: ${JSON.stringify(saved.a.file)} }); showPlay(e); })()`);
  await sleep(800);
  await quit(main);
  await launch();
  main = await page('index.html'); await sleep(2000);
  const back2 = await main.js(`(() => { const e = document.querySelector('.history-entry'); return e ? { text: e.querySelector('.original-text').textContent,
    play: !e.querySelector('.entry-play').hidden, audio: e.dataset.audio } : null; })()`);
  check('after a restart: the entry with ▶ and its file', back2 && back2.text === 'с файлом' && back2.play && back2.audio === saved.a.file, JSON.stringify(back2));

  // Signing out: the history in the window goes, the files stay.
  await main.js(`window.api.getAccount()`);
  const settings = await (async () => { await main.js(`window.api.openSettings()`); return page('settings.html'); })();
  await sleep(800);
  check('Settings show the folder in use', (await settings.js(`document.getElementById('folder-path').title`)) === folder);
  await settings.js(`window.settingsApi.signOut()`);
  await sleep(1500);
  const left = fs.readdirSync(folder).sort();
  check('signed out: every file is still there', JSON.stringify(left) === JSON.stringify([`audio_${s}.webm`, 'my notes.webm', 'run.bat', path.basename(t1), path.basename(t2)].sort()), left.join(', '));
  console.log('folder: ' + folder);
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  done(failed ? 1 : 0);
})().catch((e) => { console.error(e); done(1); });
