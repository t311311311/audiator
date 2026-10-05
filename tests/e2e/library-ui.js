// Stand: every recording kept as a file, one Save button, the translation
// language chosen once, four buttons of one width (user's wishes 2026-10-05).
// The real index.html and settings.html with a stand-in api (calls are
// recorded, nothing is written anywhere) and a synthetic microphone; then
// snapshots of both windows in three languages and two themes.
//   node_modules\.bin\electron tests\e2e\library-ui.js
const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs'), http = require('http');
const ROOT = path.resolve('C:/Test01/tray-translator/src');
const OUT = __dirname;
const i18n = require(path.join(ROOT, 'i18n.js'));
setTimeout(() => { console.error('timeout'); app.exit(2); }, 120000);

const FOLDER = 'C:/Users/someone/Downloads/Audiator';
function mainStub(lang, theme) {
  const I18N = JSON.stringify({ lang, languages: i18n.LANGUAGES, strings: i18n.stringsFor(lang) });
  return `<script>
  // A fresh start for the stand's first page in a window; kept across its reloads (a restart).
  try { if (!sessionStorage.getItem('started')) { localStorage.removeItem('translateDefault'); sessionStorage.setItem('started', '1'); } } catch (e) {}
  const noop = () => {}; window.__cb = {}; window.__jobs = []; let __n = 0;
  window.__calls = { begin: [], chunks: [], end: [], done: [], discard: [], saveTexts: [], openFile: [], translate: [] };
  const engine = (installed) => ({ model: 'small', state: 'ready', models: {}, translate: { installed, queue: [], failed: {} } });
  window.api = { getI18n: () => Promise.resolve(${I18N}),
    getSettings: () => Promise.resolve({ theme: '${theme}', fontSize: 16, fontFamily: 'Arial, sans-serif' }),
    onSettingsUpdated: noop, onHotkeyToggleRecord: noop, recLevel: noop, close: noop, minimize: noop, quit: noop, logError: noop,
    recordingStarted: noop, recordingStopped: noop, transcribeFailed: noop, transcribed: () => Promise.resolve({ copied: false }),
    transcribe: () => new Promise((r) => window.__jobs.push(r)), onTranscribeProgress: noop,
    getEngineStatus: () => Promise.resolve(engine(['en', 'ru'])), onEngineStatus: (cb) => { window.__cb.engine = cb; },
    translateCatalog: () => Promise.resolve([{ code: 'ru', name: 'Russian', size: 61e6 }]),
    translate: (text, target, source) => { window.__calls.translate.push({ text, target, source }); return Promise.resolve({ success: true, translatedText: 'Translated: ' + text }); },
    translateDelete: (code) => Promise.resolve(engine(['en'])), translateInstall: noop, translateCancel: noop,
    confirmBox: () => Promise.resolve(true),
    getAccount: () => Promise.resolve({ signedIn: true, plan: 'admin', limited: false }), onAccountUpdated: noop, limitReached: noop,
    loadHistory: () => Promise.resolve(JSON.parse(sessionStorage.getItem('history') || '[]')),
    saveHistory: (l) => { window.__saved = l; }, historyCleared: noop,
    recordingBegin: (when) => { window.__calls.begin.push(when);
      return Promise.resolve({ id: 'p' + (++__n), file: '${FOLDER}/audio_13560' + __n + '_051026.webm' }); },
    recordingChunk: (file, blob) => { window.__calls.chunks.push({ file, size: blob.size, at: Date.now() }); },
    recordingEnd: (id, file) => { window.__calls.end.push({ id, file, at: Date.now() }); return Promise.resolve({ file, seconds: 1, id }); },
    pendingDone: (id) => { window.__calls.done.push(id); return Promise.resolve(true); },
    discardRecording: (f) => { window.__calls.discard.push(f); return Promise.resolve(true); },
    saveTexts: (items) => { window.__calls.saveTexts.push(items);
      return Promise.resolve({ files: items.map((it, i) => '${FOLDER}/transcribe_' + i + '.txt'), folder: '${FOLDER}' }); },
    openFile: (f) => { window.__calls.openFile.push(f); return Promise.resolve(/gone/.test(f) ? { missing: true } : { ok: true }); },
  };
  navigator.mediaDevices.getUserMedia = async () => { const c = new AudioContext(); const o = c.createOscillator(); const g = c.createGain(); g.gain.value = 0.3;
    const d = c.createMediaStreamDestination(); o.connect(g); g.connect(d); o.start(); return d.stream; };
  </script>`;
}
function settingsStub(lang) {
  const I18N = JSON.stringify({ lang, languages: i18n.LANGUAGES, strings: i18n.stringsFor(lang) });
  return `<script>
  const noop = () => {}; window.__calls = { choose: [], open: [] };
  window.settingsApi = { send: noop, receive: noop, onInitialSettings: noop,
    getAppVersion: () => Promise.resolve('1.0.8'), getI18n: () => Promise.resolve(${I18N}),
    getEngineStatus: () => Promise.resolve({ model: 'small', state: 'ready', models: {
      base: { installed: false, size: 147883000 }, small: { installed: true, size: 486212000 }, 'large-v3-turbo': { installed: false, size: 1621666000 } } }),
    onEngineStatus: noop, deleteModel: noop,
    getAccount: () => Promise.resolve({ signedIn: true, email: 'someone@example.com', plan: 'free', limited: true, remaining: 2600, resetsAt: Date.now() + 4 * 3600e3 }),
    onAccountUpdated: noop, signOut: noop, openTerms: noop, openSupport: noop, confirmBox: () => Promise.resolve(true),
    getSaveFolder: () => Promise.resolve('C:\\\\Users\\\\someone\\\\Downloads\\\\Audiator'),
    chooseFolder: (cur, l) => { window.__calls.choose.push(cur); return Promise.resolve('D:\\\\Work\\\\Projects\\\\Customer interviews 2026\\\\Recordings\\\\Audiator'); },
    openFolder: (f) => { window.__calls.open.push(f); return Promise.resolve({ ok: true }); } };
  </script>`;
}

