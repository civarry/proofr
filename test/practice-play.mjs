// Duolingo-style Practice: the tappable words and the answer choices.
//   node test/practice-play.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';

globalThis.self = globalThis;
new Function(fs.readFileSync(process.env.CONSTANTS || new URL('../constants.js', import.meta.url), 'utf8'))();
for (const f of ['SR_practiceChoices', 'SR_practiceTokens']) assert.equal(typeof globalThis[f], 'function', `${f} is exported`);

const choices = (from, to, kind, seed = 0) => SR_practiceChoices({ from, to, kind }, seed);
const valid = (opts, from, to) => {
  assert.ok(opts.length >= 2 && opts.length <= 3, `2-3 options: ${JSON.stringify(opts)}`);
  assert.equal(opts.filter((o) => o === to).length, 1, `the right answer appears once: ${JSON.stringify(opts)}`);
  assert.ok(opts.includes(from), `the user's own mistake is an option: ${JSON.stringify(opts)}`);
  assert.equal(new Set(opts).size, opts.length, `no duplicates: ${JSON.stringify(opts)}`);
  for (const o of opts) assert.ok(!/[<>&"]/.test(o), `plain text only: ${o}`);
};

// Confusion sets use real words only.
{
  const o = choices('their', "they're", 'grammar');
  valid(o, 'their', "they're");
  assert.deepEqual([...o].sort(), ['their', 'there', "they're"].sort());
  valid(choices('its', "it's", 'apostrophe'), 'its', "it's");
  assert.equal(choices('its', "it's", 'apostrophe').length, 2, 'its/it\'s has no third real word');
  valid(choices('was', 'were', 'grammar'), 'was', 'were');
  valid(choices('then', 'than', 'grammar'), 'then', 'than');
}
// Apostrophes: one misplaced-apostrophe distractor, never the answer twice.
{
  const o = choices('dont', "don't", 'apostrophe');
  valid(o, 'dont', "don't");
  assert.equal(o.length, 3);
  assert.ok(o.some((w) => w.includes("'") && w !== "don't"), `a wrong apostrophe: ${JSON.stringify(o)}`);
}
// Spelling: one more single-edit misspelling that isn't the word itself.
{
  const o = choices('recieve', 'receive', 'spelling');
  valid(o, 'recieve', 'receive');
  assert.equal(o.length, 3);
  const extra = o.find((w) => w !== 'recieve' && w !== 'receive');
  assert.ok(extra && Math.abs(extra.length - 'receive'.length) <= 1, `a near miss: ${extra}`);
  for (let seed = 0; seed < 30; seed++) {
    const x = choices('recieve', 'receive', 'spelling', seed).find((w) => w !== 'recieve' && w !== 'receive');
    assert.ok(x[0] === 'r' && x.at(-1) === 'e', `the first and last letters stay: ${x}`);
  }
}
// Capitalization and multi-word: just the two forms.
assert.deepEqual([...choices('friday', 'Friday', 'capitalization')].sort(), ['Friday', 'friday']);
assert.deepEqual([...choices('i', 'I', 'capitalization')].sort(), ['I', 'i']);
assert.deepEqual([...choices('should of', 'should have', 'grammar')].sort(), ['should have', 'should of']);
// Deterministic per seed, and the order varies with the seed (the answer isn't always first).
{
  assert.deepEqual(choices('recieve', 'receive', 'spelling', 7), choices('recieve', 'receive', 'spelling', 7));
  const firsts = new Set(Array.from({ length: 20 }, (_, s) => choices('their', "they're", 'grammar', s)[0]));
  assert.ok(firsts.size >= 2, 'the right answer moves around');
}
// Junk in, nothing out.
assert.deepEqual(SR_practiceChoices(null), []);
assert.deepEqual(SR_practiceChoices({ from: '', to: 'x' }), []);
assert.ok(!SR_practiceChoices({ from: '<b>', to: 'x', kind: 'spelling' }).some((o) => /[<>]/.test(o)));

// Tokens: words and punctuation as chips, each mistake merged into one chip with its target.
{
  const item = { prompt: 'Just so you know, I dont think its ready, and we should of sent it.', targets: [
    { from: 'dont', to: "don't", kind: 'apostrophe' }, { from: 'its', to: "it's", kind: 'apostrophe' }, { from: 'should of', to: 'should have', kind: 'grammar' },
  ] };
  const tokens = SR_practiceTokens(item);
  const rebuilt = tokens.map((t) => (t.punct ? t.text : ` ${t.text}`)).join('').trim();
  assert.equal(rebuilt, item.prompt, 'the chips rebuild the sentence exactly');
  const marked = tokens.filter((t) => t.target).map((t) => t.text);
  assert.deepEqual(marked, ['dont', 'its', 'should of']);
  assert.ok(tokens.find((t) => t.text === 'should of').target.rule === null || typeof tokens.find((t) => t.text === 'should of').target.rule === 'string');
  assert.ok(tokens.filter((t) => t.punct).every((t) => /^[^\p{L}\p{N}]+$/u.test(t.text)), 'punctuation chips hold no words');
}
// Capitalization only matches the wrong case; the first match wins.
{
  const tokens = SR_practiceTokens({ prompt: 'Friday or friday, i think.', targets: [{ from: 'friday', to: 'Friday', kind: 'capitalization' }, { from: 'i', to: 'I', kind: 'capitalization' }] });
  assert.deepEqual(tokens.filter((t) => t.target).map((t) => t.text), ['friday', 'i']);
  assert.equal(tokens.find((t) => t.text === 'Friday').target, undefined);
}
assert.deepEqual(SR_practiceTokens(null), []);
assert.deepEqual(SR_practiceTokens({ prompt: 'ok', targets: 'junk' }).map((t) => t.text), ['ok']);
// Every real Practice item from a real view tokenizes with all its targets found.
{
  const DAY = 864e5, now = Date.now();
  let st = null;
  const S = [["i dont think its ready, their sending it tomorow.", "I don't think it's ready; they're sending it tomorrow."], ['we was hoping to recieve it by friday', 'We were hoping to receive it by Friday.']];
  for (let d = 10; d >= 0; d--) for (const [a, b] of S) st = SR_mergeInsights(st, SR_extractCorrections(a, b), now - d * DAY, 60, SR_diffCount(SR_wordDiff(a, b)), a);
  const view = SR_insightsView(st, now);
  for (let seed = 0; seed < 10; seed++) {
    for (const item of SR_buildPractice(view, 3, seed)) {
      const tokens = SR_practiceTokens(item);
      assert.equal(tokens.filter((t) => t.target).length, item.targets.length, `every target is tappable in: ${item.prompt}`);
      for (const t of tokens.filter((x) => x.target)) valid(SR_practiceChoices(t.target, seed), t.target.from, t.target.to);
    }
  }
}
console.log('practice-play: all checks passed');
