// A recording made with MediaRecorder is written as a live stream: the WebM
// file has no length and no index of where each stretch of sound starts
// (Cues), as neither is known while recording — so players cannot seek in it,
// and some show no length at all. makeSeekable() rewrites such a file once the
// recording is over: the same sound, not re-encoded, with its length, an index
// of its clusters and a SeekHead that points at them. The file grows by a few
// dozen bytes per cluster (MediaRecorder starts one every few seconds).
//
// Own code, no library: the one there is (ts-ebml) bundles code without a
// licence, which a paid program should not ship. Only what MediaRecorder
// writes is expected — an EBML header, then a Segment of Info, Tracks and
// Clusters, often of "unknown" size. Anything it cannot read makes it give up
// (null), and the caller keeps the recording as it was.

const ID = {
  EBML: 0x1A45DFA3, Segment: 0x18538067,
  SeekHead: 0x114D9B74, Seek: 0x4DBB, SeekID: 0x53AB, SeekPosition: 0x53AC,
  Info: 0x1549A966, Duration: 0x4489, Tracks: 0x1654AE6B,
  Cluster: 0x1F43B675, Timecode: 0xE7, SimpleBlock: 0xA3, BlockGroup: 0xA0, Block: 0xA1,
  Cues: 0x1C53BB6B, CuePoint: 0xBB, CueTime: 0xB3, CueTrackPositions: 0xB7,
  CueTrack: 0xF7, CueClusterPosition: 0xF1, Void: 0xEC,
};
// The Segment's own children: meeting one inside a cluster of unknown size
// means that cluster has ended.
const TOP = new Set([ID.SeekHead, ID.Info, ID.Tracks, ID.Cluster, ID.Cues,
  0x1254C367 /* Tags */, 0x1941A469 /* Attachments */, 0x1043A770 /* Chapters */]);

// --- Reading ---------------------------------------------------------------

// An element's header at `pos`: { id, start, dataStart, end } (end -1 when
// its size is "unknown"), or null if it is cut off or not EBML.
function header(buf, pos) {
  const first = buf[pos];
  if (first === undefined) return null;
  let idLen = 1;
  while (idLen <= 4 && !(first & (0x100 >> idLen))) idLen++;
  if (idLen > 4) return null;
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + buf[pos + i];

  const s = pos + idLen;
  const lead = buf[s];
  if (lead === undefined) return null;
  let len = 1;
  while (len <= 8 && !(lead & (0x100 >> len))) len++;
  if (len > 8 || s + len > buf.length) return null;
  const mask = (0x100 >> len) - 1;
  let size = lead & mask, unknown = size === mask;
  for (let i = 1; i < len; i++) {
    size = size * 256 + buf[s + i];
    if (buf[s + i] !== 0xff) unknown = false;
  }
  const dataStart = s + len;
  return { id, start: pos, dataStart, end: unknown ? -1 : dataStart + size };
}

function readUint(buf, start, end) {
  let v = 0;
  for (let i = start; i < end; i++) v = v * 256 + buf[i];
  return v;
}

// A block's track and its time relative to its cluster.
function readBlock(buf, b) {
  const lead = buf[b.dataStart];
  let len = 1;
  while (len <= 8 && !(lead & (0x100 >> len))) len++;
  if (len > 8 || b.dataStart + len + 2 > b.end) return null;
  const track = readUint(buf, b.dataStart, b.dataStart + len) - (0x100 >> len) * 256 ** (len - 1);
  return { track, rel: buf.readInt16BE(b.dataStart + len) };
}

// A cluster: its time, its blocks' times, and where its content ends. An
// unknown-sized one runs until the next of the Segment's own children; a
// block cut off at the end of the file (a crash while recording) is left out.
function readCluster(buf, h, limit) {
  const stop = h.end < 0 ? limit : Math.min(h.end, limit);
  let pos = h.dataStart, timecode = null;
  const blocks = [];
  while (pos < stop) {
    const c = header(buf, pos);
    if (!c || (h.end < 0 && TOP.has(c.id))) break;
    if (c.end < 0 || c.end > stop) break;
    if (c.id === ID.Timecode) {
      timecode = readUint(buf, c.dataStart, c.end);
    } else if (c.id === ID.SimpleBlock) {
      const b = readBlock(buf, c);
      if (b) blocks.push(b);
    } else if (c.id === ID.BlockGroup) {
      for (let p = c.dataStart; p < c.end;) {
        const g = header(buf, p);
        if (!g || g.end < 0 || g.end > c.end) break;
        if (g.id === ID.Block) { const b = readBlock(buf, g); if (b) blocks.push(b); }
        p = g.end;
      }
    }
    pos = c.end;
  }
  if (timecode === null) return null;
  return { timecode, blocks, dataStart: h.dataStart, end: pos };
}

// --- Writing ---------------------------------------------------------------

function idBytes(id) {
  const n = id > 0xFFFFFF ? 4 : id > 0xFFFF ? 3 : id > 0xFF ? 2 : 1;
  return uint(id, n);
}
function uint(v, n) {
  const b = Buffer.alloc(n);
  for (let i = n - 1; i >= 0; i--) { b[i] = v % 256; v = Math.floor(v / 256); }
  return b;
}
// Sizes are always written in 8 bytes: then an element's size does not
// depend on the numbers inside it, and the positions can be worked out first.
function size8(n) {
  const b = uint(n, 8);
  b[0] = 0x01;
  return b;
}
// The Segment's and the clusters' own sizes in as few bytes as they need:
// nothing is positioned by them, and some readers (the "ebml" npm package)
// misread an 8-byte size of 64 KB or more.
function sizeMin(n) {
  let len = 1;
  while (n >= 2 ** (7 * len) - 1) len++; // all ones would mean "unknown"
  const b = uint(n, len);
  b[0] |= 0x100 >> len;
  return b;
}
function el(id, body) {
  return Buffer.concat([idBytes(id), size8(body.length), body]);
}
function float64(v) {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(v);
  return b;
}

