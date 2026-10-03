// Checks the recording queue behind the floating bar's "barrels".
//
//   node scripts/check-queue.js
//
// Walks through the scenarios the user described: record, stop and record
// again while the first is still being transcribed; paste the results back
// with Ctrl+V, Ctrl+V, Ctrl+V in the order they were spoken. Exit 1 on failure.
const assert = require('assert');
const path = require('path');
const { RecordQueue } = require(path.join(__dirname, '..', 'src', 'record-queue.js'));

const states = (q) => q.jobs.map((j) => `${j.number}:${j.state}`).join(' ');
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

check('one recording: record -> busy -> done -> pasted', () => {
  const q = new RecordQueue();
  q.start('a');
  assert.strictEqual(states(q), '1:recording');
  q.stop('a');
  assert.strictEqual(states(q), '1:busy');
  assert.strictEqual(q.active, null, 'nothing to paste while transcribing');
  q.done('a', 'hello');
  assert.strictEqual(q.active.text, 'hello');
  assert.strictEqual(q.pasted(), null);
  assert.ok(q.isEmpty);
});

check('paste while the next recording is still running', () => {
  const q = new RecordQueue();
  q.start('a'); q.stop('a');
  q.start('b');                      // second barrel: recording
  q.done('a', 'first');
  assert.strictEqual(states(q), '1:done 2:recording');
  assert.strictEqual(q.active.text, 'first');
  q.pasted();
  assert.strictEqual(states(q), '2:recording', 'pasted barrel disappears, recording goes on');
});

check('hurried user: three in a row, pasted back in spoken order', () => {
  const q = new RecordQueue();
  q.start('a'); q.stop('a');
  q.start('b'); q.stop('b');
  q.start('c');
  assert.strictEqual(states(q), '1:busy 2:busy 3:recording');
  q.done('a', 'one');
  q.done('b', 'two');
  assert.strictEqual(q.active.text, 'one', 'the earliest is offered first');
  assert.strictEqual(q.pasted().text, 'two', 'then the next one');
  q.stop('c'); q.done('c', 'three');
  assert.strictEqual(q.pasted().text, 'three');
  assert.strictEqual(q.pasted(), null);
  assert.ok(q.isEmpty);
});

check('a later result waits until the earlier one is done', () => {
  const q = new RecordQueue();
  q.start('a'); q.stop('a');
  q.start('b'); q.stop('b');
  q.done('b', 'two');                // should not happen (one at a time), but must not jump the queue
  assert.strictEqual(q.active, null, 'job 1 is still busy, nothing on offer');
  q.done('a', 'one');
  assert.strictEqual(q.active.text, 'one');
});

check('silence or an error removes the barrel and the next one moves up', () => {
  const q = new RecordQueue();
  q.start('a'); q.stop('a');
  q.start('b'); q.stop('b');
  q.remove('a');
  q.done('b', 'two');
  assert.strictEqual(q.active.text, 'two');
});

check('opening the window drops what is ready and renumbers what is still going', () => {
  const q = new RecordQueue();
  q.start('a'); q.stop('a'); q.done('a', 'one');
  q.start('b'); q.stop('b');
  q.start('c');
  assert.strictEqual(q.dropDone(), 1);
  assert.strictEqual(states(q), '1:busy 2:recording', 'leaving the window shows 1, 2 — not 2, 3');
  q.stop('c');
  assert.strictEqual(q.start('d').number, 3, 'and the count carries on from there');
});

check('numbering restarts once the queue is empty', () => {
  const q = new RecordQueue();
  q.start('a'); q.start('b');
  q.remove('a'); q.remove('b');
  assert.strictEqual(q.start('c').number, 1);
});

check('more than five barrels: first three, "+N", and the last one', () => {
  const q = new RecordQueue();
  for (const id of ['a', 'b', 'c', 'd', 'e']) { q.start(id); q.stop(id); }
  assert.strictEqual(q.view().length, 5, 'five fit as they are');
  q.start('f'); q.stop('f'); q.start('g');
  assert.deepStrictEqual(q.view(), [
    { number: 1, state: 'busy' }, { number: 2, state: 'busy' }, { number: 3, state: 'busy' },
    { more: 3 },
    { number: 7, state: 'recording' },
  ]);
});

check('a recording whose stop never came does not hold back the queue', () => {
  const q = new RecordQueue();
  q.start('a');                      // its stop is lost (fast double press)
  q.start('b'); q.stop('b');
  assert.strictEqual(states(q), '1:busy', 'the leftover "recording" is gone');
  q.done('b', 'text');
  assert.strictEqual(q.active.text, 'text', 'and the next transcript is offered');
});

let failed = 0;
for (const [name, fn] of checks) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
console.log(failed ? `\n${failed} of ${checks.length} failed` : `\nall ${checks.length} passed`);
process.exit(failed ? 1 : 0);
