// Stand: paying for the plan (pay.html; owner's decision 2026-10-09 — an
// xRocket invoice in Telegram). The real page with a stand-in payApi (calls are
// recorded, nothing leaves the stand): the form, a month or a year, the
// invoice opened, waiting, paid, expired, errors, closing on sign-out; the
// "Pay" / "Renew" link in Settings; snapshots in three languages, two themes.
//   node_modules\.bin\electron tests\e2e\pay-ui.js
const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs'), http = require('http');
const ROOT = path.resolve('C:/Test01/tray-translator/src');
const OUT = __dirname;
const i18n = require(path.join(ROOT, 'i18n.js'));
setTimeout(() => { console.error('timeout'); app.exit(2); }, 180000);

const PAID_UNTIL = '2026-11-09T12:00:00.000Z';
function payStub(lang, theme, accountJson) {
  const I18N = JSON.stringify({ lang, languages: i18n.LANGUAGES, strings: i18n.stringsFor(lang) });
  return `<script>
  const noop = () => {};
  window.__calls = { invoice: [], status: [], open: [], close: 0, terms: 0 };
  window.__account = ${accountJson};
  window.__invoice = { ok: true, id: 7, url: 'https://t.me/xrocket?start=inv_test7', price: 3, expiresAt: Date.now() + 30 * 60e3 };
  window.__statuses = ['pending'];
  window.payApi = { getI18n: () => Promise.resolve(${I18N}),
    getSettings: () => Promise.resolve({ theme: '${theme}' }), onSettingsUpdated: noop,
    getAccount: () => Promise.resolve(window.__account), onAccountUpdated: (cb) => { window.__accountCb = cb; },
    invoice: (period, lang) => { window.__calls.invoice.push({ period, lang }); return Promise.resolve(window.__invoice); },
    openInvoice: (url) => { window.__calls.open.push(url); },
    status: (id) => { window.__calls.status.push(id); const s = window.__statuses.length > 1 ? window.__statuses.shift() : window.__statuses[0];
      return Promise.resolve(s === 'offline' ? { ok: false, error: 'network' } : { ok: true, status: s, credited: s === 'paid' ? 3 : null }); },
    openTerms: () => { window.__calls.terms++; }, close: () => { window.__calls.close++; } };
  </script>`;
}
function settingsStub(lang, accountJson) {
  const I18N = JSON.stringify({ lang, languages: i18n.LANGUAGES, strings: i18n.stringsFor(lang) });
  return `<script>
  const noop = () => {}; window.__calls = { pay: [] };
  window.settingsApi = { send: noop, receive: noop, onInitialSettings: noop,
    getAppVersion: () => Promise.resolve('1.0.8'), getI18n: () => Promise.resolve(${I18N}),
    getEngineStatus: () => Promise.resolve({ model: 'small', state: 'ready', models: { small: { installed: true, size: 486212000 } } }),
    onEngineStatus: noop, deleteModel: noop,
    getAccount: () => Promise.resolve(${accountJson}),
    onAccountUpdated: noop, signOut: noop, openTerms: noop, openSupport: noop, openPay: (l) => { window.__calls.pay.push(l); },
    confirmBox: () => Promise.resolve(true), getSaveFolder: () => Promise.resolve('C:\\\\Users\\\\someone\\\\Downloads\\\\Audiator'),
    chooseFolder: noop, openFolder: noop };
  </script>`;
}

const FREE = JSON.stringify({ signedIn: true, email: 'someone@example.com', plan: 'free', limited: true, remaining: 2600,
  resetsAt: null, limit: 7200, paidUntil: null, balance: 0 });
const PAID = JSON.stringify({ signedIn: true, email: 'someone@example.com', plan: 'commercial', limited: false,
  paidUntil: PAID_UNTIL, balance: 2 });
const ADMIN = JSON.stringify({ signedIn: true, email: 'owner@example.com', plan: 'admin', limited: false, balance: 0 });

