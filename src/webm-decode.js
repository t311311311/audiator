// A saved recording (WebM with Opus, as MediaRecorder writes it) back to the
// sound the engine takes: WAV, 16 kHz, mono. Needed when a recording is
// transcribed from its file — after the program was closed or crashed, or
// when the user picks one ("Transcribe an audio file…"); a live recording
// hands the engine its sound straight from the microphone instead.
//
// Decoding is Chromium's own (WebCodecs AudioDecoder): no ffmpeg/PyAV, whose
// GPL parts the program may not ship. Channels are averaged; 48 kHz goes to
// 16 kHz through a low-pass filter (7 kHz) keeping every third sample. It
// works piece by piece, so a two-hour recording does not need gigabytes.
//
//   const { wav, seconds } = await AudiatorAudio.webmToWav(bytes);
(function () {
  // --- the container: the track's codec and setup, and its blocks of sound ---
  function demux(buf) {
    const head = (p) => {
      let n = 1; while (n <= 4 && !(buf[p] & (0x100 >> n))) n++;
      let id = 0; for (let i = 0; i < n; i++) id = id * 256 + buf[p + i];
      const s = p + n; let l = 1; while (l <= 8 && !(buf[s] & (0x100 >> l))) l++;
      if (n > 4 || l > 8 || s + l > buf.length) return null;
      const m = (0x100 >> l) - 1; let size = buf[s] & m, unknown = size === m;
      for (let i = 1; i < l; i++) { size = size * 256 + buf[s + i]; if (buf[s + i] !== 0xff) unknown = false; }
      return { id, data: s + l, end: unknown ? -1 : s + l + size };
    };
    const uint = (a, e) => { let v = 0; for (let i = a; i < e; i++) v = v * 256 + buf[i]; return v; };
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    // Segment, Tracks, TrackEntry, Cluster and BlockGroup hold what is read.
    const CONTAINERS = new Set([0x18538067, 0x1654AE6B, 0xAE, 0xE1, 0x1F43B675, 0xA0]);
    const out = { codec: null, setup: null, channels: 1, rate: 48000, blocks: [] };
    let clusterTime = 0;
    const block = (a, e) => {
      let l = 1; while (l <= 8 && !(buf[a] & (0x100 >> l))) l++; // the track number
      if (a + l + 3 > e) return;
      const rel = view.getInt16(a + l);
      if (buf[a + l + 2] & 0x06) throw new Error('laced blocks are not supported');
      out.blocks.push({ t: clusterTime + rel, data: buf.subarray(a + l + 3, e) });
    };
    const walk = (a, e) => {
      for (let p = a; p < e;) {
        const h = head(p);
        if (!h) return; // a cut-off tail
        const end = h.end < 0 ? e : Math.min(h.end, e);
        const cut = h.end > e; // cut off by a crash: what is there of a cluster is read, a cut block left out
        if (CONTAINERS.has(h.id)) { walk(h.data, end); if (h.end < 0 || cut) return; }
        else if (cut) return;
        else if (h.id === 0x86) out.codec = String.fromCharCode(...buf.subarray(h.data, end));
        else if (h.id === 0x63A2) out.setup = buf.slice(h.data, end);
        else if (h.id === 0x9F) out.channels = uint(h.data, end);
        else if (h.id === 0xB5) out.rate = end - h.data === 4 ? view.getFloat32(h.data) : view.getFloat64(h.data);
        else if (h.id === 0xE7) clusterTime = uint(h.data, end);
        else if (h.id === 0xA3 || h.id === 0xA1) block(h.data, end); // SimpleBlock, Block
        p = end;
      }
    };
    walk(0, buf.length);
    return out;
  }

  // --- 48 kHz -> 16 kHz, piece by piece ---
  function decimator() {
    const TAPS = 63, HALF = 31, fc = 7000 / 48000;
    const h = new Float32Array(TAPS);
    let sum = 0;
    for (let i = 0; i < TAPS; i++) {
      const k = i - HALF;
      h[i] = (k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k)) * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (TAPS - 1)));
      sum += h[i];
    }
    for (let i = 0; i < TAPS; i++) h[i] /= sum;
    let tail = new Float32Array(0), tailStart = 0; // input not used up yet, and where it starts
    let next = 0;                                  // the input sample the next output is centred on
    const parts = []; let count = 0;
    const push = (x) => {
      const buf = new Float32Array(tail.length + x.length);
      buf.set(tail); buf.set(x, tail.length);
      const base = tailStart;
      const o = new Int16Array(Math.max(0, Math.ceil((base + buf.length - HALF - next) / 3)));
      let n = 0;
      while (next + HALF < base + buf.length) {
        let acc = 0;
        const from = next - HALF - base;
        for (let i = 0; i < TAPS; i++) { const j = from + i; if (j >= 0) acc += buf[j] * h[i]; }
        const v = Math.max(-1, Math.min(1, acc));
        o[n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        next += 3;
      }
      if (n) { parts.push(o.subarray(0, n)); count += n; }
      const keep = Math.max(0, next - HALF - base);
      tail = buf.slice(keep); tailStart = base + keep;
    };
    const finish = () => { push(new Float32Array(HALF + 3)); return { parts, count }; };
    return { push, finish };
  }

  function wav(parts, count, rate) {
    const head = new DataView(new ArrayBuffer(44));
    const text = (at, s) => { for (let i = 0; i < s.length; i++) head.setUint8(at + i, s.charCodeAt(i)); };
    text(0, 'RIFF'); head.setUint32(4, 36 + count * 2, true); text(8, 'WAVE');
    text(12, 'fmt '); head.setUint32(16, 16, true); head.setUint16(20, 1, true); head.setUint16(22, 1, true);
    head.setUint32(24, rate, true); head.setUint32(28, rate * 2, true); head.setUint16(32, 2, true);
    head.setUint16(34, 16, true); text(36, 'data'); head.setUint32(40, count * 2, true);
    return new Blob([head.buffer, ...parts], { type: 'audio/wav' });
  }

  async function webmToWav(bytes) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const m = demux(buf);
    if (m.codec !== 'A_OPUS') throw new Error(`not an Opus recording (${m.codec || 'unknown'})`);
    if (Math.round(m.rate) !== 48000) throw new Error(`unsupported sample rate ${m.rate}`);
    if (!m.blocks.length) throw new Error('no sound in the file');
    const dec16 = decimator();
    let failure = null;
    const decoder = new AudioDecoder({
      output: (ad) => {
        try {
          const n = ad.numberOfFrames, chs = ad.numberOfChannels;
          const mono = new Float32Array(n), plane = new Float32Array(n);
          for (let c = 0; c < chs; c++) {
            ad.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
            for (let i = 0; i < n; i++) mono[i] += plane[i] / chs;
          }
          dec16.push(mono);
        } catch (e) { failure = failure || e; } finally { ad.close(); }
      },
      error: (e) => { failure = failure || e; },
    });
    decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: m.channels, description: m.setup || undefined });
    for (const b of m.blocks) {
      if (failure) break;
      // A few dozen pieces ahead at most: the decoder's queue would hold the whole file otherwise.
      while (decoder.decodeQueueSize > 32) await new Promise((r) => decoder.addEventListener('dequeue', r, { once: true }));
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.max(0, b.t) * 1000, data: b.data }));
    }
    await decoder.flush().catch((e) => { failure = failure || e; });
    decoder.close();
    if (failure) throw failure;
    const { parts, count } = dec16.finish();
    return { wav: wav(parts, count, 16000), seconds: count / 16000 };
  }

  window.AudiatorAudio = { webmToWav };
})();
