// Recordings not transcribed yet, kept on disk (pending.json in the app's data
// folder) so that nothing is lost when the program is closed, crashes or the
// computer goes off: at the next start they are transcribed and their texts
// go into the history at their own time (user's wish 2026-10-05).
//
// An item: { id, file, when (ISO, the recording's start), seconds, own,
// state }. state is 'recording' while the sound is still being written (a
// crash leaves the file as far as it got), then 'queued'. own: the program
// made the file — only then may it be taken back (a recording with no
// speech); a file the user picked to transcribe is never deleted.
// The queue belongs to the account it was made under: signing out empties it
// (the files stay — they are the user's), and another account never sees it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let dir = null;
let data = { email: null, items: [] };

function file() { return path.join(dir, 'pending.json'); }

function load(userDataDir) {
  dir = userDataDir;
  try {
    const d = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (d && Array.isArray(d.items)) data = { email: d.email || null, items: d.items };
  } catch (e) { /* none yet */ }
}

function save() {
  try {
    if (!data.items.length) { fs.rmSync(file(), { force: true }); return; }
    const tmp = file() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file()); // whole or not at all
  } catch (e) {
    console.error('[pending] could not save:', e.message);
  }
}

// The queue of this account; one left by another account is dropped.
function items(email) {
  if (data.email && email && data.email !== email) { data = { email, items: [] }; save(); }
  return data.items.slice();
}

function add(email, item) {
  if (data.email !== email) data = { email, items: [] };
  const it = { id: crypto.randomUUID(), state: 'queued', seconds: 0, own: true, ...item };
  data.items.push(it);
  save();
  return it;
}

function update(id, patch) {
  const it = data.items.find((x) => x.id === id);
  if (it) { Object.assign(it, patch); save(); }
  return it || null;
}

function remove(id) {
  const n = data.items.length;
  data.items = data.items.filter((x) => x.id !== id);
  if (data.items.length !== n) save();
}

function find(predicate) { return data.items.find(predicate) || null; }

function clear() { data = { email: null, items: [] }; save(); }

module.exports = { load, items, add, update, remove, find, clear };
