// Stand: a fresh installation, in the real app (an empty data folder): what it
// starts with (user's list of defaults, 2026-10-06). The theme follows Windows
// (here: dark apps), the language is the first of the user's Windows languages
// the app has (here Windows shows English but lists Russian first: Russian),
// the font size 14, the microphone, the recognition quality Стандарт.
//   node tests\e2e\defaults-e2e.js        (Node 22+; needs app-launcher.js beside it)
const { spawn, execSync, execFileSync } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os');
const ROOT = 'C:/Test01/tray-translator';
const DBG = 9347;
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-fresh-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let appProc, failed = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const done = (c) => { try { execSync(`taskkill /PID ${appProc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) {} process.exit(c); };
setTimeout(() => { console.log('timeout'); done(2); }, 90000);

async function targets() { try { return await (await fetch(`http://127.0.0.1:${DBG}/json`)).json(); } catch (e) { return []; } }
async function page(file) {
  for (let i = 0; i < 120; i++) {
    const t = (await targets()).find((x) => x.type === 'page' && x.url.split('?')[0].endsWith('/' + file));
    if (t) {
      const ws = new WebSocket(t.webSocketDebuggerUrl); let id = 0; const wait = new Map();
      ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
      await new Promise((r) => ws.onopen = r);
      return { js: (e) => new Promise((r) => { const i = ++id; wait.set(i, (d) => r(d.result.result.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: e, awaitPromise: true, returnByValue: true } })); }) };
    }
    await sleep(250);
  }
  throw new Error('no ' + file);
}
// What Windows says about itself, to know what to expect.
const windowsDark = (() => { try { return /0x0/.test(execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme'], { encoding: 'utf8' })); } catch (e) { return true; } })();

(async () => {
  appProc = spawn(path.join(ROOT, 'node_modules/electron/dist/electron.exe'), [`--remote-debugging-port=${DBG}`, path.join(__dirname, 'app-launcher.js')],
    { cwd: ROOT, env: { ...process.env, AUD_TEST_USERDATA: ud, AUDIATOR_ACCOUNTS_URL: 'http://127.0.0.1:1' } });
  const main = await page('index.html'); await sleep(2000);
  const st = await main.js('window.api.getSettings()');
  check('theme: as in Windows, chosen by default', st.themeChoice === 'system', JSON.stringify({ choice: st.themeChoice, theme: st.theme }));
  check(`...and it is Windows' (${windowsDark ? 'dark' : 'light'} apps)`, st.theme === (windowsDark ? 'dark' : 'light') &&
    (await main.js(`document.body.classList.contains('light-theme')`)) === !windowsDark);
  check('font size 14', st.fontSize === 14 && (await main.js(`getComputedStyle(document.documentElement).getPropertyValue('--main-font-size').trim()`)) === '14px');
  check('the microphone, quality Стандарт', st.recordSource === 'mic' && st.whisperModel === 'small', JSON.stringify({ src: st.recordSource, model: st.whisperModel }));
  const lang = await main.js('window.api.getI18n().then((i) => i.lang)');
  const prefers = execFileSync('powershell', ['-NoProfile', '-Command', '(Get-WinUserLanguageList)[0].LanguageTag'], { encoding: 'utf8' }).trim().toLowerCase();
  const expect = prefers.startsWith('ru') ? 'ru' : prefers.startsWith('zh') ? 'zh' : 'en';
  check(`language: the user's first Windows language the app has (${prefers} -> ${expect})`, lang === expect, lang);
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  done(failed ? 1 : 0);
})().catch((e) => { console.error(e); done(1); });
