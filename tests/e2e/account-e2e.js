// Scratch: src/account.js against the real accounts server (auth-server/main.py
// on a spare port, a temporary database, codes printed instead of mailed).
const { app } = require('electron');
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os');
const ROOT = 'C:/Test01/tray-translator';
const PORT = 3107;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-acct-'));
app.setPath('userData', path.join(tmp, 'userData'));
process.env.AUDIATOR_ACCOUNTS_URL = `http://127.0.0.1:${PORT}`;
setTimeout(() => { console.error('timeout'); finish(2); }, 90000);

let server = null, log = '';
function finish(code) { try { server && server.kill(); } catch (e) {} app.exit(code); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codeFor = async (email) => {
  for (let i = 0; i < 50; i++) {
    const m = [...log.matchAll(new RegExp(`sign-in code for ${email.replace(/[.]/g, '\\.')}: (\\d{6})`, 'g'))].pop();
    if (m) return m[1];
    await sleep(100);
  }
  throw new Error('no code printed for ' + email);
};
let failed = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

app.whenReady().then(async () => {
  server = spawn(path.join(ROOT, '.venv/Scripts/python.exe'), ['-m', 'uvicorn', 'main:app', '--port', String(PORT)], {
    cwd: path.join(ROOT, 'auth-server'), windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', SMTP_HOST: '', MAIL_DEV_PRINT: '1', ADMIN_EMAILS: 'boss@example.com',
           ACCOUNTS_DATABASE_URL: 'sqlite:///' + path.join(tmp, 'accounts.db').replace(/\\/g, '/') },
  });
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100 && !/Uvicorn running/.test(log); i++) await sleep(200);
  if (!/Uvicorn running/.test(log)) { console.error(log); throw new Error('server did not start'); }

  const account = require(path.join(ROOT, 'src/account.js'));
  const changes = [];
  account.onChange((v) => changes.push(v));

  check('starts signed out', !account.signedIn() && account.view().signedIn === false);
  check('device id is a sha256 hex', /^[0-9a-f]{64}$/.test(account.deviceHash()));

  let r = await account.requestCode('Friend@Example.com', 'ru');
  check('code requested (no word on whether the address is new)', r.ok && !('isNew' in r), JSON.stringify(r));
  r = await account.verify('friend@example.com', '000000');
  check('wrong code refused with tries left', !r.ok && r.error === 'wrong_code' && r.attempts_left === 4, JSON.stringify(r));
  r = await account.verify('friend@example.com', await codeFor('friend@example.com'));
  check('signed in with the mailed code', r.ok && account.signedIn(), JSON.stringify(r));
  let v = account.view();
  check('free plan, 2 h left', v.plan === 'free' && v.limited && v.remaining === 7200 && v.resetsAt === null, JSON.stringify(v));
  check('change was announced', changes.some((c) => c.signedIn));

  await account.addUsage(124.3);
  v = account.view();
  check('125 s counted and confirmed by the server', v.remaining === 7200 - 125, JSON.stringify(v));
  const span = v.resetsAt - Date.now();
  check("the account's own 24 hours started with that use", span > 23.9 * 3600e3 && span <= 24 * 3600e3, String(span));
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'userData', 'account.json'), 'utf8'));
  check('nothing left pending', saved.pending.seconds === 0, JSON.stringify(saved.pending));
  check('token on disk only encrypted', !!saved.tokenEnc && !('token' in saved) && !/eyJ/.test(JSON.stringify(saved)));
  v = await account.refresh();
  check('refresh agrees', v.remaining === 7200 - 125, JSON.stringify(v));
  check('can transcribe', account.canTranscribe());
  await Promise.all([account.addUsage(10), account.addUsage(10), account.addUsage(10)]);
  v = await account.refresh();
  check('three at once counted once each', v.remaining === 7200 - 125 - 30, JSON.stringify(v));

  // A second free account on the same computer is refused at sign-in.
  account.signOut('user');
  v = account.view();
  check('signed out, last email offered again', !v.signedIn && v.reason === 'user' && v.lastEmail === 'friend@example.com', JSON.stringify(v));
  r = await account.requestCode('second@example.com', 'en');
  r = await account.verify('second@example.com', await codeFor('second@example.com'));
  check('second free account on this computer refused', !r.ok && r.error === 'device_has_free_account' && /\*/.test(r.other_email || ''), JSON.stringify(r));
  check('still signed out', !account.signedIn());

  // The admin: unlimited, no counter.
  await account.requestCode('boss@example.com', 'en');
  r = await account.verify('boss@example.com', await codeFor('boss@example.com'));
  v = account.view();
  check('admin signs in on the same computer', r.ok && v.plan === 'admin' && !v.limited && v.remaining === null, JSON.stringify(v));
  await account.addUsage(4000);
  check('admin never runs out', account.canTranscribe());

  // Offline: minutes are counted here and go out once the server answers.
  account.signOut('user');
  check('signed out by the user, email offered again', account.view().lastEmail === 'boss@example.com');
  await account.requestCode('friend@example.com', 'en');
  await account.verify('friend@example.com', await codeFor('friend@example.com'));
  server.kill(); server = null;
  await sleep(500);
  await account.addUsage(60);
  v = account.view();
  check('offline: counted locally', v.remaining === 7200 - 155 - 60, JSON.stringify(v));
  v = await account.refresh();
  check('offline: refresh keeps the session', v.signedIn && v.remaining === 7200 - 155 - 60, JSON.stringify(v));

  // The file taken to another computer (or another Windows user): DPAPI cannot
  // open the token there, which just means "sign in again".
  const file = path.join(tmp, 'userData', 'account.json');
  const copy = JSON.parse(fs.readFileSync(file, 'utf8'));
  copy.tokenEnc = Buffer.from('sealed for someone else').toString('base64');
  fs.writeFileSync(file, JSON.stringify(copy));
  delete require.cache[require.resolve(path.join(ROOT, 'src/account.js'))];
  const elsewhere = require(path.join(ROOT, 'src/account.js'));
  check('a session that cannot be opened here means signed out', !elsewhere.signedIn() && !elsewhere.view().signedIn);

  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  finish(failed ? 1 : 0);
}).catch((e) => { console.error('ERROR', e); console.error(log.slice(-2000)); finish(1); });