let failed = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const name = u.pathname.replace(/^\//, '');
    const lang = u.searchParams.get('lang') || 'ru', theme = u.searchParams.get('theme') || 'dark';
    const acc = { free: FREE, paid: PAID, admin: ADMIN }[u.searchParams.get('acc') || 'free'];
    fs.readFile(path.join(ROOT, name), 'utf8', (e, d) => {
      if (e) { res.writeHead(404); res.end(); return; }
      if (name === 'pay.html') d = d.replace('<head>', '<head>' + payStub(lang, theme, acc));
      if (name === 'settings.html') {
        d = d.replace('<head>', '<head>' + settingsStub(lang, acc));
        if (theme === 'light') d = d.replace('<body>', '<body class="light-theme">');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  // Drawn offscreen: snapshots work with the screen off or locked too.
  const win = new BrowserWindow({ width: 440, height: 480, useContentSize: true, show: false, webPreferences: { offscreen: true } });
  const js = (code) => win.webContents.executeJavaScript(code);
  const open = async (q) => { await win.loadURL(`${base}pay.html?${q}`); await sleep(500); };
  const visible = (id) => js(`!document.getElementById('${id}').classList.contains('hidden')`);
  const text = (id) => js(`document.getElementById('${id}').textContent`);

  // --- Behaviour (Russian, dark) ---
  await open('lang=ru&theme=dark&acc=free');
  check('free plan: what it is now', (await text('now')) === 'Сейчас: бесплатный тариф, 2 часа в сутки.', await text('now'));
  check('a month and a year, the month chosen', (await js(`[...document.querySelectorAll('.period')].map((c) => c.classList.contains('chosen') + ':' + c.textContent).join('|')`))
    === 'true:Месяц3 USDT|false:Год25 USDT≈ 2,08 USDT в месяц');
  check('the fee is said before paying', /комиссия xRocket 1,5 %/.test(await text('form')));
  check('how to top up, without P2P', /Кошелёк → Пополнить/.test(await text('topup')) && !/P2P/.test(await text('topup')));
  await js(`document.querySelectorAll('.period input')[1].click()`);
  check('the year chosen', await js(`document.querySelectorAll('.period')[1].classList.contains('chosen')`));
  await js(`document.getElementById('pay').click()`);
  await sleep(300);
  check('the invoice asked for a year in the window\'s language', JSON.stringify(await js('window.__calls.invoice')) === '[{"period":"year","lang":"ru"}]');
  check('waiting: the invoice is open in Telegram', await visible('waiting') && !(await visible('form')));
  check('waiting: until when the invoice is valid', /^Счёт действует до \d\d:\d\d\.$/.test(await text('valid')), await text('valid'));
  await js(`document.getElementById('again').click()`);
  check('"open the invoice again" opens the same invoice', JSON.stringify(await js('window.__calls.open')) === '["https://t.me/xrocket?start=inv_test7"]');
  await js(`window.__statuses = ['pending', 'offline', 'paid'];
            window.__account = ${PAID.replace('"balance":2', '"balance":0')};`);
  await sleep(13000);
  check('asked the server until paid (offline once, still waiting)', (await js('window.__calls.status.length')) >= 3);
  check('paid: the plan and until when', (await text('result-text')) === 'Оплачено! Тариф действует до 09.11.2026.', await text('result-text'));
  const polls = await js('window.__calls.status.length');
  await sleep(5000);
  check('no more asking once paid', (await js('window.__calls.status.length')) === polls);
  await js(`document.getElementById('result-btn').click()`);
  check('"Close" closes the window', (await js('window.__calls.close')) === 1);

  await open('lang=ru&theme=dark&acc=free');
  await js(`window.__statuses = ['expired']; document.getElementById('pay').click()`);
  await sleep(5000);
  check('expired: said so, a new invoice offered', (await text('result-text')) === 'Счёт истёк без оплаты.' && (await text('result-btn')) === 'Новый счёт');
  await js(`document.getElementById('result-btn').click()`);
  check('"New invoice" goes back to the form', await visible('form'));

  await open('lang=ru&theme=dark&acc=free');
  await js(`window.__invoice = { ok: false, error: 'payments_off' }; document.getElementById('pay').click()`);
  await sleep(300);
  check('payments off: told plainly, still on the form', (await text('error')) === 'Оплата пока недоступна. Попробуйте позже.' && await visible('form'));
  await js(`window.__invoice = { ok: false, error: 'network' }; document.getElementById('pay').click()`);
  await sleep(300);
  check('no connection: the sign-in window\'s words', (await text('error')) === i18n.stringsFor('ru')['login.err.network'], await text('error'));
  await js(`document.getElementById('terms').click()`);
  check('the payment rules open', (await js('window.__calls.terms')) === 1);
  await js(`window.__accountCb({ signedIn: false })`);
  check('signed out meanwhile: the window closes', (await js('window.__calls.close')) === 1);

  await open('lang=ru&theme=dark&acc=paid');
  check('paid plan with a balance: until when, and what waits', (await text('now')) === 'Оплачено до 09.11.2026. На балансе: 2 USDT, пойдут на следующий срок.', await text('now'));

  // --- Settings: "Pay" / "Renew" beside the plan ---
  const sw = new BrowserWindow({ width: 450, height: 770, useContentSize: true, show: false }); // as index.js opens Settings
  const sjs = (code) => sw.webContents.executeJavaScript(code);
  for (const [acc, link, left] of [['free', 'Оплатить', null], ['paid', 'Продлить', 'Оплачено до 09.11.2026 · на балансе 2 USDT'], ['admin', null, null]]) {
    await sw.loadURL(`${base}settings.html?lang=ru&theme=dark&acc=${acc}`);
    await sleep(900);
    const shown = await sjs(`(() => { const a = document.getElementById('pay-link'); return a.hidden ? null : a.textContent; })()`);
    check(`settings, ${acc}: the link beside the plan is ${link || 'not there'}`, shown === link, String(shown));
    if (left) check(`settings, ${acc}: paid until and the balance`, (await sjs(`document.getElementById('account-left').textContent`)) === left);
    if (link) {
      await sjs(`document.getElementById('pay-link').click()`);
      check(`settings, ${acc}: the link opens the payment window in Settings' language`, JSON.stringify(await sjs('window.__calls.pay')) === '["ru"]');
    }
    if (acc === 'free') {
      const [withLink, without] = await sjs(`(() => { const h = () => document.documentElement.scrollHeight; const a = h();
        document.getElementById('pay-link').hidden = true; const b = h(); document.getElementById('pay-link').hidden = false; return [a, b]; })()`);
      check('Settings keep their height: the link adds no row', withLink === without, `${withLink} / ${without}`);
    }
  }

  // --- Snapshots: the form and paid, three languages, two themes; waiting once ---
  for (const lang of ['ru', 'en', 'zh']) {
    for (const theme of ['dark', 'light']) {
      await open(`lang=${lang}&theme=${theme}&acc=free`);
      fs.writeFileSync(path.join(OUT, `pay-form-${lang}-${theme}.png`), (await win.webContents.capturePage()).toPNG());
      const fits = await js(`document.documentElement.scrollHeight <= window.innerHeight`);
      check(`${lang}/${theme}: the form fits the window`, fits);
      await js(`window.__statuses = ['paid']; window.__account = ${PAID.replace('"balance":2', '"balance":0')};
                document.getElementById('pay').click()`);
      await sleep(lang === 'ru' && theme === 'dark' ? 600 : 5000);
      if (lang === 'ru' && theme === 'dark') {
        fs.writeFileSync(path.join(OUT, 'pay-waiting-ru-dark.png'), (await win.webContents.capturePage()).toPNG());
        await sleep(4500);
      }
      fs.writeFileSync(path.join(OUT, `pay-paid-${lang}-${theme}.png`), (await win.webContents.capturePage()).toPNG());
      check(`${lang}/${theme}: paid shown`, await visible('result'));
    }
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  srv.close();
  app.exit(failed ? 1 : 0);
});
