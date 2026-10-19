// Node-only checks for "Your writing" (corrected word pairs and counts, never sentences):
//   node test/insights.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';

globalThis.self = globalThis;
new Function(fs.readFileSync(process.env.CONSTANTS || new URL('../constants.js', import.meta.url), 'utf8'))();
for (const f of ['SR_practiceHas', 'SR_extractCorrections', 'SR_classifyCorrection', 'SR_mergeInsights', 'SR_insightsView', 'SR_buildTipsPrompt']) {
  assert.equal(typeof globalThis[f], 'function', `${f} is exported`);
}
const DAY = 86400000;
const NOW = new Date(2026, 9, 19, 12).getTime(); // local noon, so day keys don't depend on the time zone

// Extraction on a real Proofread (the store screenshot's text and reply).
const before = 'hi team, wanted to give a fast update. the launch is basically on track but we hit a small snag with the payment thing, its being looked at rn and should be fixed by eod. will keep u posted.';
const after = "Hi team, wanted to give a fast update. The launch is basically on track, but we hit a small snag with the payment thing. It's being looked at right now and should be fixed by EOD. Will keep you posted.";
assert.deepEqual(SR_extractCorrections(before, after), [
  { from: 'hi', to: 'Hi' }, { from: 'the', to: 'The' }, { from: '', to: ',' }, { from: ',', to: '.' },
  { from: 'rn', to: 'right now' }, { from: 'will', to: 'Will' }, { from: 'u', to: 'you' },
]);
// Changed punctuation at the end is its own pair, not glued to the word.
assert.deepEqual(SR_extractCorrections('we was hoping to recieve it by friday', 'We were hoping to receive it by Friday.'), [
  { from: 'we', to: 'We' }, { from: 'was', to: 'were' }, { from: 'recieve', to: 'receive' }, { from: 'friday', to: 'Friday' }, { from: '', to: '.' },
]);
assert.deepEqual(SR_extractCorrections('see you friday, ok', 'see you Friday; ok'), [{ from: 'friday', to: 'Friday' }, { from: ',', to: ';' }]);
// Two changes a space apart stay two pairs; a dropped/added word joins its neighbour.
assert.deepEqual(SR_extractCorrections('we was late', 'We were late'), [{ from: 'we', to: 'We' }, { from: 'was', to: 'were' }]);
assert.deepEqual(SR_extractCorrections('see u rn ok', 'see you right now ok'), [{ from: 'u', to: 'you' }, { from: 'rn', to: 'right now' }]);

// Privacy filters: each drops what it should.
const pairs = (a, b) => SR_extractCorrections(a, b).map((p) => `${p.from}→${p.to}`);
assert.deepEqual(pairs('Please ask Jennife about it.', 'Please ask Jennifer about it.'), [], 'a name mid-sentence');
assert.deepEqual(pairs('Please ask john about it.', 'Please ask John about it.'), [], 'a case fix that makes a name');
assert.deepEqual(pairs('Jhon said hi.', 'John said hi.'), [], 'a name at a sentence start');
assert.deepEqual(pairs('see you on friday.', 'see you on Friday.'), ['friday→Friday'], 'a weekday is not a name');
assert.deepEqual(pairs('i think so.', 'I think so.'), ['i→I'], '"I" is not a name');
assert.deepEqual(pairs('meet at 3pm today.', 'meet at 4pm today.'), [], 'a number');
assert.deepEqual(pairs('the code is 12 34 ok', 'the code is 12 35 ok'), [], 'digits on one side');
assert.deepEqual(pairs('mail jonh.smith@gmial.com now', 'mail john.smith@gmail.com now'), [], 'an email address');
assert.deepEqual(pairs('go to exampel.com now', 'go to example.com now'), [], 'a domain');
assert.deepEqual(pairs('please send it asap thx', 'please send it as soon as you can'), [], 'a phrase longer than 3 tokens');
assert.deepEqual(pairs('it is good', 'it is very good'), [], 'a word added is not a correction');
assert.deepEqual(pairs('a supercalifragilisticexpialidociousnessly long', 'a supercalifragilisticexpialidociousnesslyy long'), [], 'a side over 40 characters');
assert.deepEqual(pairs('teh\nend', 'the end'), [], 'a change across a line break');

