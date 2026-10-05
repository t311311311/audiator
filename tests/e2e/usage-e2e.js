// Stand: the free plan's count and its renewal, src/account.js against the
// real accounts server (a spare port, a temporary database, codes printed).
// Checks (2026-10-06, user: "something seemed off with the limit"):
//   - a recording longer than an hour is counted whole (the server takes at
//     most an hour per report: it went in one report and the rest was lost);
//   - minutes counted offline go out once the server is back, in full;
//   - when the account's 24 hours are over, all 2 hours are back at once
//     (no renewal time shown), and the next use starts new 24 hours.
//   node_modules\.bin\electron tests\e2e\usage-e2e.js
const { app } = require('electron');
const { spawn, execFileSync } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os');
const ROOT = 'C:/Test01/tray-translator';
const PORT = 3121;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-usage-'));
const DB = path.join(tmp, 'accounts.db');
app.setPath('userData', path.join(tmp, 'userData'));
process.env.AUDIATOR_ACCOUNTS_URL = `http://127.0.0.1:${PORT}`;
setTimeout(() => { console.error('timeout'); finish(2); }, 90000);

let server = null, log = '';
function finish(code) { try { server && server.kill(); } catch (e) {} app.exit(code); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
async function startServer() {
  log = '';
  server = spawn(path.join(ROOT, '.venv/Scripts/python.exe'), ['-m', 'uvicorn', 'main:app', '--port', String(PORT)], {
    cwd: path.join(ROOT, 'auth-server'), windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', SMTP_HOST: '', MAIL_DEV_PRINT: '1',
           ACCOUNTS_DATABASE_URL: 'sqlite:///' + DB.replace(/\\/g, '/') } });
  server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100 && !/Uvicorn running/.test(log); i++) await sleep(200);
}
async function stopServer() { const p = new Promise((r) => server.on('exit', r)); server.kill(); await p; await sleep(300); }
// The account's row in the server's database, read (or moved) directly.
const sql = (q) => execFileSync(path.join(ROOT, '.venv/Scripts/python.exe'), ['-c',
  `import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); r=c.execute(sys.argv[2]).fetchall(); c.commit(); print(r)`, DB, q], { encoding: 'utf8' }).trim();

app.whenReady().then(async () => {
  await startServer();
  const account = require(path.join(ROOT, 'src/account.js'));
  await account.requestCode('limit@example.com', 'ru');
  let code; for (let i = 0; i < 50 && !(code = (log.match(/sign-in code for limit@example\.com: (\d{6})/) || [])[1]); i++) await sleep(100);
  check('signed in, free plan, 2 hours', (await account.verify('limit@example.com', code)).ok && account.view().remaining === 7200);

  // A recording of 1 h 23 min 20 s, counted when its text came.
  await account.addUsage(5000);
  let v = account.view();
  check('a recording over an hour is counted whole (on the server too)',
    v.remaining === 2200 && sql("select window_used from users where email='limit@example.com'") === '[(5000,)]',
    `left ${v.remaining} s; server: ${sql("select window_used from users where email='limit@example.com'")}`);
  // Sent in pieces of at most an hour: the 24 hours start an hour before the first piece.
  check('the renewal time is 24 hours on (from an hour before the first report)', Math.abs(v.resetsAt - (Date.now() + 24 * 3600e3 - 3600e3)) < 120e3,
    new Date(v.resetsAt).toISOString());

  // Offline: two recordings counted here, sent when the server is back.
  await stopServer();
  await account.addUsage(700); await account.addUsage(500);
  v = account.view();
  check('offline: counted here at once', v.remaining === 1000, `left ${v.remaining} s`);
  await startServer();
  v = await account.refresh();
  check('back online: sent in full, once', v.remaining === 1000 && sql("select window_used from users where email='limit@example.com'") === '[(6200,)]',
    sql("select window_used from users where email='limit@example.com'"));

  // The 24 hours end (moved back on the server): all 2 hours back at once.
  sql("update users set window_start = datetime(window_start, '-24 hours') where email='limit@example.com'");
  v = await account.refresh();
  check('24 hours over: all 2 hours back, no renewal time until the next use', v.remaining === 7200 && v.resetsAt === null, JSON.stringify({ left: v.remaining, resetsAt: v.resetsAt }));
  await account.addUsage(30);
  v = account.view();
  check('the next use starts new 24 hours from it', v.remaining === 7170 && Math.abs(v.resetsAt - (Date.now() + 24 * 3600e3 - 30e3)) < 120e3,
    JSON.stringify({ left: v.remaining, resetsAt: new Date(v.resetsAt).toISOString() }));
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  finish(failed ? 1 : 0);
}).catch((e) => { console.error(e); finish(1); });
