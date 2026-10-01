// The recordings the user has made and not yet dealt with, oldest first —
// the "barrels" on the floating bar.
//
// A job goes recording -> busy (waiting for, or in, transcription) -> done
// (text ready to paste). Recordings are transcribed one at a time in the order
// they were made, so done jobs always sit at the front, and the one recording
// in progress (there is at most one) is always last.
//
// The front job, once done, is the one on offer: its text is on the clipboard
// and its barrel says "Ctrl+V". Pasting removes it and the next done job takes
// its place, so a run of recordings is pasted back in the order it was spoken.
//
// Pure state, no Electron: the main process drives it and draws the result.

class RecordQueue {
  constructor() {
    this.jobs = [];
    this.nextNumber = 1;
  }

  get isEmpty() { return this.jobs.length === 0; }

  find(id) { return this.jobs.find((j) => j.id === id) || null; }

  // A new recording. Numbering restarts from 1 whenever the queue has emptied.
  start(id) {
    if (this.isEmpty) this.nextNumber = 1;
    const job = { id, number: this.nextNumber++, state: 'recording', text: null };
    this.jobs.push(job);
    return job;
  }

  stop(id) {
    const job = this.find(id);
    if (job && job.state === 'recording') job.state = 'busy';
    return job;
  }

  done(id, text) {
    const job = this.find(id);
    if (!job) return null;
    job.state = 'done';
    job.text = text;
    return job;
  }

  // Nothing to paste (silence, an error): the barrel just goes away.
  remove(id) {
    const i = this.jobs.findIndex((j) => j.id === id);
    if (i >= 0) this.jobs.splice(i, 1);
  }

  // The job whose text is on offer: the front one, once it is done.
  get active() {
    const head = this.jobs[0];
    return head && head.state === 'done' ? head : null;
  }

  // The user pasted the offered text. Returns the job offered next, if any.
  pasted() {
    if (this.active) this.jobs.shift();
    return this.active;
  }

  // The user opened the window, where every transcript is in the history:
  // nothing is left waiting to be pasted. Returns how many were dropped.
  dropDone() {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.state !== 'done');
    return before - this.jobs.length;
  }

  // What the bar shows. Up to `max` barrels as they are; beyond that the first
  // few, a "+N" counter for the hidden middle, and the last one — usually the
  // recording in progress, which must stay in sight.
  view(max = 5) {
    const show = (j) => ({ number: j.number, state: j.state });
    if (this.jobs.length <= max) return this.jobs.map(show);
    const head = this.jobs.slice(0, max - 2).map(show);
    const hidden = this.jobs.length - (max - 1);
    return [...head, { more: hidden }, show(this.jobs[this.jobs.length - 1])];
  }
}

module.exports = { RecordQueue };