// Classification, one per kind.
const kind = (from, to) => SR_classifyCorrection({ from, to });
assert.equal(kind('dont', "don't"), 'apostrophe');
assert.equal(kind('its', "it's"), 'apostrophe');
assert.equal(kind('friday', 'Friday'), 'capitalization');
assert.equal(kind('friday', 'Friday,'), 'capitalization');
assert.equal(kind('recieve', 'receive'), 'spelling');
assert.equal(kind('definately', 'definitely'), 'spelling');
assert.equal(kind('was', 'were'), 'grammar');
assert.equal(kind('then', 'than'), 'grammar', 'a grammar pair wins over a one-letter spelling edit');
assert.equal(kind('your', "you're"), 'grammar');
assert.equal(kind('a', 'an'), 'grammar');
assert.equal(kind(',', '.'), 'punctuation');
assert.equal(kind('', ','), 'punctuation');
assert.equal(kind('rn', 'right now'), 'other');

// Merge: counts, first/last, days, and it doesn't touch the input.
const s0 = { v: 1, pairs: { 'teh→the': { n: 1, first: NOW - 3 * DAY, last: NOW - 3 * DAY, kind: 'spelling' } }, days: {} };
const frozen = JSON.stringify(s0);
const s1 = SR_mergeInsights(s0, [{ from: 'teh', to: 'the' }, { from: 'was', to: 'were' }], NOW, 40, 3);
assert.equal(JSON.stringify(s0), frozen, 'input not mutated');
assert.deepEqual(s1.pairs['teh→the'], { n: 2, first: NOW - 3 * DAY, last: NOW, kind: 'spelling' });
assert.deepEqual(s1.pairs['was→were'], { n: 1, first: NOW, last: NOW, kind: 'grammar' });
assert.deepEqual(s1.days, { [SR_dayKey(NOW)]: { fixes: 3, words: 40, proofreads: 1 } }, 'fixes counts every change, not only the kept pairs');
const s2 = SR_mergeInsights(s1, [{ from: 'u', to: 'you' }], NOW + 1000, 10, 1);
assert.deepEqual(s2.days[SR_dayKey(NOW)], { fixes: 4, words: 50, proofreads: 2 }, 'same day adds up');
// Day rollover: tomorrow is a new key, and days older than 120 are dropped.
const s3 = SR_mergeInsights({ v: 1, pairs: {}, days: { [SR_dayKey(NOW)]: { fixes: 1, words: 9 }, [SR_dayKey(NOW + DAY - 119 * DAY)]: { fixes: 1, words: 9 }, [SR_dayKey(NOW + DAY - 120 * DAY)]: { fixes: 1, words: 9 } } }, [], NOW + DAY, 20, 0);
assert.deepEqual(Object.keys(s3.days).sort(), [SR_dayKey(NOW + DAY - 119 * DAY), SR_dayKey(NOW), SR_dayKey(NOW + DAY)].sort(), 'tomorrow is a new day; day 120 back is dropped');
assert.deepEqual(s3.days[SR_dayKey(NOW + DAY)], { fixes: 0, words: 20, proofreads: 1 });
// The 300 cap: one-off pairs go first, oldest first; a repeat pair survives though older.
let big = { v: 1, pairs: { 'old→repeat': { n: 3, first: NOW - 50 * DAY, last: NOW - 40 * DAY, kind: 'other' } }, days: {} };
for (let i = 0; i < 305; i++) big = SR_mergeInsights(big, [{ from: `w${i}`, to: `v${i}` }], NOW + i, 1, 1); // merge doesn't filter
assert.equal(Object.keys(big.pairs).length, 300);
assert.ok(big.pairs['old→repeat'], 'a repeat pair is kept over newer one-off pairs');
assert.ok(!Object.values(big.pairs).some((p) => p.last === NOW), 'the oldest one-off pairs went first');

