// Audiator for a payment test with cheap prices (owner 2026-10-10): the same as
// `npm start`, but the local accounts server asks 0.10 USDT for a month and
// 1.20 for a year — real money through the real xRocket, just little of it.
//   npm run start:test
// Other prices: set PRICE_MONTH / PRICE_YEAR before it (PowerShell:
// $env:PRICE_MONTH = '0.01'; npm run start:test).
//
// It refuses to start while a server is already listening on 3000: that
// server keeps the prices it was started with — a test once ran at the real
// 3 USDT that way, unnoticed. The payment window shows the prices the server
// asks, so a look at it tells which ones are in force.
//
// (A year is not 0.12 here: with a month at 0.10, 0.02 left on the balance
// plus a month's payment would buy a year.)
const { spawn } = require('child_process');
const path = require('path');
const { portOpen } = require('../src/local-backend');

const ROOT = path.join(__dirname, '..');
const month = process.env.PRICE_MONTH || '0.10';
const year = process.env.PRICE_YEAR || '1.20';

(async () => {
  if (await portOpen(3000)) {
    console.error('\n[тест оплаты] На порту 3000 уже работает сервер — он останется со своими ценами.');
    console.error('[тест оплаты] Закройте Audiator полностью (меню ☰ → Выход) и запустите команду снова.\n');
    process.exit(1);
  }
  console.log(`\n[тест оплаты] Тестовые цены: месяц ${month} USDT, год ${year} USDT (настоящие деньги через xRocket).`);
  console.log('[тест оплаты] В окне оплаты должны стоять эти же цены. Обычные цены — обычный npm start.\n');
  const child = spawn(require('electron'), ['.'], {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, PRICE_MONTH: month, PRICE_YEAR: year },
  });
  child.on('exit', (code) => process.exit(code == null ? 1 : code));
})();
