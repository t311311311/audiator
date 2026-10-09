// Stand: paying for the plan (pay.html; owner's decision 2026-10-09 — an
// xRocket invoice in Telegram). The real page with a stand-in payApi (calls are
// recorded, nothing leaves the stand): the form, a month or a year, the
// invoice opened, waiting, paid, expired, errors, closing on sign-out; no
// lines about the plan above the prices (AUD-45), "xRocket 🚀" (AUD-46); the
// window's height as index.js opens it; snapshots in three languages, two
// themes. The "Pay" button in Settings: tests/e2e/settings-ui.js.
//   node_modules\.bin\electron tests\e2e\pay-ui.js
const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs'), http = require('http');
const ROOT = path.resolve('C:/Test01/tray-translator/src');
const OUT = __dirname;
const i18n = require(path.join(ROOT, 'i18n.js'));
// The window's height, as index.js opens it.
const PAY_H = Number(/const PAY_H = (\d+)/.exec(fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8'))[1]);
setTimeout(() => { console.error('timeout'); app.exit(2); }, 180000);

const PAID_UNTIL = '2026-11-09T12:00:00.000Z';
function payStub(lang, theme, accountJson) {
  const I18N = JSON.stringify({ lang, languages: i18n.LANGUAGES, strings: i18n.stringsFor(lang) });
  return `<script>
  const noop = () => {};
  window.__calls = { invoice: [], status: [], open: [], close: 0, terms: 0, topup: 0 };
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
    topUp: () => { window.__calls.topup++; },
    openTerms: () => { window.__calls.terms++; }, close: () => { window.__calls.close++; } };
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  // Drawn offscreen: snapshots work with the screen off or locked too.
  const win = new BrowserWindow({ width: 440, height: PAY_H, useContentSize: true, show: false, webPreferences: { offscreen: true } }); // as index.js opens it
  const js = (code) => win.webContents.executeJavaScript(code);
  const open = async (q) => { await win.loadURL(`${base}pay.html?${q}`); await sleep(500); };
  const visible = (id) => js(`!document.getElementById('${id}').classList.contains('hidden')`);
  const text = (id) => js(`document.getElementById('${id}').textContent`);

  // --- Behaviour (Russian, dark) ---
  await open('lang=ru&theme=dark&acc=free');
  check('no lines about the plan now or how it is paid (AUD-45)', !(await js(`!!document.getElementById('now')`))
    && !/Сейчас:|Оплата в Telegram с кошелька/.test(await text('form')));
  check('the title, then the prices', await js(`document.querySelector('#form h1').nextElementSibling.id === 'periods'`));
  check('a month and a year, the month chosen', (await js(`[...document.querySelectorAll('.period')].map((c) => c.classList.contains('chosen') + ':' + c.textContent).join('|')`))
    === 'true:Месяц3\u00A0USDT|false:Год25\u00A0USDT', 'no "≈ … a month" under the year (AUD-42)');
  check('the prices in the middle of their cards', await js(`[...document.querySelectorAll('.period .price')].every((el) => {
    const c = el.parentElement.getBoundingClientRect(), r = el.getBoundingClientRect();
    return Math.abs((r.left + r.right) / 2 - (c.left + c.right) / 2) < 3; })`));
  check('no fee on top for the buyer: none mentioned (owner\'s decision 2026-10-09)', !/комисси/i.test(await text('form')));
  check('"xRocket 🚀": the steps\' title and the top-up button (AUD-46)',
    (await js(`document.querySelector('.steps h2').textContent`)) === 'Нет USDT в xRocket 🚀? Три шага:'
    && (await text('topup')) === 'Пополнить кошелёк xRocket 🚀');
  check('xRocket never without its rocket in the window, any language', ['ru', 'en', 'zh'].every((l) =>
    Object.entries(i18n.stringsFor(l)).filter(([k]) => k.startsWith('pay.')).every(([, v]) => !/xRocket(?! 🚀)/.test(v))));
  check('three steps to top up, without P2P', (await js(`[...document.querySelectorAll('.steps li')].map((l) => l.textContent).join('|')`))
    === 'Пройдите проверку личности в xRocket 🚀 — один раз.|Пополните кошелёк по СБП на сумму тарифа по текущему курсу (цены указаны в USDT: 1 USDT ≈ 1 $).|Вернитесь сюда и нажмите «Оплатить в Telegram».'
    && !/P2P/.test(await text('form')));
  await js(`document.querySelector('#step1 a').click()`);
  check('"xRocket" in step 1 is the referral link', (await js('window.__calls.topup')) === 1);
  await js(`document.getElementById('topup').click()`);
  check('"Top up" opens the xRocket top-up too (the link lives in the main process)', (await js('window.__calls.topup')) === 2);
  await js(`document.querySelectorAll('.period input')[1].click()`);
  check('the year chosen', await js(`document.querySelectorAll('.period')[1].classList.contains('chosen')`));
  await js(`document.getElementById('pay').click()`);
  await sleep(300);
  check('the invoice asked for a year in the window\'s language', JSON.stringify(await js('window.__calls.invoice')) === '[{"period":"year","lang":"ru"}]');
  check('waiting: the invoice is open in Telegram', await visible('waiting') && !(await visible('form')));
  check('waiting: the invoice in "@xRocket 🚀"', (await js(`document.querySelector('#waiting [data-i18n="pay.waiting"]').textContent`)).includes('в боте @xRocket 🚀.'));
  check('waiting: until when the invoice is valid', /^Счёт действует до \d\d:\d\d\.$/.test(await text('valid')), await text('valid'));
  await js(`document.getElementById('again').click()`);
  check('"open the invoice again" opens the same invoice', JSON.stringify(await js('window.__calls.open')) === '["https://t.me/xrocket?start=inv_test7"]');
  check('waiting: in the middle of the window', await js(`(() => { const r = document.querySelector('#waiting .spinner').getBoundingClientRect();
    const b = document.getElementById('back').getBoundingClientRect(); return Math.abs((r.top + b.bottom) / 2 - window.innerHeight / 2) < 40; })()`));
  await js(`window.__statuses = ['pending', 'offline', 'paid'];
            window.__account = ${PAID.replace('"balance":2', '"balance":0')};`);
  await sleep(13000);
  check('asked the server until paid (offline once, still waiting)', (await js('window.__calls.status.length')) >= 3);
  check('paid: the plan and until when', (await text('result-title')) === 'Оплачено!' && (await text('result-text')) === 'Тариф действует до 09.11.2026.', await text('result-text'));
  check('paid: in the middle of the window', await js(`(() => { const r = document.getElementById('icon').getBoundingClientRect(); const b = document.getElementById('result-btn').getBoundingClientRect();
    const mid = (r.top + b.bottom) / 2; return Math.abs(mid - window.innerHeight / 2) < 40; })()`));
  const polls = await js('window.__calls.status.length');
  await sleep(5000);
  check('no more asking once paid', (await js('window.__calls.status.length')) === polls);
  await js(`document.getElementById('result-btn').click()`);
  check('"Close" closes the window', (await js('window.__calls.close')) === 1);

  await open('lang=ru&theme=dark&acc=free');
  await js(`window.__statuses = ['pending']; document.getElementById('pay').click()`);
  await sleep(300);
  await js(`document.getElementById('back').click()`);
  check('"Back" from waiting returns to the form', await visible('form'));
  await js(`window.__statuses = ['expired']; document.getElementById('pay').click()`);
  await sleep(5000);
  check('expired: said so, a new invoice offered', (await text('result-title')) === 'Счёт истёк'
    && (await text('result-text')) === 'Оплата не поступила — создайте новый счёт.' && (await text('result-btn')) === 'Новый счёт');
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

  // Paid while less than a month stays on the balance: said so (AUD-43).
  await open('lang=ru&theme=dark&acc=free');
  await js(`window.__statuses = ['paid']; window.__account = ${PAID.replace('"balance":2', '"balance":3')};
            document.getElementById('pay').click()`);
  await sleep(4800);
  check('paid but only onto the balance: told it goes into the next payment', (await text('result-text'))
    === 'На балансе 3\u00A0USDT — меньше цены месяца. Они пойдут в следующую оплату.', await text('result-text'));

  // --- Snapshots: the form and paid, three languages, two themes; waiting once ---
  for (const lang of ['ru', 'en', 'zh']) {
    for (const theme of ['dark', 'light']) {
      await open(`lang=${lang}&theme=${theme}&acc=free`);
      fs.writeFileSync(path.join(OUT, `pay-form-${lang}-${theme}.png`), (await win.webContents.capturePage()).toPNG());
      // The form fits, and the window is not much taller than it needs
      // (the link at the foot sits at the bottom: measured without it pushed down).
      const [need, have] = await js(`(() => { const f = document.querySelector('.foot'); f.style.marginTop = '0';
        const n = Math.ceil(f.getBoundingClientRect().bottom + parseFloat(getComputedStyle(document.body).paddingBottom));
        f.style.marginTop = ''; return [n, window.innerHeight]; })()`);
      check(`${lang}/${theme}: the form fits the window, without a gap below (${need} of ${have})`,
        need <= have && have - need <= 24 && (await js(`document.documentElement.scrollHeight <= window.innerHeight`)));
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