// A garbage store (older build, hand edit, corrupted storage) still merges into a valid one.
for (const junk of [null, undefined, 'abc', 42, [], { pairs: ['teh→the'], days: 'x' }, { pairs: { 'a→b': { n: NaN, last: 'x' }, nokey: { n: 3 }, 'c→d': null }, days: { bad: { fixes: 1 }, [SR_dayKey(NOW)]: { fixes: -5, words: NaN } } }]) {
  const out = SR_mergeInsights(junk, [{ from: 'teh', to: 'the' }, null, { from: 3 }], NOW, NaN, 'x');
  assert.deepEqual(out.pairs, { 'teh→the': { n: 1, first: NOW, last: NOW, kind: 'spelling' } }, `junk: ${JSON.stringify(junk)}`);
  assert.equal(out.v, 1);
  for (const [day, d] of Object.entries(out.days)) {
    assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Object.values(d).every((x) => Number.isFinite(x) && x >= 0), `days are clean counts: ${JSON.stringify(out.days)}`);
  }
  assert.doesNotThrow(() => SR_insightsView(junk, NOW));
}
const kept = SR_mergeInsights({ pairs: { 'x→y': { n: 2.7, first: 0, last: NOW - DAY, kind: 7 } } }, [], NOW, 0, 0);
assert.deepEqual(kept.pairs['x→y'], { n: 2, first: NOW - DAY, last: NOW - DAY, kind: 'other' }, 'a fixable entry is repaired, not dropped');

// View: per-100 math, the trend, mastered and working, and the empty store.
const day = (n) => SR_dayKey(NOW - n * DAY);
const view = SR_insightsView({
  v: 1,
  days: { [day(0)]: { fixes: 3, words: 150 }, [day(6)]: { fixes: 1, words: 250 }, [day(7)]: { fixes: 10, words: 200 }, [day(13)]: { fixes: 2, words: 100 }, [day(20)]: { fixes: 1, words: 600 } },
  pairs: {
    'teh→the': { n: 4, first: NOW - 40 * DAY, last: NOW - 20 * DAY, kind: 'spelling' }, // twice+, 20 days clean, 1,000 words since
    'was→were': { n: 3, first: NOW - 30 * DAY, last: NOW - 10 * DAY, kind: 'grammar' }, // only 10 days clean
    'its→it\'s': { n: 1, first: NOW - 30 * DAY, last: NOW - 30 * DAY, kind: 'apostrophe' }, // seen once
    'u→you': { n: 2, first: NOW - 5 * DAY, last: NOW - DAY, kind: 'other' },
  },
}, NOW);
assert.deepEqual(view.week, { fixes: 4, words: 400, per100: 1 });
assert.deepEqual(view.prevWeek, { fixes: 12, words: 300, per100: 4 });
assert.equal(view.trend, -3, 'fewer fixes per 100 words is the improvement');
assert.deepEqual(view.mastered, [{ from: 'teh', to: 'the', n: 4, daysClean: 20 }]);
assert.deepEqual(view.working, [{ from: 'was', to: 'were', n: 3, kind: 'grammar' }, { from: 'u', to: 'you', n: 2, kind: 'other' }]);
assert.deepEqual(view.kinds, { spelling: 4, grammar: 3, apostrophe: 1, other: 2 });
// "Mastered" needs proofreading in between, not just time away.
const idle = SR_insightsView({ v: 1, days: {}, pairs: { 'teh→the': { n: 4, first: NOW - 40 * DAY, last: NOW - 20 * DAY, kind: 'spelling' } } }, NOW);
assert.deepEqual(idle.mastered, [], 'no words proofread since: not mastered');
// Too few words for a trend.
assert.equal(SR_insightsView({ v: 1, pairs: {}, days: { [day(0)]: { fixes: 1, words: 50 }, [day(8)]: { fixes: 1, words: 500 } } }, NOW).trend, null);
assert.deepEqual(SR_insightsView(undefined, NOW), {
  week: { fixes: 0, words: 0, per100: null }, prevWeek: { fixes: 0, words: 0, per100: null }, trend: null,
  weeks: Array(8).fill({ fixes: 0, words: 0, per100: null }), total: { proofreads: 0, words: 0 }, mastered: [], working: [], kinds: {},
});

