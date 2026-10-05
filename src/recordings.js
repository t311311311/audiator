// The user's recordings and saved texts: plain files in a folder of their
// choice (Downloads\Audiator unless set in Settings). They are the user's
// material on their own computer: the program writes them and opens them, and
// never deletes them — not at sign-out, not with "Clear history", not when
// the program is uninstalled (user's decision 2026-10-05). The one exception
// is the file it has just made for a recording in which no speech was found.
//
//   audio_135607_051026.webm        every recording, written while it is made
//   transcribe_135607_051026.txt    a text, by the Save button
// (HHMMSS_DDMMYY, local time the recording started).

const fs = require('fs');
const path = require('path');
const { rewriteSeekable } = require('./webm-seekable');

// "135607_051026" for 13:56:07 on 5 October 2026.
function stamp(when) {
  let d = new Date(when);
  if (isNaN(d.getTime())) d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  return `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}_` +
         `${two(d.getDate())}${two(d.getMonth() + 1)}${two(d.getFullYear() % 100)}`;
}

// The files this run made, so a page can only take back what was made for
// it (a "no speech" recording), never any other file.
const written = new Set();
// Writes to each recording, one after another in the order they came.
const chains = new Map();

// A recording begins: its file, under a name no other file has
// (audio_135607_051026.webm, then _2, _3...), created empty; the sound is
// added to it as it is recorded (appendChunk), so a crash or a closed
// program keeps what was recorded until then. Returns the file's full path.
async function beginRecording(folder, when) {
  await fs.promises.mkdir(folder, { recursive: true });
  const base = `audio_${stamp(when)}`;
  for (let n = 1; ; n++) {
    const file = path.join(folder, n === 1 ? `${base}.webm` : `${base}_${n}.webm`);
    try {
      await fs.promises.writeFile(file, Buffer.alloc(0), { flag: 'wx' }); // never over another file
      written.add(file);
      chains.set(file, Promise.resolve());
      return file;
    } catch (e) {
      if (e.code !== 'EEXIST' || n > 999) throw e;
    }
  }
}

function appendChunk(file, bytes) {
  const prev = chains.get(file);
  if (!prev) return Promise.resolve(false); // not one being recorded
  const next = prev.then(() => fs.promises.appendFile(file, Buffer.from(bytes)))
    .catch((e) => console.error('[recordings] could not add to', path.basename(file), e.message));
  chains.set(file, next);
  return next;
}

// The file made seekable (webm-seekable.js), written whole or not at all;
// as it was if it cannot be read. Returns its length in seconds (0 if unknown).
async function repairRecording(file) {
  const r = rewriteSeekable(await fs.promises.readFile(file));
  if (!r) return 0;
  const tmp = file + '.tmp';
  await fs.promises.writeFile(tmp, r.data);
  await fs.promises.rename(tmp, file);
  return r.seconds;
}

// A file this run began and has not finished yet.
function isRecording(file) { return chains.has(file); }

// The recording is over: the last of its sound is in, then it is made seekable.
async function finishRecording(file) {
  await (chains.get(file) || Promise.resolve());
  chains.delete(file);
  return repairRecording(file);
}

// Takes back a recording made for this account that had no speech in it:
// one this run made, or (allowed) one left in the queue by an earlier run.
async function discardRecording(file, allowed = false) {
  if (!written.has(file) && !allowed) return false;
  written.delete(file);
  await fs.promises.rm(file, { force: true });
  return true;
}

// Texts, one file each. The name follows the recording's own file when
// there is one (audio_135607_051026_2.webm -> transcribe_135607_051026_2.txt),
// else its time. Saving the same text again writes the same file anew (with
// a translation added since, say). Returns the files' full paths.
async function saveTexts(folder, items) {
  await fs.promises.mkdir(folder, { recursive: true });
  const files = [];
  for (const { text, when, audio } of items) {
    const fromAudio = audio && /^audio_(.+)\.webm$/i.exec(path.basename(audio));
    const file = path.join(folder, `transcribe_${fromAudio ? fromAudio[1] : stamp(when)}.txt`);
    await fs.promises.writeFile(file, String(text), 'utf8');
    files.push(file);
  }
  return files;
}

// What the play button and Settings' "Open" may open: a recording, a saved
// text or a folder — never a program that happens to sit at a stored path.
function openable(p) {
  try {
    const st = fs.statSync(p);
    return st.isDirectory() || (st.isFile() && /\.(webm|txt)$/i.test(p));
  } catch (e) {
    return false;
  }
}

module.exports = { stamp, beginRecording, appendChunk, isRecording, finishRecording, repairRecording, discardRecording, saveTexts, openable };
