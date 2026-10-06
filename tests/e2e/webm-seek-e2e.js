// Stand: recordings can be sought in (src/webm-seekable.js). Records with the
// real MediaRecorder (a synthetic tone for a microphone), rewrites the file
// and checks it: its structure (SeekHead and index point where they should,
// the length is there), then in Chromium's own player — the raw recording
// has no length (Infinity) and cannot be sought in; the rewritten one has
// its length and seeks. A recording cut off mid-way (a crash) is read too.
//   node_modules\.bin\electron tests\e2e\webm-seek-e2e.js      (LENGTHS=3,40 seconds)
const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs'), os = require('os');
const { makeSeekable } = require('C:/Test01/tray-translator/src/webm-seekable.js');
// The files stay for a listen in other players (VLC, Media Player): the folder is printed at the end.
const OUT = path.join(os.tmpdir(), 'audiator-webm-seek');
const LENGTHS = (process.env.LENGTHS || '3,40').split(',').map(Number);
setTimeout(() => { console.error('timeout'); app.exit(2); }, (LENGTHS.reduce((a, b) => a + b, 0) + 90) * 1000);

let failed = 0;
const check = (what, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

// --- a tiny EBML reader of its own, to check the result independently ---
function head(buf, pos) {
  let n = 1; while (n <= 4 && !(buf[pos] & (0x100 >> n))) n++;
  let id = 0; for (let i = 0; i < n; i++) id = id * 256 + buf[pos + i];
  const s = pos + n; let l = 1; while (l <= 8 && !(buf[s] & (0x100 >> l))) l++;
  let size = buf[s] & ((0x100 >> l) - 1); for (let i = 1; i < l; i++) size = size * 256 + buf[s + i];
  return { id, start: pos, data: s + l, end: s + l + size };
}
const uintAt = (buf, a, b) => { let v = 0; for (let i = a; i < b; i++) v = v * 256 + buf[i]; return v; };
function children(buf, h) { const out = []; for (let p = h.data; p < h.end;) { const c = head(buf, p); out.push(c); p = c.end; } return out; }
function structure(buf) {
  const ebml = head(buf, 0), seg = head(buf, ebml.end), kids = children(buf, seg);
  const idAt = (rel) => head(buf, seg.data + rel).id;
  const sh = kids.find((k) => k.id === 0x114D9B74), info = kids.find((k) => k.id === 0x1549A966);
  const cues = kids.find((k) => k.id === 0x1C53BB6B), clusters = kids.filter((k) => k.id === 0x1F43B675);
  const seeks = sh ? children(buf, sh).map((s) => { const [i, p] = children(buf, s); return { id: uintAt(buf, i.data, i.end), at: uintAt(buf, p.data, p.end) }; }) : [];
  const dur = info && children(buf, info).find((c) => c.id === 0x4489);
  const cuePos = cues ? children(buf, cues).map((cp) => { const tp = children(buf, cp).find((c) => c.id === 0xB7);
    const pos = children(buf, tp).find((c) => c.id === 0xF1); return uintAt(buf, pos.data, pos.end); }) : [];
  return {
    segmentWhole: seg.end === buf.length,
    seeksRight: seeks.length === 3 && seeks.every((s) => idAt(s.at) === s.id),
    duration: dur ? buf.readDoubleBE(dur.data) : null,
    clusters: clusters.length,
    cuesRight: cuePos.length === clusters.length && cuePos.every((p) => idAt(p) === 0x1F43B675),
  };
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const rec = new BrowserWindow({ show: false, webPreferences: { autoplayPolicy: 'no-user-gesture-required' } });
  await rec.loadURL('data:text/html,<title>rec</title>');
  const player = new BrowserWindow({ show: false, webPreferences: { autoplayPolicy: 'no-user-gesture-required' } });
  fs.writeFileSync(path.join(OUT, 'player.html'), '<audio id="a" preload="auto"></audio>');
  await player.loadFile(path.join(OUT, 'player.html'));
  // Chromium's view of a file: its length, and whether a jump to the middle lands there.
  const probe = (file) => player.webContents.executeJavaScript(`new Promise((done) => {
    const a = document.getElementById('a'); const t0 = Date.now();
    a.onloadedmetadata = () => {
      const duration = a.duration, seekable = a.seekable.length ? a.seekable.end(0) : 0;
      if (!isFinite(duration)) return done({ duration: String(duration), seekable });
      const target = duration / 2;
      a.onseeked = () => done({ duration, seekable, target, landed: a.currentTime });
      a.currentTime = target;
      setTimeout(() => done({ duration, seekable, target, landed: null }), 4000);
    };
    a.onerror = () => done({ error: a.error && a.error.code });
    a.src = ${JSON.stringify(path.basename(file))};
  })`);

  for (const seconds of LENGTHS) {
    const b64 = await rec.webContents.executeJavaScript(`new Promise(async (done) => {
      const c = new AudioContext(); const o = c.createOscillator(); const g = c.createGain(); g.gain.value = 0.3;
      const d = c.createMediaStreamDestination(); o.connect(g); g.connect(d); o.start();
      await c.resume(); while (c.currentTime < 0.3) await new Promise((r) => setTimeout(r, 50)); // the tone is really on
      const r = new MediaRecorder(d.stream); const parts = [];
      r.ondataavailable = (e) => parts.push(e.data);
      r.onstop = async () => { const buf = new Uint8Array(await new Blob(parts).arrayBuffer());
        let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        done(btoa(s)); };
      r.start(); setTimeout(() => r.stop(), ${seconds * 1000});
    })`);
    const raw = Buffer.from(b64, 'base64');
    const t = Date.now();
    const fixed = makeSeekable(raw);
    const ms = Date.now() - t;
    fs.writeFileSync(path.join(OUT, `raw-${seconds}.webm`), raw);
    check(`${seconds} s: rewritten`, !!fixed, `${raw.length} -> ${fixed ? fixed.length : '-'} bytes, ${ms} ms`);
    if (!fixed) continue;
    fs.writeFileSync(path.join(OUT, `seekable-${seconds}.webm`), fixed);
    const s = structure(fixed);
    check(`${seconds} s: structure (Segment, SeekHead, index -> clusters)`, s.segmentWhole && s.seeksRight && s.cuesRight, JSON.stringify(s));
    check(`${seconds} s: length in the file`, Math.abs(s.duration / 1000 - seconds) < 0.6, (s.duration / 1000).toFixed(2) + ' s');
    const before = await probe(path.join(OUT, `raw-${seconds}.webm`));
    check(`${seconds} s: raw recording has no length (as MediaRecorder writes it)`, before.duration === 'Infinity', JSON.stringify(before));
    const after = await probe(path.join(OUT, `seekable-${seconds}.webm`));
    check(`${seconds} s: Chromium sees the length and seeks to the middle`,
      Math.abs(after.duration - seconds) < 0.6 && after.landed !== null && Math.abs(after.landed - after.target) < 0.3, JSON.stringify(after));
    const again = makeSeekable(fixed);
    check(`${seconds} s: a second pass changes nothing`, again && again.equals(fixed));
    // Cut off at 70 % (a crash mid-recording): what is there stays playable.
    const cut = makeSeekable(raw.subarray(0, Math.floor(raw.length * 0.7)));
    if (cut) fs.writeFileSync(path.join(OUT, `cut-${seconds}.webm`), cut);
    const c = cut && await probe(path.join(OUT, `cut-${seconds}.webm`));
    check(`${seconds} s: cut-off recording still rewritten and playable`, !!(c && isFinite(c.duration) && c.duration > seconds * 0.5), JSON.stringify(c));
  }
  check('not a WebM: gives up (null), the caller keeps the original', makeSeekable(Buffer.from('RIFF....WAVEfmt ')) === null);
  console.log('files: ' + OUT);
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  app.exit(failed ? 1 : 0);
});
