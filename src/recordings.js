// The user's recordings and saved texts: plain files in a folder of their
// choice (Downloads\Audiator unless set in Settings). They are the user's
// material on their own computer: the program writes them and opens them, and
// never deletes them — not at sign-out, not with "Clear history", not when
// the program is uninstalled (user's decision 2026-10-05). The one exception
// is the file it has just written for a recording in which no speech was found.
//
//   audio_135607_051026.webm        every recording, written when it stops
//   transcribe_135607_051026.txt    a text, by the Save button
// (HHMMSS_DDMMYY, local time of the recording).

const fs = require('fs');
const path = require('path');
const { makeSeekable } = require('./webm-seekable');

// "135607_051026" for 13:56:07 on 5 October 2026.
function stamp(when) {
  let d = new Date(when);
  if (isNaN(d.getTime())) d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  return `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}_` +
         `${two(d.getDate())}${two(d.getMonth() + 1)}${two(d.getFullYear() % 100)}`;
}

// The files written by this run, so a page can only take back what was just
// made for it (a "no speech" recording), never any other file.
const written = new Set();

// A recording, made seekable (webm-seekable.js; as it was if that fails),
// under a name no other file has: audio_135607_051026.webm, then _2, _3...
// Returns the file's full path.
async function saveRecording(folder, bytes, when) {
  await fs.promises.mkdir(folder, { recursive: true });
  const data = makeSeekable(bytes) || Buffer.from(bytes);
  const base = `audio_${stamp(when)}`;
  for (let n = 1; ; n++) {
    const file = path.join(folder, n === 1 ? `${base}.webm` : `${base}_${n}.webm`);
    try {
      await fs.promises.writeFile(file, data, { flag: 'wx' }); // never over another file
      written.add(file);
      return file;
    } catch (e) {
      if (e.code !== 'EEXIST' || n > 999) throw e;
    }
  }
}

// Takes back a recording this run has just written (no speech in it).
async function discardRecording(file) {
  if (!written.has(file)) return false;
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

module.exports = { stamp, saveRecording, discardRecording, saveTexts, openable };
