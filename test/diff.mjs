// Node-only checks for the Proofread word diff:
//   node test/diff.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';

globalThis.self = globalThis;
new Function(fs.readFileSync(process.env.CONSTANTS || new URL('../constants.js', import.meta.url), 'utf8'))();
assert.equal(typeof SR_wordDiff, 'function', 'SR_wordDiff is exported');

const join = (ops, keep) => ops.filter((o) => o.type === 'same' || o.type === keep).map((o) => o.text).join('');
const roundTrip = (before, after) => {
  const ops = SR_wordDiff(before, after);
  assert.ok(ops, `diffed: ${before}`);
  assert.equal(join(ops, 'ins'), after);
  assert.equal(join(ops, 'del'), before);
  // No empty ops, no two neighbours of the same type.
  ops.forEach((o, k) => { assert.ok(o.text, 'empty op'); if (k) assert.notEqual(o.type, ops[k - 1].type); });
  return ops;
};

// A typical proofread: three separate fixes.
const ops = roundTrip('teh report are ready , i will send it tomorow.', 'The report is ready, I will send it tomorrow.');
assert.equal(SR_diffCount(ops), 5); // teh→The, are→is, " ,"→",", i→I, tomorow→tomorrow
assert.deepEqual(ops.slice(0, 2), [{ type: 'del', text: 'teh' }, { type: 'ins', text: 'The' }]);

// Punctuation-only change marks only the mark.
const p = roundTrip('Thanks for the update.', 'Thanks for the update!');
assert.deepEqual(p.filter((o) => o.type !== 'same'), [{ type: 'del', text: '.' }, { type: 'ins', text: '!' }]);
assert.equal(SR_diffCount(p), 1);

// Unicode letters, accents, apostrophes, emoji, newlines.
roundTrip("Je n’ai pas reçu ton courriel 😅\nMerci", "Je n’ai pas reçu ton courriel. 😅\n\nMerci beaucoup");
roundTrip('東京は 晴れ です', '東京は 雨 です');
assert.equal(SR_diffCount(SR_wordDiff("it's done", "it's done")), 0);

// Edge cases: empty sides, identical text, everything changed.
assert.deepEqual(SR_wordDiff('', ''), []);
roundTrip('', 'New text.');
roundTrip('Old text.', '');
assert.equal(SR_diffCount(roundTrip('alpha beta', 'gamma delta')), 2); // the shared space splits it
assert.equal(SR_diffCount(null), 0);

// Huge input: null (caller shows plain text), unless only a small middle changed.
const words = (n, w) => Array.from({ length: n }, (_, k) => `${w}${k}`).join(' ');
assert.equal(SR_wordDiff(words(2000, 'a'), words(2000, 'b')), null);
const long = words(3000, 'w');
assert.equal(SR_diffCount(roundTrip(long, long.replace('w1500', 'W1500'))), 1);


// Per-change revert: rejected groups keep the original wording, the rest keep the fix.
{
  const before = 'teh report are ready , i will send it tomorow.';
  const after = 'The report is ready, I will send it tomorrow.';
  const o = SR_wordDiff(before, after);
  const groups = SR_diffGroups(o);
  assert.equal(Math.max(...groups) + 1, SR_diffCount(o), 'groups match the change count');
  assert.equal(SR_applyDiff(o), after, 'nothing rejected → the result');
  assert.equal(SR_applyDiff(o, new Set([0, 1, 2, 3, 4])), before, 'everything rejected → the original');
  assert.equal(SR_applyDiff(o, new Set([1])), 'The report are ready, I will send it tomorrow.');
  assert.equal(SR_applyDiff(o, new Set([0, 4])), 'teh report is ready, I will send it tomorow.');
  // A pure insertion and a pure deletion revert cleanly too.
  const ins = SR_wordDiff('Send it now', 'Send it now, please');
  assert.equal(SR_applyDiff(ins, new Set([0])), 'Send it now');
  const del = SR_wordDiff('Send it it now', 'Send it now');
  assert.equal(SR_applyDiff(del, new Set([0])), 'Send it it now');
  assert.equal(SR_applyDiff(null), '');
}
console.log('diff: all checks passed');
