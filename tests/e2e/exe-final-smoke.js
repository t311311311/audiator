// Scratch: the rebuilt engine exe (no PyAV, no MiniSBD): a WAV job, and translation.
const path = require('path'), fs = require('fs');
const ROOT = 'C:/Test01/tray-translator';
process.resourcesPath = path.join(__dirname, 'fixtures', 'res'); // a junction: res/engine -> build/engine/Audiator Engine
const engine = require(path.join(ROOT, 'src', 'engine.js'));
const api = require(path.join(ROOT, 'src', 'api.js'));
(async () => {
  engine.startEngine({ packaged: true, rootDir: ROOT, modelsDir: path.join(process.env.APPDATA, 'audiator', 'models'), model: 'small' });
  await engine.whenReady(); await engine.useModel('small'); await engine.whenModelReady();
  const seen = [];
  const r = await api.transcribe(fs.readFileSync(path.join(__dirname, 'fixtures', 'long-ru.wav')), '', (s) => seen.push(Math.floor(s * 100)));
  console.log('speech (WAV, 59 s):', [...new Set(seen)], '| duration', r.duration, '|', r.text.slice(0, 45));
  for (const [q, s, t] of [['Привет. Это проверка. Сегодня 4 окт., т.е. воскресенье! Хорошо.', 'ru', 'en'], ['Dr. Smith arrived. He left.', 'en', 'ru']]) {
    console.log(`translate ${s}->${t}:`, (await api.translate(q, t, s)).translatedText);
  }
  let webm = '';
  try { await api.transcribe(fs.readFileSync(path.join(__dirname, 'fixtures', 'test-ru.webm')), ''); webm = 'read (unexpected)'; }
  catch (e) { webm = 'refused, as expected without PyAV: ' + e.message.slice(0, 80); }
  console.log('a webm sent as it is:', webm);
  engine.stopEngine(); process.exit(0);
})().catch((e) => { console.error('FAILED', e); engine.stopEngine(); process.exit(1); });
