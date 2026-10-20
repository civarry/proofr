// Node-only checks for "Your writing" (corrected word pairs and counts, never sentences):
//   node test/insights.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';

globalThis.self = globalThis;
new Function(fs.readFileSync(process.env.CONSTANTS || new URL('../constants.js', import.meta.url), 'utf8'))();
for (const f of ['SR_practiceHas', 'SR_extractCorrections', 'SR_classifyCorrection', 'SR_mergeInsights', 'SR_insightsView', 'SR_buildTipsPrompt', 'SR_progressHero', 'SR_wordRows', 'SR_masteredLine', 'SR_tipsState']) {
  assert.equal(typeof globalThis[f], 'function', `${f} is exported`);
}
const DAY = 86400000;
const NOW = new Date(2026, 9, 19, 12).getTime(); // local noon, so day keys don't depend on the time zone

// Extraction on a real Proofread (the store screenshot's text and reply).
const before = 'hi team, wanted to give a fast update. the launch is basically on track but we hit a small snag with the payment thing, its being looked at rn and should be fixed by eod. will keep u posted.';
const after = "Hi team, wanted to give a fast update. The launch is basically on track, but we hit a small snag with the payment thing. It's being looked at right now and should be fixed by EOD. Will keep you posted.";
assert.deepEqual(SR_extractCorrections(before, after), [
  { from: 'hi', to: 'Hi' }, { from: 'the', to: 'The' }, { from: '', to: ',' }, { from: ',', to: '.' }, { from: 'its', to: "It's" },
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
assert.deepEqual(pairs("their late. ok", "They're late. ok"), ["their→They're"], 'a capitalized contraction is not a name');
assert.deepEqual(pairs('youre right.', "You're right."), ["youre→You're"]);
assert.deepEqual(pairs("ok. were late", "ok. We're late"), ["were→We're"]);
assert.equal(SR_buildPractice({ working: [{ from: "we're", to: "We're", n: 3, kind: 'capitalization' }] }).length, 0, 'a sentence-start capital is not practiced mid-sentence');
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
assert.deepEqual(s1.pairs['teh→the'], { n: 2, first: NOW - 3 * DAY, last: NOW, kind: 'spelling', h: 'm', streak: 0, g: 0 });
assert.deepEqual(s1.pairs['was→were'], { n: 1, first: NOW, last: NOW, kind: 'grammar', h: 'm', streak: 0, g: 0 });
assert.deepEqual(s1.days, { [SR_dayKey(NOW)]: { fixes: 3, words: 40, proofreads: 1, k: { spelling: 1, grammar: 1 } } }, 'fixes counts every change, not only the kept pairs');
const s2 = SR_mergeInsights(s1, [{ from: 'u', to: 'you' }], NOW + 1000, 10, 1);
assert.deepEqual(s2.days[SR_dayKey(NOW)], { fixes: 4, words: 50, proofreads: 2, k: { spelling: 2, grammar: 1 } }, 'same day adds up');
// Day rollover: tomorrow is a new key, and days older than 120 are dropped.
const s3 = SR_mergeInsights({ v: 1, pairs: {}, days: { [SR_dayKey(NOW)]: { fixes: 1, words: 9 }, [SR_dayKey(NOW + DAY - 119 * DAY)]: { fixes: 1, words: 9 }, [SR_dayKey(NOW + DAY - 120 * DAY)]: { fixes: 1, words: 9 } } }, [], NOW + DAY, 20, 0);
assert.deepEqual(Object.keys(s3.days).sort(), [SR_dayKey(NOW + DAY - 119 * DAY), SR_dayKey(NOW), SR_dayKey(NOW + DAY)].sort(), 'tomorrow is a new day; day 120 back is dropped');
assert.deepEqual(s3.days[SR_dayKey(NOW + DAY)], { fixes: 0, words: 20, proofreads: 1, k: {} });
// The 300 cap: one-off pairs go first, oldest first; a repeat pair survives though older.
let big = { v: 1, pairs: { 'old→repeat': { n: 3, first: NOW - 50 * DAY, last: NOW - 40 * DAY, kind: 'other' } }, days: {} };
for (let i = 0; i < 305; i++) big = SR_mergeInsights(big, [{ from: `w${i}`, to: `v${i}` }], NOW + i, 1, 1); // merge doesn't filter
assert.equal(Object.keys(big.pairs).length, 300);
assert.ok(big.pairs['old→repeat'], 'a repeat pair is kept over newer one-off pairs');
assert.ok(!Object.values(big.pairs).some((p) => p.last === NOW), 'the oldest one-off pairs went first');

// A garbage store (older build, hand edit, corrupted storage) still merges into a valid one.
for (const junk of [null, undefined, 'abc', 42, [], { pairs: ['teh→the'], days: 'x' }, { pairs: { 'a→b': { n: NaN, last: 'x' }, nokey: { n: 3 }, 'c→d': null }, days: { bad: { fixes: 1 }, [SR_dayKey(NOW)]: { fixes: -5, words: NaN } } }]) {
  const out = SR_mergeInsights(junk, [{ from: 'teh', to: 'the' }, null, { from: 3 }], NOW, NaN, 'x');
  assert.deepEqual(out.pairs, { 'teh→the': { n: 1, first: NOW, last: NOW, kind: 'spelling', h: 'm', streak: 0, g: 0 } }, `junk: ${JSON.stringify(junk)}`);
  assert.equal(out.v, 1);
  for (const [day, d] of Object.entries(out.days)) {
    assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok([d.fixes, d.words, d.proofreads, ...Object.values(d.k)].every((x) => Number.isFinite(x) && x >= 0), `days are clean counts: ${JSON.stringify(out.days)}`);
  }
  assert.doesNotThrow(() => SR_insightsView(junk, NOW));
}
const kept = SR_mergeInsights({ pairs: { 'x→y': { n: 2.7, first: 0, last: NOW - DAY, kind: 7 } } }, [], NOW, 0, 0);
assert.deepEqual(kept.pairs['x→y'], { n: 2, first: NOW - DAY, last: NOW - DAY, kind: 'other', h: '', streak: 0, g: 0 }, 'a fixable entry is repaired, not dropped');

// View: per-100 math, the trend, mastered and working, and the empty store.
const day = (n) => SR_dayKey(NOW - n * DAY);
const view = SR_insightsView({
  v: 1,
  days: { [day(0)]: { fixes: 3, words: 150 }, [day(6)]: { fixes: 1, words: 250 }, [day(7)]: { fixes: 10, words: 200 }, [day(13)]: { fixes: 2, words: 100 }, [day(20)]: { fixes: 1, words: 600 } },
  pairs: {
    'teh→the': { n: 4, first: NOW - 40 * DAY, last: NOW - 20 * DAY, kind: 'spelling', h: 'mmggg', streak: 3 }, // right 3 times, 20 days since
    'was→were': { n: 3, first: NOW - 30 * DAY, last: NOW - 10 * DAY, kind: 'grammar', h: 'mmmgg', streak: 2 }, // one short, 10 days back
    'its→it\'s': { n: 1, first: NOW - 30 * DAY, last: NOW - 30 * DAY, kind: 'apostrophe' }, // seen once
    'u→you': { n: 2, first: NOW - 5 * DAY, last: NOW - DAY, kind: 'other' },
  },
}, NOW);
assert.deepEqual(view.week, { fixes: 4, words: 400, per100: 1 });
assert.deepEqual(view.prevWeek, { fixes: 12, words: 300, per100: 4 });
assert.equal(view.trend, -3, 'fewer fixes per 100 words is the improvement');
assert.deepEqual(view.mastered, [{ from: 'teh', to: 'the', n: 4, kind: 'spelling', streak: 3 }]);
assert.deepEqual(view.working, [{ from: 'was', to: 'were', n: 3, kind: 'grammar', h: 'mmmgg', streak: 2, last: NOW - 10 * DAY }, { from: 'u', to: 'you', n: 2, kind: 'other', h: '', streak: 0, last: NOW - DAY }]);
assert.deepEqual(view.kinds, { spelling: 4, grammar: 3, apostrophe: 1, other: 2 });
// A recent pair fixed once may be the model's mistake: it's never in working.
{
  const once = SR_insightsView({ v: 1, days: {}, pairs: {
    'than→then': { n: 1, first: NOW - DAY, last: NOW - DAY, kind: 'grammar' },
    'dont→don\'t': { n: 2, first: NOW - 2 * DAY, last: NOW - DAY, kind: 'apostrophe' },
  } }, NOW);
  assert.deepEqual(once.working.map((p) => p.from), ['dont'], 'a one-off fix is not taught');
}
// "Mastered" is earned by right uses, not time away; an old fix with no streak leaves working.
const idle = SR_insightsView({ v: 1, days: { [day(1)]: { fixes: 0, words: 5000 } }, pairs: { 'teh→the': { n: 4, first: NOW - 40 * DAY, last: NOW - 20 * DAY, kind: 'spelling' } } }, NOW);
assert.deepEqual([idle.mastered, idle.working], [[], []], 'not using the word for weeks is not mastery');
// Two right in a row after 20 quiet days: not mastered yet, and still shown as working on.
const almost = SR_insightsView({ v: 1, days: {}, pairs: { 'recieve→receive': { n: 3, first: NOW - 40 * DAY, last: NOW - 20 * DAY, kind: 'spelling', h: 'mmmgg', streak: 2 } } }, NOW);
assert.deepEqual([almost.mastered, almost.working.map((p) => p.streak)], [[], [2]], 'one more to master it');
// Too few words for a trend.
assert.equal(SR_insightsView({ v: 1, pairs: {}, days: { [day(0)]: { fixes: 1, words: 50 }, [day(8)]: { fixes: 1, words: 500 } } }, NOW).trend, null);
assert.deepEqual(SR_insightsView(undefined, NOW), {
  week: { fixes: 0, words: 0, per100: null }, prevWeek: { fixes: 0, words: 0, per100: null }, trend: null,
  weeks: Array(8).fill({ fixes: 0, words: 0, per100: null }), total: { proofreads: 0, words: 0 }, mastered: [], working: [], kinds: {}, kindsNow: null, kindsThen: null,
});

// weeks (oldest first) and totals for the chart and "Based on N proofreads".
assert.equal(view.weeks.length, 8);
assert.deepEqual(view.weeks[7], view.week);
assert.deepEqual(view.weeks[6], view.prevWeek);
const counted = SR_mergeInsights(SR_mergeInsights(undefined, [], NOW, 30, 1), [], NOW, 20, 0);
assert.deepEqual(counted.days[SR_dayKey(NOW)], { fixes: 1, words: 50, proofreads: 2, k: {} });
assert.deepEqual(SR_insightsView(counted, NOW).total, { proofreads: 2, words: 50 });

// Right uses: the corrected form in the user's own text, one a day, never stored as text.
{
  const T = (d, h = 9) => NOW + d * DAY + h * 3600000 - 12 * 3600000;
  let st = SR_mergeInsights(undefined, [{ from: 'recieve', to: 'receive' }], T(0), 5, 1, 'I will recieve it');
  st = SR_mergeInsights(st, [{ from: 'recieve', to: 'receive' }], T(1), 5, 1, 'did you recieve it');
  const rec = () => st.pairs['recieve→receive'];
  assert.deepEqual([rec().h, rec().streak], ['mm', 0]);
  st = SR_mergeInsights(st, [], T(2), 5, 0, 'We received it and will receive more.');
  assert.deepEqual([rec().h, rec().streak], ['mmg', 1], 'whole word only once, "received" is not "receive"');
  const pasted = SR_mergeInsights(st, [], T(2, 15), 5, 0, 'We will receive it.');
  assert.deepEqual([pasted.pairs['recieve→receive'].h, pasted.pairs['recieve→receive'].streak], ['mmg', 1], 'a second right use the same day earns nothing');
  st = SR_mergeInsights(st, [], T(3), 5, 0, 'I receive mail.');
  st = SR_mergeInsights(st, [], T(4), 5, 0, 'Did you receive it?');
  assert.deepEqual([rec().h, rec().streak], ['mmggg', 3]);
  assert.deepEqual(SR_insightsView(st, T(4)).mastered, [], '3 right in a row, but fixed 3 days ago: not yet');
  assert.equal(SR_insightsView(st, T(4)).working[0].streak, 3, 'still working on it, with its streak');
  const before15 = st;
  st = SR_mergeInsights(st, [], T(15), 5, 0, 'Received, thanks.');
  assert.deepEqual(SR_newlyMastered(before15, st), ['receive'], 'crossed into mastered on this merge (14 days since the fix)');
  assert.deepEqual(SR_newlyMastered(st, SR_mergeInsights(st, [], T(16), 5, 0, 'receive')), [], 'already mastered is not new');
  assert.deepEqual(SR_insightsView(st, T(15)).mastered, [{ from: 'recieve', to: 'receive', n: 2, kind: 'spelling', streak: 3 }]);
  assert.deepEqual(SR_insightsView(st, T(15)).working, [], 'mastered words leave working');
  st = SR_mergeInsights(st, [{ from: 'recieve', to: 'receive' }], T(17), 5, 1, 'recieve');
  assert.deepEqual([rec().h, rec().streak], ['mmgggm', 0], 'a fix resets the streak; h keeps the last 6');
  assert.deepEqual(SR_newlyMastered(undefined, undefined), []);
  assert.ok(!JSON.stringify(st).includes('mail') && !JSON.stringify(st).includes('Did'), 'no text stored');
  // The corrected form is the only evidence: "its" (a correct possessive) says nothing about its→it's.
  let a = SR_mergeInsights(undefined, [{ from: 'its', to: "it's" }, { from: 'its', to: "it's" }], T(0), 5, 2, 'its fine its ok');
  a = SR_mergeInsights(a, [], T(1), 5, 0, 'The dog wagged its tail.');
  assert.deepEqual([a.pairs["its→it's"].h, a.pairs["its→it's"].streak], ['m', 0], 'one m per proofread; "its" is not a right use');
  a = SR_mergeInsights(a, [], T(2), 5, 0, 'It’s fine.');
  assert.equal(a.pairs["its→it's"].streak, 1, 'curly apostrophe and sentence case still count');
  // A word fixed in this same text is not a right use elsewhere in it.
  let b = SR_mergeInsights(undefined, [{ from: 'there', to: 'their' }], T(0), 5, 1, 'x');
  b = SR_mergeInsights(b, [{ from: 'their', to: 'there' }], T(1), 5, 1, 'over their is their house');
  assert.equal(b.pairs['there→their'].streak, 0);
  // Case matters for capitals: "friday" is not a right use of Friday; "I" is.
  let c = SR_mergeInsights(undefined, [{ from: 'friday', to: 'Friday' }, { from: 'i', to: 'I' }], T(0), 5, 2, 'x');
  c = SR_mergeInsights(c, [], T(1), 5, 0, 'see you friday, I think');
  assert.deepEqual([c.pairs['friday→Friday'].streak, c.pairs['i→I'].streak], [0, 1]);
  // Punctuation pairs have no word to use.
  let d = SR_mergeInsights(undefined, [{ from: '', to: ',' }], T(0), 5, 1, 'x');
  d = SR_mergeInsights(d, [], T(1), 5, 0, 'a, b, c');
  assert.equal(d.pairs['→,'].streak, 0);
  // Stored h and streak are repaired if storage hands back junk.
  const junkH = SR_mergeInsights({ pairs: { 'x→y': { n: 2, last: NOW, h: '<b>', streak: -4, g: 'x' } } }, [], NOW, 0, 0);
  assert.deepEqual(junkH.pairs['x→y'], { n: 2, first: NOW, last: NOW, kind: 'other', h: '', streak: 0, g: 0 });
}
// Kinds over time: shares of the last 28 days and the 28 before, each only with 10 fixes.
{
  const k = (spelling, grammar) => ({ fixes: 0, words: 0, k: { spelling, grammar } });
  const kv = SR_insightsView({ v: 1, pairs: {}, days: { [day(3)]: k(2, 8), [day(27)]: k(1, 1), [day(28)]: k(10, 2), [day(55)]: k(0, 0), [day(56)]: k(50, 0) } }, NOW);
  assert.deepEqual([kv.kindsNow, kv.kindsThen], [{ spelling: 25, grammar: 75 }, { spelling: 83, grammar: 17 }]);
  const thin = SR_insightsView({ v: 1, pairs: {}, days: { [day(3)]: k(20, 8), [day(30)]: k(5, 4) } }, NOW);
  assert.deepEqual([thin.kindsNow, thin.kindsThen], [{ spelling: 71, grammar: 29 }, null], 'new user: this month set, 4 weeks ago null (9 fixes)');
  const quiet = SR_insightsView({ v: 1, pairs: {}, days: { [day(3)]: k(5, 4), [day(30)]: k(20, 8) } }, NOW);
  assert.deepEqual([quiet.kindsNow, quiet.kindsThen], [null, { spelling: 71, grammar: 29 }], 'each window stands alone');
}

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
assert.equal(rule('please', 'Please', 'capitalization'), 'A sentence starts with a capital letter.', 'not the days rule');
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

// Habits: named only with 2 different pairs or 3 fixes behind them, never generic.
{
  const w = (from, to, n) => ({ from, to, n, kind: SR_classifyCorrection({ from, to }) });
  const habits = (working) => SR_habits({ working });
  assert.deepEqual(habits([w('dont', "don't", 3), w('its', "it's", 2), w('recieve', 'receive', 2), w('beleive', 'believe', 2), w('i', 'I', 2)]), [
    { id: 'apostrophe', label: 'You leave out apostrophes in contractions', examples: ["don't", "it's"] },
    { id: 'ie-ei', label: 'You swap "ie" and "ei"', examples: ['receive', 'believe'] },
  ], 'lowercase i fixed twice is not yet a habit');
  assert.deepEqual(habits([w('their', 'there', 3)]).map((h) => h.id), ['their'], 'one word pair fixed 3 times is a habit');
  assert.deepEqual(habits([w('tomorow', 'tomorrow', 5)]), [], 'one misspelled word is that word, not a spelling habit');
  assert.deepEqual(habits([w('tomorow', 'tomorrow', 2), w('ocasion', 'occasion', 2)]).map((h) => h.id), ['letters']);
  assert.deepEqual(habits([w('teh', 'the', 2), w('adn', 'and', 2)]).map((h) => h.id), ['order']);
  assert.deepEqual(habits([w('friday', 'Friday', 2), w('march', 'March', 2), w('the', 'The', 2), w('we', 'We', 2)]).map((h) => h.id), ['days', 'sentence-start']);
  assert.deepEqual(habits([w('we was', 'we were', 2), w('was', 'were', 2), w('he have', 'he has', 1), w('is', 'are', 2)]).map((h) => h.id), ['agreement']);
  assert.deepEqual(habits([w('then', 'than', 1), w('your', "you're", 1), w('a', 'an', 1)]), [], 'one-off fixes (the model may be wrong) never count');
  assert.deepEqual(habits([w('dont', "don't", 1), w('cant', "can't", 1)]), [], 'two one-off fixes are not 2 pairs');
  assert.deepEqual(habits([w('rn', 'right now', 5), w('', ',', 9)]), [], 'nothing qualifies: nothing generic');
  const many = habits([w('dont', "don't", 4), w('im', "I'm", 2), w('i', 'I', 3), w('their', 'there', 3), w('then', 'than', 3), w('your', "you're", 3)]);
  assert.equal(many.length, 3, 'at most 3');
  assert.deepEqual(many.map((h) => h.id), ['apostrophe', 'lowercase-i', 'their'], 'most fixes first, ties in a fixed order');
  for (const h of many) assert.ok(!/—|–/.test(h.label) && /^(You|Your) /.test(h.label), h.label);
  for (const v of [undefined, null, {}, { working: 'x' }, { working: [null, { from: 'dont', to: "don't", n: 'x' }] }]) assert.deepEqual(SR_habits(v), []);
}

// The tips prompt carries the pairs and counts and nothing else.
{
  // Only the pairs and kind counts are sent (injection defenses are in test/injection.mjs).
  const { user } = SR_buildTipsPrompt([{ from: 'teh', to: 'the', n: 4 }, { from: 'was', to: 'were', n: 3 }], { spelling: 4, grammar: 3, other: 0 }, 'text-000000000000');
  assert.ok(user.startsWith('<text-000000000000>\nCorrections:\n- "teh" → "the" (4x)\n- "was" → "were" (3x)\n\nBy kind: spelling 4, grammar 3\n</text-000000000000>'));
}

// Progress hero: this week against the oldest week with 200+ words, k weeks back.
{
  const wk = (words, per100) => ({ words, fixes: 0, per100 });
  const view = (weeks, proofreads = 12) => ({ weeks, total: { proofreads } });
  const pad = (list) => [...Array(8 - list.length).fill(wk(0, null)), ...list];
  // 7 weeks back (the oldest of the 8) at 1.25 per 100, now 0.8: 36% fewer.
  let h = SR_progressHero(view([wk(300, 1.25), ...Array(6).fill(wk(0, null)), wk(400, 0.8)]));
  assert.deepEqual([h.state, h.lead, h.text, h.k], ['better', '36% fewer', ' mistakes than 7 weeks ago', 7]);
  assert.equal(h.line, 'About 1 in every 125 words this week, down from 1 in 80. Based on 12 proofreads.');
  // The real k: the oldest rated week here is 3 weeks back; a thin week (under 200 words) doesn't count.
  h = SR_progressHero(view(pad([wk(150, 9), wk(250, 2), wk(0, null), wk(0, null), wk(300, 2.5)])));
  assert.deepEqual([h.state, h.text, h.k], ['worse', '25% more mistakes than 3 weeks ago', 3], JSON.stringify(h));
  assert.equal(h.lead, '', 'worse is never in the "better" color');
  assert.match(h.line, /^About 1 in every 40 words this week, up from 1 in 50\./);
  h = SR_progressHero(view(pad([wk(300, 2), wk(300, 2.08)])));
  assert.deepEqual([h.state, h.text], ['flat', 'About the same as last week'], 'within 5%: the same; k 1 reads "last week"');
  h = SR_progressHero(view(pad([wk(300, 2), wk(300, 0)])));
  assert.equal(h.line, 'No mistakes this week. Based on 12 proofreads.');
  h = SR_progressHero(view(pad([wk(300, 2), wk(300, 2), wk(120, 1)]), 1));
  assert.deepEqual([h.state, h.text, h.line], ['light', 'Proofread a bit more this week to see your rate', 'Based on 1 proofread.'], 'history but a thin week: not "first weeks"');
  h = SR_progressHero(view(pad([wk(500, 2)])));
  assert.deepEqual([h.state, h.text], ['first', 'Your first weeks with Proofr']);
  assert.match(h.line, /^About 1 in every 50 words this week\. Based on/);
  assert.equal(SR_progressHero(view(pad([wk(90, 4)]))).line, 'Based on 12 proofreads.', 'no rate line from a thin week');
  assert.equal(SR_progressHero(null).state, 'first');
}

// Your words: one row per drillable word, a meter out of 3, honest labels.
{
  const DAYMS = 86400000;
  const working = [
    { from: 'its', to: "it's", kind: 'apostrophe', n: 6, h: 'mmgggg', streak: 2, last: NOW - DAYMS },
    { from: 'thanks', to: 'Thanks', kind: 'capitalization', n: 5, h: 'mm', streak: 0, last: NOW },
    { from: 'we', to: 'We', kind: 'capitalization', n: 4, h: 'mm', streak: 0, last: NOW },
    { from: 'i', to: 'I', kind: 'capitalization', n: 4, h: 'mg', streak: 1, last: NOW },
    { from: 'friday', to: 'Friday', kind: 'capitalization', n: 3, h: 'mm', streak: 0, last: NOW },
    { from: ',', to: ';', kind: 'punctuation', n: 9, h: 'm', streak: 0, last: NOW },
    { from: 'recieve', to: 'receive', kind: 'spelling', n: 2, h: 'mggg', streak: 3, last: NOW - 4 * DAYMS },
  ];
  const rows = SR_wordRows({ working }, { 'friday→Friday': { seen: 1 } }, NOW);
  assert.deepEqual(rows.map((r) => r.to), ["it's", 'I', 'Friday', 'receive'], 'no punctuation, no sentence-start capitals; "I" and days kept');
  assert.deepEqual(rows.map((r) => r.label), ['2 of 3 to master', '1 of 3', '0 of 3', 'Mastered in 10 days'], 'practiced but no right use yet is "0 of 3", not New');
  assert.deepEqual(rows.map((r) => r.meter), [2 / 3, 1 / 3, 0, 1]);
  assert.equal(rows[0].history, 'Last 6 times: fixed 2, right 4.');
  assert.match(rows[0].rule, /it is/);
  assert.equal(SR_wordRows({ working: [{ from: 'teh', to: 'the', kind: 'spelling', n: 2, h: 'mm', streak: 0, last: NOW }] }, {}, NOW)[0].label, 'New');
  assert.equal(SR_wordRows({ working: [{ ...working[6], last: NOW - 20 * DAYMS }] }, {}, NOW)[0].label, 'Mastered in 1 day', 'never 0 or negative days');
  assert.deepEqual(SR_wordRows(null), []);
  const mastered = ['separate', 'receive', 'friend', 'which', 'until', 'tomorrow', 'believe'].map((to) => ({ from: `${to}x`, to, kind: 'spelling' }));
  assert.equal(SR_masteredLine({ mastered: [...mastered, { from: 'we', to: 'We', kind: 'capitalization' }] }), 'Mastered: separate, receive, friend, which, until +2');
  assert.equal(SR_masteredLine({ mastered: [] }), '');
}

// AI tips cache: up to date while it covers every word shown.
{
  const cache = { words: ["it's", 'receive'], date: NOW, tips: { "it's": 'Swap in "it is".' } };
  assert.equal(SR_tipsState(null, ["it's"]).state, 'none');
  assert.equal(SR_tipsState({ key: 'old', tips: ['a list from before'] }, ["it's"]).state, 'none', 'the old 3-tip cache counts as none');
  assert.equal(SR_tipsState(cache, ["it's", 'receive']).state, 'fresh', 'counts changing (not in the key) keep it up to date');
  assert.equal(SR_tipsState(cache, ['receive']).state, 'fresh', 'a word leaving is not stale');
  assert.deepEqual(SR_tipsState(cache, ["it's", 'receive', 'were']), { state: 'stale', added: ['were'], date: NOW });
}

console.log('insights: all checks passed');