// --- The rewrite -------------------------------------------------------------

function rewrite(buf) {
  const ebml = header(buf, 0);
  if (!ebml || ebml.id !== ID.EBML || ebml.end < 0 || ebml.end > buf.length) return null;
  const seg = header(buf, ebml.end);
  if (!seg || seg.id !== ID.Segment) return null;
  const segEnd = seg.end < 0 || seg.end > buf.length ? buf.length : seg.end;

  let info = null, tracks = null;
  const others = [], clusters = [];
  for (let pos = seg.dataStart; pos < segEnd;) {
    const h = header(buf, pos);
    if (!h) break; // a cut-off tail
    if (h.id === ID.Cluster) {
      const c = readCluster(buf, h, segEnd);
      if (!c) return null;
      if (c.blocks.length) clusters.push(c);
      if (c.end <= pos) break;
      pos = c.end;
      continue;
    }
    if (h.end < 0 || h.end > segEnd) break; // only clusters may be unsized
    if (h.id === ID.Info) info = h;
    else if (h.id === ID.Tracks) tracks = h;
    // An old index or SeekHead is made anew; padding is dropped.
    else if (h.id !== ID.SeekHead && h.id !== ID.Cues && h.id !== ID.Void) others.push(h);
    pos = h.end;
  }
  if (!info || !tracks || !clusters.length) return null;

  // The length: the last block's time plus one frame (the usual step between
  // blocks), in the file's own time units — those of the Duration too.
  const times = [];
  for (const c of clusters) for (const b of c.blocks) times.push(c.timecode + b.rel);
  const last = times[times.length - 1];
  let step = 0;
  for (let i = times.length - 1; i > 0 && !step; i--) step = Math.max(0, times[i] - times[i - 1]);
  const duration = last + step;
  if (!(duration > 0)) return null;
  const track = clusters[0].blocks[0].track;

  // Info as it was, with the length (in place of one already there).
  const infoParts = [];
  for (let p = info.dataStart; p < info.end;) {
    const c = header(buf, p);
    if (!c || c.end < 0 || c.end > info.end) return null;
    if (c.id !== ID.Duration) infoParts.push(buf.subarray(c.start, c.end));
    p = c.end;
  }
  infoParts.push(el(ID.Duration, float64(duration)));
  const infoEl = el(ID.Info, Buffer.concat(infoParts));
  const tracksEl = buf.subarray(tracks.start, tracks.end);
  const otherEls = others.map((o) => buf.subarray(o.start, o.end));

  // Positions are counted from the start of the Segment's content. Every
  // element written here has a fixed size, so they can be laid out at once.
  const seek = (id, at) => el(ID.Seek, Buffer.concat([el(ID.SeekID, idBytes(id)), el(ID.SeekPosition, uint(at, 8))]));
  const cue = (time, at) => el(ID.CuePoint, Buffer.concat([
    el(ID.CueTime, uint(time, 8)),
    el(ID.CueTrackPositions, Buffer.concat([el(ID.CueTrack, uint(track, 8)), el(ID.CueClusterPosition, uint(at, 8))])),
  ]));
  const seekHeadSize = el(ID.SeekHead, Buffer.concat([seek(ID.Info, 0), seek(ID.Tracks, 0), seek(ID.Cues, 0)])).length;
  const cuesSize = el(ID.Cues, Buffer.concat(clusters.map(() => cue(0, 0)))).length;

  const infoAt = seekHeadSize;
  const tracksAt = infoAt + infoEl.length;
  let at = tracksAt + tracksEl.length;
  for (const o of otherEls) at += o.length;
  const cuesAt = at;
  at += cuesSize;
  const clusterEls = [], cuePoints = [];
  for (const c of clusters) {
    const head = Buffer.concat([idBytes(ID.Cluster), sizeMin(c.end - c.dataStart)]);
    cuePoints.push(cue(c.timecode + Math.max(0, c.blocks[0].rel), at));
    clusterEls.push(head, buf.subarray(c.dataStart, c.end));
    at += head.length + (c.end - c.dataStart);
  }
  const seekHead = el(ID.SeekHead, Buffer.concat([
    seek(ID.Info, infoAt), seek(ID.Tracks, tracksAt), seek(ID.Cues, cuesAt)]));
  const cues = el(ID.Cues, Buffer.concat(cuePoints));
  if (seekHead.length !== seekHeadSize || cues.length !== cuesSize) return null;

  return Buffer.concat([
    buf.subarray(0, ebml.end),
    idBytes(ID.Segment), sizeMin(at),
    seekHead, infoEl, tracksEl, ...otherEls, cues, ...clusterEls,
  ]);
}

// bytes: a Buffer or Uint8Array with a WebM recording. Returns the seekable
// file as a Buffer, or null if it could not be read (keep the original then).
function makeSeekable(bytes) {
  try {
    return rewrite(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } catch (e) {
    return null;
  }
}

module.exports = { makeSeekable };
