// Stand: the rules (terms.html) after the owner's look of 2026-10-10.
//  - opened with &part=payment (the payment window's link, AUD-54) the window
//    starts at "4. Payment and balance"; without it, at the top;
//  - section 4 is the payment as it is (AUD-52): xRocket in Telegram, 3 / 25
//    USDT, our fee, a payment extends the plan, less than a month waits, no
//    refunds — and nothing of the old ways (BEP-20, Crypto Pay, donations);
//  - "xRocket 🚀" everywhere (AUD-46); the answer times the same in 4 and 6;
//  - snapshots at section 4: three languages, two themes.
//   node_modules\.bin\electron tests\e2e\terms-ui.js
const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs');
const FILE = 'C:/Test01/tray-translator/src/terms.html';
const i18n = require('C:/Test01/tray-translator/src/i18n.js');
setTimeout(() => { console.error('timeout'); app.exit(2); }, 90000);

let failed = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What section 4 must say, per language.
const MUST = {
  ru: ['xRocket 🚀 в Telegram', '3 USDT', '25 USDT', 'Комиссию xRocket 🚀 платим мы', 'продлевает его', 'Остаток меньше цены месяца', 'Возвратов нет', '48 часов'],
  en: ['xRocket 🚀 in Telegram', '3 USDT', '25 USDT', 'We pay the fee of xRocket 🚀', 'extends it', 'less than the price of a month', 'no refunds', '48 hours'],
  zh: ['Telegram 中的 xRocket 🚀', '3 USDT', '25 USDT', '手续费由我们承担', '延长有效期', '不足一个月价格的余款', '均不退款', '48 小时'],
};
// Section 6's "other questions" line, to be said the same way in section 4.
const OTHER = { ru: 'в течение 5 дней', en: 'within 5 days', zh: '5 天内' };

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  // As index.js opens it (560 x 640, frame included); offscreen: works with the screen off.
  const w = new BrowserWindow({ width: 560, height: 640, show: false, webPreferences: { offscreen: true } });
  const js = (c) => w.webContents.executeJavaScript(c);
  for (const lang of ['ru', 'en', 'zh']) {
    await w.loadFile(FILE, { query: { lang, theme: 'dark' } });
    await sleep(300);
    check(`${lang}: opened plainly — at the top`, (await js('window.scrollY')) === 0);
    const all = await js(`document.querySelector('section.shown').innerText`);
    check(`${lang}: nothing of the old ways (BEP-20, Crypto Pay, an address, donations)`,
      !/BEP-20|BNB|Crypto ?Pay|CryptoBot|донат|Пожертвован|Donation|捐赠|личный адрес|personal address|专属地址/i.test(all));
    check(`${lang}: xRocket never without its rocket`, /xRocket 🚀/.test(all) && !/xRocket(?!\u00A0🚀)/.test(all));
    for (const theme of ['dark', 'light']) {
      await w.loadFile(FILE, { query: { lang, theme, part: 'payment' } });
      await sleep(300);
      const [top, title] = await js(`(() => { const h = document.querySelector('section.shown h2[data-part="payment"]');
        return [Math.round(h.getBoundingClientRect().top), h.textContent]; })()`);
      if (theme === 'dark') {
        check(`${lang}: the payment window's link opens it at "${title}"`, top >= 0 && top <= 24 && (await js('window.scrollY')) > 0, `top ${top}`);
        const s4 = await js(`(() => { const h = document.querySelector('section.shown h2[data-part="payment"]'); return h.nextElementSibling.innerText; })()`);
        const missing = MUST[lang].filter((m) => !s4.includes(m));
        check(`${lang}: section 4 says how payment is now`, !missing.length, missing.length ? 'missing: ' + JSON.stringify(missing) : '');
        check(`${lang}: answer times the same as in section 6`, s4.includes(OTHER[lang]) && all.split(s4)[1].includes(OTHER[lang]));
        const link = i18n.stringsFor(lang)['pay.terms'];
        check(`${lang}: the link's name matches the section ("${link}")`,
          { ru: /оплаты и баланса/, en: /Payment and balance/, zh: /付款与余额/ }[lang].test(link) && title.includes({ ru: 'Оплата и баланс', en: 'Payment and balance', zh: '付款与余额' }[lang]));
      }
      fs.writeFileSync(path.join(__dirname, `terms-payment-${lang}-${theme}.png`), (await w.webContents.capturePage()).toPNG());
    }
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  app.exit(failed ? 1 : 0);
});
