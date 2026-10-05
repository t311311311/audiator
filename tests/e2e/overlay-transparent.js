// Scratch check: draw the barrels in the real recorder-overlay.html for a few
// queue states (built with the real RecordQueue) and compare the drawn width
// with the window width index.js computes.
const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs'), http = require('http');
const ROOT = path.resolve('C:/Test01/tray-translator/src');
const { RecordQueue } = require(path.join(ROOT, 'record-queue.js'));
const i18n = require(path.join(ROOT, 'i18n.js'));
const ru = i18n.stringsFor('ru');
setTimeout(() => { console.error('timeout'); app.exit(2); }, 60000);
const stub = `<script>window.__cb = {}; window.overlay = { onLevel: (cb) => window.__cb.level = cb, onState: (cb) => window.__cb.state = cb, clicked: () => {} };</script>`;
// same arithmetic as refreshOverlay() in index.js
const widthFor = (q) => { const items = q.view(); const n = q.jobs.length > 1; const bw = n ? 112 : 96;
  return items.reduce((w, it) => w + (it.more ? 34 : bw), 0) + 6 * (items.length - 1); };
const stateFor = (q) => ({ items: q.view(), numbered: q.jobs.length > 1, busy: [ru['ov.busy1'], ru['ov.busy2']], done: [ru['ov.done1'], ru['ov.done2']] });
const scenarios = [];
{ const q = new RecordQueue(); q.start(1); scenarios.push(['1-recording', q]); }
{ const q = new RecordQueue(); q.start(1); q.stop(1); scenarios.push(['1-busy', q]); }
{ const q = new RecordQueue(); q.start(1); q.stop(1); q.done(1, 'x'); scenarios.push(['1-done', q]); }
{ const q = new RecordQueue(); q.start(1); q.stop(1); q.done(1, 'x'); q.start(2); q.stop(2); q.start(3); scenarios.push(['3-done-busy-rec', q]); }
{ const q = new RecordQueue(); for (let i = 1; i <= 6; i++) { q.start(i); q.stop(i); } q.done(1, 'x'); q.start(7); scenarios.push(['7-with-more', q]); }
app.whenReady().then(async () => {
  const srv = http.createServer((req, res) => fs.readFile(path.join(ROOT, 'recorder-overlay.html'), 'utf8', (e, d) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d.replace('<head>', '<head>' + stub).replace('</style>', 'body::before { content: "Сохранить изменения · Отправить · Отмена"; position: absolute; left: 10px; top: 11px; font: 14px Segoe UI; color: ' + (process.env.FG || '#222') + '; z-index: -1; } </style>')); }));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const w = new BrowserWindow({ width: 700, height: 40, show: false, frame: false, transparent: false, backgroundColor: process.env.BG || '#888888' });
  w.webContents.on('console-message', (e, level, msg, line) => console.log('page:', level, msg, line));
  await w.loadURL('http://127.0.0.1:' + srv.address().port + '/');
  await new Promise(r => setTimeout(r, 300));
  for (const [name, q] of scenarios) {
    const expected = widthFor(q);
    await w.webContents.executeJavaScript(`console.log('cb', typeof window.__cb.state); window.__cb.state(${JSON.stringify(stateFor(q))}); window.__cb.level(0.8); 0`);
    await new Promise(r => setTimeout(r, 150));
    const m = await w.webContents.executeJavaScript(`(() => { const r = document.getElementById('row');
      const kids = [...r.children]; const last = kids[kids.length - 1].getBoundingClientRect();
      const overflow = kids.filter(k => k.scrollWidth > k.clientWidth + 1).length;
      return { drawn: Math.round(last.right), barrels: kids.length, overflow, text: kids.map(k => k.innerText.split(String.fromCharCode(10)).join(' ').trim() || '[eq]').join(' | ') }; })()`);
    console.log(`${name.padEnd(16)} window=${expected} drawn=${m.drawn} ${m.drawn === expected ? 'OK' : 'MISMATCH'} overflow=${m.overflow}  ${m.text}`);
    fs.writeFileSync(path.join(__dirname, `ovt-${process.env.TAG}-${name}.png`), (await w.webContents.capturePage({ x: 0, y: 0, width: Math.max(expected, 96), height: 40 })).toPNG());
  }
  app.quit();
});
