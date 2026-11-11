// Node-only checks for the "why" on each change in Review and the weekly
// Progress line in the success note:
//   node test/review-extras.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';

globalThis.self = globalThis;
new Function(fs.readFileSync(process.env.CONSTANTS || new URL('../constants.js', import.meta.url), 'utf8'))();
for (const f of ['SR_changeReason', 'SR_weeklyLine']) assert.equal(typeof globalThis[f], 'function', `${f} is exported`);

// 1. A reason only when a known rule matches, never a guess.
const why = (a, b) => SR_changeReason(a, b);
assert.match(why('dont', "don't"), /apostrophe stands for the missing letters: do not → don't/);
assert.match(why('dont ', "don't "), /do not → don't/, 'spaces around a change are ignored');
assert.equal(why(' i ', ' I '), '"I" is always a capital.');
assert.match(why('friday', 'Friday'), /Days and months/);
assert.match(why('their', "they're"), /they are/);
assert.match(why('its', "it's"), /it is/);
assert.match(why('then', 'than'), /compares/);
assert.match(why('libary,', 'library,'), /l-i-b-r-a-r-y/, 'punctuation stuck to a word is ignored');
assert.equal(why('affect', 'effect'), null, 'no rule, no reason');
assert.equal(why('teh report are', 'The report is'), null, 'a phrase change gets no single-word reason');
assert.equal(why('.', ','), null, 'punctuation alone has no rule text');
assert.equal(why('', 'added'), null, 'an insertion has nothing to compare');
assert.equal(why('removed', ''), null, 'a deletion has nothing to compare');
assert.equal(why('one two three four', 'one two three five'), null, 'more than three words: no reason');

// 2. The weekly line: a better or steady week, or a first rate; at most once in 7 days.
const DAY = 86400000;
const now = Date.UTC(2026, 10, 12, 12);
const key = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const store = (perDay) => ({ days: Object.fromEntries(perDay.map(([ago, fixes, words]) => [key(now - ago * DAY), { fixes, words, proofreads: 1 }])), pairs: {} });
const view = (perDay) => SR_insightsView(store(perDay), now);

const better = view([[1, 2, 300], [15, 9, 300]]); // this week 1 in 150, two weeks ago 1 in 33
assert.match(SR_weeklyLine(better, 0, now), /^Your writing: \d+% fewer mistakes than 2 weeks ago\.$/);
assert.equal(SR_weeklyLine(better, now - 3 * DAY, now), null, 'shown 3 days ago: not again');
assert.ok(SR_weeklyLine(better, now - 8 * DAY, now), 'shown 8 days ago: due again');

const flat = view([[1, 3, 300], [8, 3, 300]]);
assert.equal(SR_weeklyLine(flat, 0, now), 'Your writing: about the same as last week.');

const worse = view([[1, 9, 300], [8, 2, 300]]);
assert.equal(SR_weeklyLine(worse, 0, now), null, 'a worse week stays in Progress');

const first = view([[1, 3, 300]]);
assert.equal(SR_weeklyLine(first, 0, now), 'Your writing this week: about 1 mistake in every 100 words.');

const light = view([[1, 1, 50]]);
assert.equal(SR_weeklyLine(light, 0, now), null, 'too few words to say anything');
assert.equal(SR_weeklyLine(SR_insightsView(undefined, now), 0, now), null, 'no history: nothing');

console.log('review extras: reasons only from known rules; weekly line once in 7 days, never on a worse week');