let failed = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const name = u.pathname.replace(/^\//, '');
    const lang = u.searchParams.get('lang') || 'ru', theme = u.searchParams.get('theme') || 'dark';
    fs.readFile(path.join(ROOT, name), 'utf8', (e, d) => {
      if (e) { res.writeHead(404); res.end(); return; }
      if (name === 'index.html') d = d.replace('<head>', '<head>' + mainStub(lang, theme));
      if (name === 'settings.html') {
        d = d.replace('<head>', '<head>' + settingsStub(lang));
        if (theme === 'light') d = d.replace('<body>', '<body class="light-theme">');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/`;

  // --- Behaviour (Russian, dark) ---
  const w = new BrowserWindow({ width: 400, height: 600, show: false, frame: false, webPreferences: { autoplayPolicy: 'no-user-gesture-required' } });
  await w.loadURL(base + 'index.html?lang=ru&theme=dark');
  await sleep(800);
  const js = (c) => w.webContents.executeJavaScript(c);
  const R = i18n.stringsFor('ru');

  // Four buttons of one width and height; the stop button too.
  const widths = () => js(`['record-btn', 'stop-btn', 'save-btn', 'translate-group', 'copy-btn'].map((id) => document.getElementById(id))
    .filter((b) => b.offsetParent).map((b) => Math.round(b.getBoundingClientRect().width) + 'x' + Math.round(b.getBoundingClientRect().height))`);
  const idle = await widths();
  check('record, save, translate, copy: one width, one height', idle.length === 4 && new Set(idle).size === 1, idle.join(' '));
  check('the old "save audio" buttons are gone', await js(`!document.getElementById('save-audio-btn') && !document.getElementById('save-audio-text-btn')`));
  check('tooltips: Save / Translate / language arrow / copy-latest',
    (await js(`[document.getElementById('save-btn').title, document.getElementById('translate-btn').title, document.getElementById('translate-pick').title].join('|')`))
      === [R['title.save'], R['title.translate'], R['translate.pick']].join('|'));

  // A recording: its file is written while it is made, ▶ once its text is there.
  const record = async (ms = 1200) => {
    await js(`document.getElementById('record-btn').click()`); await sleep(ms);
    const during = await widths();
    await js(`document.getElementById('stop-btn').click()`); await sleep(900);
    return during;
  };
  const during = await record(2600);
  check('while recording the stop button has the same width', new Set(during).size === 1 && during[0] === idle[0], during.join(' '));
  let calls = await js('window.__calls');
  const piecesBefore = calls.chunks.filter((c) => c.at < calls.end[0].at - 300);
  check('its file begins with it; the sound goes in every second while recording',
    calls.begin.length === 1 && piecesBefore.length >= 2 && calls.chunks.every((c) => /audio_135601/.test(c.file)) && calls.end.length === 1,
    `begin ${calls.begin.length}, pieces ${calls.chunks.length} (${piecesBefore.length} before the stop), end ${calls.end.length}`);
  check('its time is the entry\'s time — when it started (one name for audio and text)',
    calls.begin[0] === await js(`document.querySelector('.history-entry').dataset.isoTimestamp`));
  check('no ▶ while transcribing; still in the queue', (await js(`document.querySelector('.history-entry .entry-play').hidden`)) && calls.done.length === 0);
  await js(`window.__jobs.shift()({ success: true, text: 'Первая запись', language: 'ru' })`); await sleep(300);
  check('its text in the history: out of the queue', JSON.stringify((await js('window.__calls')).done) === '["p1"]');
  const first = await js(`(() => { const e = document.querySelector('.history-entry'); return { play: !e.querySelector('.entry-play').hidden,
    audio: e.dataset.audio, copy: !e.querySelector('.entry-copy').hidden, tick: !e.querySelector('.entry-check').hidden,
    playTitle: e.querySelector('.entry-play').title, copyTitle: e.querySelector('.entry-copy').title, tickTitle: e.querySelector('.entry-check').title }; })()`);
  check('with a text: ▶, copy and tick; the file is the entry\'s', first.play && first.copy && first.tick && /audio_135601_051026\.webm$/.test(first.audio), JSON.stringify(first));
  check('tooltips: ▶ / copy the original / tick for translation and saving',
    first.playTitle === R['title.play'] && first.copyTitle === R['title.copyOriginal'] && first.tickTitle === R['translate.select'],
    [first.playTitle, first.copyTitle, first.tickTitle].join(' | '));

  await record(); // no speech in it
  await js(`window.__jobs.shift()({ success: true, text: '' })`); await sleep(300);
  calls = await js('window.__calls');
  const empty = await js(`(() => { const e = document.querySelector('.history-entry'); return { text: e.querySelector('.original-text').textContent,
    play: !e.querySelector('.entry-play').hidden, copy: !e.querySelector('.entry-copy').hidden, tick: !e.querySelector('.entry-check').hidden }; })()`);
  check('"no speech": its file taken back; no ▶, no copy, no tick',
    calls.discard.length === 1 && /audio_135602/.test(calls.discard[0]) && !empty.play && !empty.copy && !empty.tick && empty.text === R['status.noText'],
    JSON.stringify({ discard: calls.discard, ...empty }));

  await record(); // the engine fails
  await js(`window.__jobs.shift()({ success: false, error: 'engine down' })`); await sleep(300);
  check('an engine error keeps the recording: ▶ to listen', await js(`!document.querySelector('.history-entry .entry-play').hidden`));
  await sleep(400);
  const kept = await js('window.__saved');
  check('the kept history has the text with its file (not "no speech", not the error)',
    Array.isArray(kept) && kept.length === 1 && kept[0].text === 'Первая запись' && /audio_135601/.test(kept[0].a), JSON.stringify(kept));

  // ▶ opens the file; gone -> said so.
  await js(`document.querySelectorAll('.history-entry')[2].querySelector('.entry-play').click()`); await sleep(200);
  calls = await js('window.__calls');
  check('▶ opens the recording\'s file', calls.openFile.length === 1 && /audio_135601/.test(calls.openFile[0]));
  await js(`(() => { const e = document.querySelectorAll('.history-entry')[2]; e.dataset.audio = '${FOLDER}/gone.webm'; e.querySelector('.entry-play').click(); })()`);
  await sleep(300);
  check('a moved or deleted file: "Файл удалён или перемещён"', (await js(`document.getElementById('toast').textContent`)) === R['toast.fileMissing']);
  await js(`document.querySelectorAll('.history-entry')[2].dataset.audio = '${FOLDER}/audio_135601_051026.webm'`);

  // Save: nothing ticked -> the latest text (an error or "no speech" on top is passed over).
  await js(`document.getElementById('save-btn').click()`); await sleep(300);
  calls = await js('window.__calls');
  const one = calls.saveTexts[0] || [];
  check('Save, nothing ticked: the latest text, one file, named after its recording',
    one.length === 1 && /audio_135601/.test(one[0].audio) && one[0].text.includes(`${R['history.original']}: Первая запись`), JSON.stringify(one));
  check('toast: the file and the folder', (await js(`document.getElementById('toast').textContent`)) === `${R['toast.saved'].replace('{name}', 'transcribe_0.txt')}\n${FOLDER}`,
    JSON.stringify(await js(`document.getElementById('toast').textContent`)));
  // Two more texts, two ticked -> two files; the ticks go.
  await js(`(() => { for (const t of ['Вторая', 'Третья']) { const p = addPendingEntry(); p.originalTextField.classList.remove('pending');
    p.originalTextField.textContent = t; p.check.hidden = false; p.originalCopy.btn.hidden = false; p.originalTextField.closest('.history-entry').dataset.lang = 'ru'; }
    updateActionButtons(); document.querySelectorAll('.entry-check')[0].click(); document.querySelectorAll('.entry-check')[1].click(); })()`);
  await js(`document.getElementById('save-btn').click()`); await sleep(300);
  calls = await js('window.__calls');
  const two = calls.saveTexts[1] || [];
  check('two ticked: two files, one each', two.length === 2 && two[0].text.includes('Третья') && two[1].text.includes('Вторая'), JSON.stringify(two.map((x) => x.text.split('\n')[2])));
  check('ticks cleared after saving', (await js(`document.querySelectorAll('.entry-check:checked').length`)) === 0);
  check('toast: "Сохранено файлов: 2"', (await js(`document.getElementById('toast').textContent`)).startsWith(R['toast.savedN'].replace('{n}', 2)));

  // Translate: chosen once, then straight away.
  const panelOpen = () => js(`!document.getElementById('translate-bar').classList.contains('hidden')`);
  check('no language chosen yet: no code on the button', (await js(`document.getElementById('tb-lang').textContent`)) === '');
  await js(`document.getElementById('translate-btn').click()`); await sleep(200);
  check('Translate with no language chosen opens the list', (await panelOpen()) && (await js('window.__calls.translate.length')) === 0);
  await js(`[...document.querySelectorAll('#tp-installed .tp-name')].find((b) => b.textContent === 'Английский').click()`); await sleep(400);
  calls = await js('window.__calls');
  check('a click on English translates into it and makes it the one',
    calls.translate.length === 1 && calls.translate[0].target === 'en' && (await js(`document.getElementById('tb-lang').textContent`)) === 'EN' && !(await panelOpen()),
    JSON.stringify(calls.translate));
  check('the translation\'s copy button: "copy the translated text"',
    (await js(`document.querySelector('.translated-text').parentElement.querySelector('.entry-copy').title`)) === R['title.copyTranslation']);
  await js(`document.getElementById('translate-btn').click()`); await sleep(300);
  check('next time Translate goes straight into English, no list', (await js('window.__calls.translate.length')) === 2 && !(await panelOpen()));
  await js(`document.getElementById('translate-pick').click()`); await sleep(200);
  check('the arrow opens the list, English framed as the one',
    (await panelOpen()) && (await js(`[...document.querySelectorAll('#tp-installed .tp-default .tp-name')].map((b) => b.textContent).join()`)) === 'Английский');
  await js(`document.getElementById('translate-pick').click()`); await sleep(200);
  check('the arrow again closes it', !(await panelOpen()));
  await w.webContents.reload(); await sleep(900);
  check('remembered after a restart', (await js(`document.getElementById('tb-lang').textContent`)) === 'EN');
  // The ticks stay after translating: the same texts into another language just by picking it.
  await js(`(() => { for (const t of ['Раз', 'Два']) { const p = addPendingEntry(); p.originalTextField.classList.remove('pending');
    p.originalTextField.textContent = t; p.check.hidden = false; p.originalCopy.btn.hidden = false; p.originalTextField.closest('.history-entry').dataset.lang = 'ru'; }
    updateActionButtons(); document.querySelectorAll('.entry-check').forEach((c) => c.click()); })()`);
  await js(`document.getElementById('translate-btn').click()`); await sleep(400);
  check('two ticked, Translate: both into English, the ticks stay',
    (await js(`window.__calls.translate.map((c) => c.target + ':' + c.text).join()`)) === 'en:Два,en:Раз' && (await js(`document.querySelectorAll('.entry-check:checked').length`)) === 2);
  await js(`document.getElementById('translate-pick').click()`); await sleep(200);
  check('the list title says the two ticked', (await js(`document.getElementById('tp-title').textContent`)) === R['translate.toChecked'].replace('{n}', 2));
  await js(`[...document.querySelectorAll('#tp-installed .tp-name')].find((b) => b.textContent === 'Русский').click()`); await sleep(400);
  check('another language picked in the list becomes the one', (await js(`document.getElementById('tb-lang').textContent`)) === 'RU');
  check('...and the same two go into it, still ticked',
    (await js(`window.__calls.translate.slice(2).map((c) => c.target + ':' + c.text).join()`)) === 'ru:Два,ru:Раз' && (await js(`document.querySelectorAll('.entry-check:checked').length`)) === 2);
  await js(`document.getElementById('translate-pick').click()`); await sleep(200);
  await js(`document.getElementById('tp-reset').click()`); await sleep(100);
  check('"Сбросить" in the list clears the ticks', (await js(`document.querySelectorAll('.entry-check:checked').length`)) === 0);
  await js(`document.getElementById('translate-pick').click()`); await sleep(200);
  await js(`document.getElementById('translate-pick').click()`); await sleep(200);
  await js(`document.querySelector('#tp-installed .tp-default .tp-delete').click()`); await sleep(400);
  check('deleting that language: Translate asks again', (await js(`document.getElementById('tb-lang').textContent`)) === '');

  // Restored history: ▶ only where a file was kept.
  await js(`sessionStorage.setItem('history', JSON.stringify([
    { t: '2026-10-05T10:56:07.000Z', lang: 'ru', text: 'С файлом', tr: 'With a file', a: '${FOLDER}/audio_135607_051026.webm' },
    { t: '2026-10-05T10:50:00.000Z', lang: 'ru', text: 'Без файла (до этой версии)', tr: null }]))`);
  await w.webContents.reload(); await sleep(900);
  const restored = await js(`[...document.querySelectorAll('.history-entry')].map((e) => ({ play: !e.querySelector('.entry-play').hidden, audio: e.dataset.audio || null }))`);
  check('restored: ▶ where a file was kept, none where not', restored.length === 2 && restored[0].play && /135607/.test(restored[0].audio) && !restored[1].play, JSON.stringify(restored));

  // --- Settings: the folder row ---
  const sw = new BrowserWindow({ width: 450, height: 760, useContentSize: true, show: false });
  await sw.loadURL(base + 'settings.html?lang=ru&theme=dark');
  await sleep(900);
  const sjs = (c) => sw.webContents.executeJavaScript(c);
  check('Settings: the folder in use', (await sjs(`document.getElementById('folder-path').title`)) === 'C:\\Users\\someone\\Downloads\\Audiator');
  await sjs(`document.getElementById('folder-change').click()`); await sleep(300);
  const shown = await sjs(`[document.getElementById('folder-path').textContent, document.getElementById('folder-path').title, currentSettings.saveFolder]`);
  check('a long folder: start cut with "…", the end shown, kept for Save', /^D:\\…\\.*Audiator$/.test(shown[0]) && shown[2] === shown[1], JSON.stringify(shown));
  await sjs(`document.getElementById('folder-open').click()`); await sleep(100);
  check('"Открыть" opens the folder shown', (await sjs('window.__calls.open[0]')) === shown[1]);
  const need = await sjs(`Math.ceil(document.querySelector('.settings-actions').getBoundingClientRect().bottom + 20)`);
  console.log('settings: height needed =', need);
  sw.destroy();

  // --- Snapshots: three languages, two themes ---
  for (const lang of ['ru', 'en', 'zh']) {
    for (const theme of ['dark', 'light']) {
      const m = new BrowserWindow({ width: 400, height: 600, show: false, frame: false });
      await m.loadURL(base + `index.html?lang=${lang}&theme=${theme}`);
      await sleep(700);
      await m.webContents.executeJavaScript(`(() => {
        const mk = (t, file, empty) => { const p = addPendingEntry(); const o = p.originalTextField; o.classList.remove('pending');
          o.textContent = empty ? S('status.noText') : t; if (empty) o.dataset.state = 'empty';
          const e = o.closest('.history-entry'); e.dataset.lang = 'ru'; if (file) { e.dataset.audio = file; p.play.hidden = false; }
          p.check.hidden = !!empty; p.originalCopy.btn.hidden = !!empty; return p; };
        mk('Надо сохранить все аудио и добавить значок воспроизведения.', 'a.webm');
        const p = mk('Second one, ticked for saving.', 'b.webm'); p.check.checked = true;
        const tr = document.createElement('div'); tr.className = 'translated-text'; tr.textContent = 'Вторая, отмечена для сохранения.';
        const c = withCopyButton(tr, true); c.btn.hidden = false; p.originalTextField.closest('.history-entry').appendChild(c.row);
        mk('', null, true);
        setDefaultLang('en'); updateActionButtons(); updateTranslateTitle();
      })()`);
      await sleep(300);
      const ws = await m.webContents.executeJavaScript(`['record-btn', 'save-btn', 'translate-group', 'copy-btn'].map((id) => Math.round(document.getElementById(id).getBoundingClientRect().width)).join('/')`);
      const fits = await m.webContents.executeJavaScript(`(() => { const l = document.querySelector('#translate-btn .tb-label'); return l.scrollWidth <= l.clientWidth; })()`);
      const label = await m.webContents.executeJavaScript(`(() => { const l = document.querySelector('#translate-btn .tb-label'); return l.textContent + ' ' + getComputedStyle(l).fontSize + ' ' + l.scrollWidth + '/' + l.clientWidth + ' + ' + document.getElementById('tb-lang').textContent; })()`);
      console.log('   label:', label);
      check(`${lang}/${theme}: four equal buttons, the label whole`, new Set(ws.split('/')).size === 1 && fits, ws);
      await m.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, `lib-main-${lang}-${theme}.png`), (await m.webContents.capturePage()).toPNG());
      // The menu with "Распознать аудиофайл…".
      await m.webContents.executeJavaScript(`document.getElementById('menu-btn').click()`);
      await sleep(200);
      const item = await m.webContents.executeJavaScript(`document.getElementById('transcribe-file-btn').textContent`);
      check(`${lang}/${theme}: the menu offers "${item}"`, item === i18n.stringsFor(lang)['menu.transcribeFile']);
      fs.writeFileSync(path.join(OUT, `lib-menu-${lang}-${theme}.png`), (await m.webContents.capturePage({ x: 0, y: 0, width: 400, height: 260 })).toPNG());
      m.destroy();

      const s = new BrowserWindow({ width: 450, height: need, useContentSize: true, show: false });
      await s.loadURL(base + `settings.html?lang=${lang}&theme=${theme}`);
      await sleep(900);
      await s.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, `lib-settings-${lang}-${theme}.png`), (await s.webContents.capturePage()).toPNG());
      s.destroy();
    }
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  app.exit(failed ? 1 : 0);
});