// weeks (oldest first) and totals for the chart and "Based on N proofreads".
assert.equal(view.weeks.length, 8);
assert.deepEqual(view.weeks[7], view.week);
assert.deepEqual(view.weeks[6], view.prevWeek);
const counted = SR_mergeInsights(SR_mergeInsights(undefined, [], NOW, 30, 1), [], NOW, 20, 0);
assert.deepEqual(counted.days[SR_dayKey(NOW)], { fixes: 1, words: 50, proofreads: 2 });
assert.deepEqual(SR_insightsView(counted, NOW).total, { proofreads: 2, words: 50 });

// Rules: one plain line for the common cases, null rather than something generic.
const rule = (from, to, k) => SR_ruleFor({ from, to, kind: k });
assert.equal(rule('dont', "don't", 'apostrophe'), "The apostrophe stands for the missing letters: do not → don't.");
assert.equal(rule('im', "I'm", 'other'), "The apostrophe stands for the missing letters: I am → I'm.");
assert.equal(rule('its', "it's", 'apostrophe'), 'it\'s = it is. "its" shows ownership.');
assert.equal(rule("it's", 'its', 'apostrophe'), "its shows ownership. it's = it is.");
assert.equal(rule('their', "they're", 'grammar'), "they're = they are.");
assert.equal(rule('there', 'their', 'grammar'), 'their = belonging to them.');
assert.equal(rule('your', "you're", 'grammar'), "you're = you are.");
assert.equal(rule('then', 'than', 'grammar'), 'than compares (bigger than). then is about time.');
assert.equal(rule('a', 'an', 'grammar'), 'Use "an" before a vowel sound: an hour, an idea.');
assert.equal(rule('friday', 'Friday', 'capitalization'), 'Days and months start with a capital: Friday, March.');
assert.equal(rule('i', 'I', 'capitalization'), '"I" is always a capital.');
assert.equal(rule('the', 'The', 'capitalization'), 'A sentence starts with a capital letter.');
assert.equal(rule('recieve', 'receive', 'spelling'), 'Spelled r-e-c-e-i-v-e.');
assert.equal(rule('rn', 'right now', 'other'), null);
assert.equal(rule('', ',', 'punctuation'), null);
assert.equal(rule('is', 'are', 'grammar'), null, 'no rule beats a vague one');

