// Stand: Settings after the owner's look of 2026-10-09. The real settings.html
// with a stand-in settingsApi (calls recorded):
//  - Account (AUD-47, owner's mock-ups): on the right three buttons of one
//    width — Pay, Contact us, Sign out (no Pay on admin / unlimited); a paid
//    plan shows "Paid until …" without the plan's name; the time left on the
//    free plan in two lines, "renews in …" never broken;
//  - Recognition quality a drop-down (AUD-48): each model with its size and a
//    tick once installed, the line under it follows the choice, "Delete from
//    this computer" for a downloaded model not in use;
//  - the sliders in the window's colours (AUD-49);
//  - the window's height as index.js opens it: everything fits, no gap below;
//  - snapshots: three languages, two themes, free and paid.
//   node_modules\.bin\electron tests\e2e\settings-ui.js
const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs'), http = require('http');
const ROOT = path.resolve('C:/Test01/tray-translator/src');
const OUT = __dirname;
const i18n = require(path.join(ROOT, 'i18n.js'));
setTimeout(() => { console.error('timeout'); app.exit(2); }, 180000);
// The window's height, as index.js opens it.
const SETTINGS_H = Number(/const SETTINGS_H = (\d+)/.exec(fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8'))[1]);

const RESETS_IN = (15 * 60 + 1) * 60e3 - 20e3; // "renews in 15 h 1 min" (rounded up to the minute)
const ACCOUNTS = {
  free: () => ({ signedIn: true, email: 'k311335@gmail.com', plan: 'free', limited: true, remaining: 6360,
    resetsAt: Date.now() + RESETS_IN, limit: 7200, paidUntil: null, balance: 0 }),
  paid: () => ({ signedIn: true, email: 'k311335@gmail.com', plan: 'commercial', limited: false,
    paidUntil: '2026-11-08T12:00:00.000Z', balance: 0 }),
  paidBalance: () => ({ signedIn: true, email: 'k311335@gmail.com', plan: 'commercial', limited: false,
    paidUntil: '2026-11-08T12:00:00.000Z', balance: 0.5 }),
  admin: () => ({ signedIn: true, email: 'owner@example.com', plan: 'admin', limited: false, balance: 0 }),
  unlimited: () => ({ signedIn: true, email: 'friend@example.com', plan: 'unlimited', limited: false, balance: 0 }),
};
const ENGINE = { model: 'small', state: 'ready', models: { base: { installed: true, size: 147883000 },
  small: { installed: true, size: 486212000 }, 'large-v3-turbo': { installed: false, size: 1621666000 } } };

function stub(lang, acc) {
  const I18N = JSON.stringify({ lang, languages: i18n.LANGUAGES, strings: i18n.stringsFor(lang) });
  return `<script>
  const noop = () => {}; const RESETS_IN = ${RESETS_IN}; window.__calls = { pay: [], support: 0, signOut: 0, confirm: [], deleted: [] };
  window.__engine = ${JSON.stringify(ENGINE)};
  window.settingsApi = { send: noop, receive: noop, onInitialSettings: (cb) => { window.__init = cb; },
    getAppVersion: () => Promise.resolve('1.0.8'), getI18n: (l) => Promise.resolve(${I18N}),
    getEngineStatus: () => Promise.resolve(window.__engine), onEngineStatus: (cb) => { window.__engineCb = cb; },
    deleteModel: (m) => { window.__calls.deleted.push(m); const e = JSON.parse(JSON.stringify(window.__engine)); e.models[m].installed = false; return Promise.resolve(e); },
    getAccount: () => Promise.resolve((${ACCOUNTS[acc].toString()})()),
    onAccountUpdated: noop, signOut: () => { window.__calls.signOut++; }, openTerms: noop,
    openSupport: () => { window.__calls.support++; }, openPay: (l) => { window.__calls.pay.push(l); },
    confirmBox: (text) => { window.__calls.confirm.push(text); return Promise.resolve(true); },
    getSaveFolder: () => Promise.resolve('C:\\\\Users\\\\someone\\\\Downloads\\\\Audiator'), chooseFolder: noop, openFolder: noop };
  </script>`;
}

let failed = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const name = u.pathname.replace(/^\//, '');
    const lang = u.searchParams.get('lang') || 'ru', theme = u.searchParams.get('theme') || 'dark';
    fs.readFile(path.join(ROOT, name), 'utf8', (e, d) => {
      if (e) { res.writeHead(404); res.end(); return; }
      if (name === 'settings.html') {
        d = d.replace('<head>', '<head>' + stub(lang, u.searchParams.get('acc') || 'free'));
        if (theme === 'light') d = d.replace('<body>', '<body class="light-theme">');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  // Drawn offscreen: snapshots work with the screen off or locked too.
  const win = new BrowserWindow({ width: 450, height: SETTINGS_H, useContentSize: true, show: false, webPreferences: { offscreen: true } });
  const js = (code) => win.webContents.executeJavaScript(code);
  // A page error is a failure, and is shown.
  win.webContents.on('console-message', (e, level, message, line) => {
    if (level >= 3) { console.log(`page error: ${message} (line ${line})`); failed++; }
  });
  const open = async (lang, theme, acc) => {
    await win.loadURL(`${base}settings.html?lang=${lang}&theme=${theme}&acc=${acc}`);
    await js(`window.__init && window.__init({ theme: '${theme}', whisperModel: 'small', fontSize: 14, opacity: 0.8, recordSource: 'mic' })`);
    await sleep(700);
  };
  const lines = () => js(`[...document.querySelectorAll('#account-left > div')].map((d) => d.textContent)`);
  const buttons = () => js(`[...document.querySelectorAll('.account-actions .action-button')].filter((b) => !b.hidden).map((b) => b.textContent)`);
  const R = i18n.stringsFor('ru');

  // --- Account (Russian, dark) ---
  await open('ru', 'dark', 'free');
  check('free: Pay, Contact us, Sign out — a column on the right', JSON.stringify(await buttons()) === JSON.stringify(['Оплатить', 'Написать нам', 'Выйти из аккаунта']), JSON.stringify(await buttons()));
  check('...of one width, one under another', await js(`(() => { const b = [...document.querySelectorAll('.account-actions .action-button')].filter((x) => !x.hidden).map((x) => x.getBoundingClientRect());
    return b.every((r) => Math.abs(r.width - b[0].width) < 0.5 && Math.abs(r.left - b[0].left) < 0.5) && b[1].top > b[0].bottom && b[2].top > b[1].bottom; })()`));
  check('..."Pay" is a button now, not a link', await js(`document.getElementById('pay-btn').tagName === 'BUTTON' && !document.getElementById('pay-link')`));
  check('free: the plan named', (await js(`document.getElementById('account-plan').textContent`)) === 'Бесплатный тариф' && !(await js(`document.getElementById('account-plan').hidden`)));
  check('free: the time left in two lines, "обновление через …" whole on the second', JSON.stringify(await lines()) === JSON.stringify(['Осталось 1\u00A0ч 46\u00A0мин,', 'обновление через 15\u00A0ч 1\u00A0мин']), JSON.stringify(await lines()));
  await js(`document.getElementById('pay-btn').click()`);
  check('"Pay" opens the payment window in Settings\' language', JSON.stringify(await js('window.__calls.pay')) === '["ru"]');
  await js(`document.getElementById('support-btn').click()`);
  check('"Contact us" still opens support', (await js('window.__calls.support')) === 1);

  await open('ru', 'dark', 'paid');
  check('paid: Pay, Contact us, Sign out', JSON.stringify(await buttons()) === JSON.stringify(['Оплатить', 'Написать нам', 'Выйти из аккаунта']), JSON.stringify(await buttons()));
  check('paid: no "Коммерческий тариф" line', await js(`document.getElementById('account-plan').hidden`));
  check('paid: "Оплачено до 08.11.2026"', JSON.stringify(await lines()) === '["Оплачено до 08.11.2026"]', JSON.stringify(await lines()));
  check('paid: no "Продлить" anywhere', !(await js(`document.body.textContent`)).includes('Продлить'));
  await open('ru', 'dark', 'paidBalance');
  check('paid, less than a month on the balance: a line of its own', JSON.stringify(await lines()) === JSON.stringify(['Оплачено до 08.11.2026', 'На балансе 0,5\u00A0USDT']), JSON.stringify(await lines()));
  for (const acc of ['admin', 'unlimited']) {
    await open('ru', 'dark', acc);
    check(`${acc}: no "Pay" — Contact us and Sign out`, JSON.stringify(await buttons()) === JSON.stringify(['Написать нам', 'Выйти из аккаунта']), JSON.stringify(await buttons()));
    check(`${acc}: the plan named, nothing to count`, (await js(`document.getElementById('account-plan').textContent`)) === R[`plan.${acc}`] && (await lines()).length === 0);
  }

  // --- Recognition quality: a drop-down ---
  await open('ru', 'dark', 'free');
  const opts = await js(`[...document.querySelectorAll('#quality-select option')].map((o) => o.value + '=' + o.textContent)`);
  check('quality: a drop-down of three, with sizes and ticks', JSON.stringify(opts) === JSON.stringify([
    'base=Быстро · 148\u00A0МБ  ✓', 'small=Стандарт (по умолчанию) · 486\u00A0МБ  ✓', 'large-v3-turbo=Точно · 1,6\u00A0ГБ']), JSON.stringify(opts));
  check('...a <select>, like the theme and the font', await js(`document.getElementById('quality-select').tagName === 'SELECT' && !document.querySelector('.quality-row')`));
  const hint = () => js(`document.getElementById('quality-hint').textContent`);
  const del = () => js(`document.getElementById('quality-delete').hidden ? null : document.getElementById('quality-delete').textContent`);
  check('Standard chosen: the line under it as before, nothing to delete (in use)', (await hint()) === 'Баланс скорости и точности. Установлено.' && (await del()) === null, await hint());
  await js(`{ const s = document.getElementById('quality-select'); s.value = 'large-v3-turbo'; s.dispatchEvent(new Event('change')); }`);
  check('Accurate chosen: the line follows', (await hint()) === `${R['quality.hintAccurate']} ${R['quality.toDownload']}` && (await del()) === null, await hint());
  await js(`{ const s = document.getElementById('quality-select'); s.value = 'base'; s.dispatchEvent(new Event('change')); }`);
  check('Fast (downloaded, not in use): "Удалить с компьютера" offered', (await del()) === 'Удалить с компьютера');
  await js(`document.getElementById('quality-delete').click()`); await sleep(300);
  check('...asks first, then deletes that model', (await js('window.__calls.confirm[0]')) === 'Удалить модель Быстро (148\u00A0МБ)?' && JSON.stringify(await js('window.__calls.deleted')) === '["base"]');
  check('...and the list says it is no longer here', (await js(`document.querySelector('#quality-select option[value="base"]').textContent`)) === 'Быстро · 148\u00A0МБ' && (await del()) === null);

  // --- Sliders ---
  const sl = await js(`['font-size-slider', 'opacity-slider'].map((id) => { const el = document.getElementById(id);
    return getComputedStyle(el).appearance + '|' + parseFloat(el.style.getPropertyValue('--fill')).toFixed(1); })`);
  check('sliders: drawn by the page (not Chromium\'s violet), filled up to their value', JSON.stringify(sl) === JSON.stringify(['none|28.6', 'none|75.0']), JSON.stringify(sl));
  await js(`{ const f = document.getElementById('font-size-slider'); f.value = 24; f.dispatchEvent(new Event('input')); }`);
  check('...and follow when moved', (await js(`document.getElementById('font-size-slider').style.getPropertyValue('--fill')`)) === '100%');

  // --- Every language and theme: fits the window, no gap; snapshots ---
  for (const lang of ['ru', 'en', 'zh']) {
    for (const theme of ['dark', 'light']) {
      for (const acc of ['free', 'paid']) {
        await open(lang, theme, acc);
        const [need, have] = await js(`[Math.ceil(document.querySelector('.settings-actions').getBoundingClientRect().bottom
          + parseFloat(getComputedStyle(document.body).paddingBottom)), window.innerHeight]`);
        const cut = await js(`[...document.querySelectorAll('#account-left > div, .account-actions .action-button, #account-email')]
          .filter((el) => !el.hidden && el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent)`);
        check(`${lang}/${theme}/${acc}: fits (${need} of ${have}), no gap, nothing cut`, need <= have && have - need <= 16 && !cut.length,
          cut.length ? JSON.stringify(cut) : '');
        if (lang !== 'ru' && acc === 'free') {
          const l = await lines();
          check(`${lang}: the time left in two lines`, l.length === 2, JSON.stringify(l));
        }
        fs.writeFileSync(path.join(OUT, `settings-${lang}-${theme}-${acc}.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  srv.close();
  app.exit(failed ? 1 : 0);
});
