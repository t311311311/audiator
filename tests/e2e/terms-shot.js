const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs');
app.whenReady().then(async () => {
  for (const lang of [process.env.L]) {
    const w = new BrowserWindow({ width: 560, height: 640, show: false });
    await w.loadFile('C:/Test01/tray-translator/src/terms.html', { query: { lang, theme: 'dark' } });
    await new Promise((r) => setTimeout(r, 400));
    const info = await w.webContents.executeJavaScript(`[document.title, document.querySelectorAll('section.shown').length, document.querySelector('section.shown').getAttribute('lang'), document.body.scrollHeight]`);
    console.log(lang, JSON.stringify(info));
    await w.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, `terms-${lang}.png`), (await w.webContents.capturePage()).toPNG());
    w.destroy();
  }
  app.exit(0);
});