// Practice: local sentences from the user's own working pairs.
const working = [
  { from: 'dont', to: "don't", n: 8, kind: 'apostrophe' }, { from: 'its', to: "it's", n: 5, kind: 'apostrophe' },
  { from: 'their', to: "they're", n: 3, kind: 'grammar' }, { from: 'recieve', to: 'receive', n: 2, kind: 'spelling' },
  { from: 'friday', to: 'Friday', n: 2, kind: 'capitalization' },
  { from: 'the', to: 'The', n: 2, kind: 'capitalization' }, { from: '', to: ',', n: 2, kind: 'punctuation' },
];
const items = SR_buildPractice({ working }, 6);
assert.equal(items.length, 6);
assert.deepEqual(items, SR_buildPractice({ working }, 6), 'deterministic');
assert.notDeepEqual(items, SR_buildPractice({ working }, 6, 1), 'the seed changes them');
assert.deepEqual(items[0], {
  prompt: 'Quick update: I dont think the old version works.',
  answer: "Quick update: I don't think the old version works.",
  targets: [{ from: 'dont', to: "don't", kind: 'apostrophe' }],
});
for (const it of items) {
  assert.ok(it.targets.length >= 1 && it.targets.length <= 3, '1 to 3 mistakes a sentence');
  assert.ok(!it.targets.some((t) => t.from === 'the' || t.to === ','), 'no sentence-start capitals or punctuation');
  assert.deepEqual(SR_checkPractice(it, it.prompt).right, [], `unchanged prompt has nothing right: ${it.prompt}`);
  assert.deepEqual(SR_checkPractice(it, it.answer), { right: it.targets.map((t) => t.to), missed: [] }, `answer is all right: ${it.answer}`);
}
// The filler never holds a target's fix, which would give the answer away.
const leaky = [
  { from: 'tomorow', to: 'tomorrow', n: 4, kind: 'spelling' }, { from: 'teh', to: 'the', n: 3, kind: 'spelling' },
  { from: 'dont', to: "don't", n: 2, kind: 'apostrophe' }, { from: 'emial', to: 'email', n: 2, kind: 'spelling' },
  { from: 'agian', to: 'again', n: 2, kind: 'spelling' }, { from: 'no', to: 'know', n: 2, kind: 'other' },
];
for (const seed of [0, 1, 2, 3]) {
  const built = SR_buildPractice({ working: leaky }, 5, seed);
  assert.ok(built.length > 0, 'still builds something');
  for (const it of built) {
    for (const t of it.targets) assert.ok(!SR_practiceHas(it.prompt, t.to, false), `"${it.prompt}" already contains "${t.to}"`);
    assert.deepEqual(SR_checkPractice(it, it.prompt).right, []);
    assert.deepEqual(SR_checkPractice(it, it.answer).missed, [], `answer passes: ${it.answer}`);
  }
}
// Only a target no wording can hold is dropped: "tomorow" survives a "For tomorrow:" opener by switching openers.
assert.deepEqual(SR_buildPractice({ working: leaky.slice(0, 3) }, 3)[2].targets.map((t) => t.to), ["don't", 'tomorrow']);
for (const v of [undefined, null, {}, { working: [] }, { working: 'x' }, { working: [null, 5, { from: 1, to: 2 }] }]) {
  assert.deepEqual(SR_buildPractice(v), [], `empty or junk view: ${JSON.stringify(v)}`);
}
for (const it of [undefined, null, {}, { targets: 'x' }, { targets: [null, { from: 3 }] }]) {
  assert.deepEqual(SR_checkPractice(it, undefined), { right: [], missed: [] }, `empty or junk item: ${JSON.stringify(it)}`);
}
// Checking: the right form must appear AND the wrong one be gone; case only matters for capitals.
const item = { targets: [{ from: 'its', to: "it's", kind: 'apostrophe' }, { from: 'their', to: "they're", kind: 'grammar' }, { from: 'friday', to: 'Friday', kind: 'capitalization' }] };
assert.deepEqual(SR_checkPractice(item, "It’s fine, their sending it on Friday."), {
  right: ["it's", 'Friday'], missed: [{ from: 'their', to: "they're", rule: "they're = they are." }],
});
assert.deepEqual(SR_checkPractice(item, "it's its, they're, friday").right, ["they're"], 'wrong form still there; lowercase day');

// The tips prompt carries the pairs and counts and nothing else.
{
  // Only the pairs and kind counts are sent (injection defenses are in test/injection.mjs).
  const { user } = SR_buildTipsPrompt([{ from: 'teh', to: 'the', n: 4 }, { from: 'was', to: 'were', n: 3 }], { spelling: 4, grammar: 3, other: 0 }, 'text-000000000000');
  assert.ok(user.startsWith('<text-000000000000>\nCorrections:\n- "teh" → "the" (4x)\n- "was" → "were" (3x)\n\nBy kind: spelling 4, grammar 3\n</text-000000000000>'));
}

console.log('insights: all checks passed');
