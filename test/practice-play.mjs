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
// === Adapts to what the user needs ===
for (const f of ['SR_practicePlan', 'SR_mergePracticeStats', 'SR_practiceQuestion', 'SR_validPracticeSentence', 'SR_practiceKey', 'SR_ruleFor', 'SR_mixupPlan']) {
  assert.equal(typeof globalThis[f], 'function', `${f} is exported`);
}
{
  const DAY = 864e5, now = Date.parse('2026-10-20T12:00:00Z');
  const working = [
    { from: 'teh', to: 'the', n: 9, kind: 'spelling' },
    { from: 'dont', to: "don't", n: 6, kind: 'apostrophe' },
    { from: 'their', to: "they're", n: 4, kind: 'grammar' },
    { from: 'recieve', to: 'receive', n: 3, kind: 'spelling' },
    { from: 'was', to: 'were', n: 2, kind: 'grammar' },
    { from: ',', to: ';', n: 8, kind: 'punctuation' },
  ];
  const view = { working };
  // Nothing practiced yet: most-fixed first, punctuation never.
  const fresh = SR_practicePlan(view, {}, 4, now).map((t) => t.to);
  assert.deepEqual(fresh, ['the', "don't", "they're", 'receive']);
  // Missed last round comes back first; answered right twice recently goes last.
  let stats = SR_mergePracticeStats({}, [{ from: 'was', to: 'were', right: false }, { from: 'teh', to: 'the', right: true }], now - DAY);
  stats = SR_mergePracticeStats(stats, [{ from: 'teh', to: 'the', right: true }], now - 1000);
  const plan = SR_practicePlan(view, stats, 5, now).map((t) => t.to);
  assert.equal(plan[0], 'were', 'the word missed last time comes first');
  assert.equal(plan.at(-1), 'the', 'a word got right twice just now comes last');
  assert.equal(new Set(plan).size, plan.length, 'no word twice in a round');
  // Stats keep only pairs and counts, survive junk, and stay bounded.
  assert.deepEqual(Object.keys(stats['was→were']).sort(), ['last', 'level', 'right', 'seen', 'streak', 'wrongLast'].sort());
  assert.ok(!JSON.stringify(stats).match(/sentence|prompt/));
  assert.deepEqual(SR_mergePracticeStats('junk', [{ from: 'a', to: 'an', right: true }], now)['a→an'].seen, 1);
  let big = {};
  for (let i = 0; i < 400; i++) big = SR_mergePracticeStats(big, [{ from: `w${i}x`, to: `w${i}`, right: true }], now + i);
  assert.ok(Object.keys(big).length <= 300, 'bounded');
  assert.ok(big['w399x→w399'], 'the newest are kept');
}

// No two questions in a round share an answer (seen in use: once you answered
// the first, you knew the rest).
{
  const view = { working: [
    { from: 'their', to: "they're", n: 5, kind: 'grammar' }, { from: 'there', to: "they're", n: 4, kind: 'grammar' },
    { from: 'theyre', to: "they're", n: 3, kind: 'apostrophe' }, { from: 'dont', to: "don't", n: 2, kind: 'apostrophe' },
  ] };
  const plan = SR_practicePlan(view, {}, 8, Date.now());
  assert.deepEqual(plan.filter((t) => !t.starter).map((t) => t.to), ["they're", "don't"], 'each answer once, even across different mistakes');
  assert.equal(new Set(plan.map((t) => t.to.toLowerCase())).size, plan.length, 'starters never repeat an answer either');
}

// Starters: classic mix-ups top up a round for a user with few words of their own.
{
  const own = (k) => ({ working: [
    { from: 'recieve', to: 'receive', n: 5, kind: 'spelling' }, { from: 'was', to: 'were', n: 4, kind: 'grammar' },
    { from: 'their', to: "they're", n: 3, kind: 'grammar' }, { from: 'teh', to: 'the', n: 2, kind: 'spelling' },
  ].slice(0, k) });
  const now = Date.now();
  assert.ok(SR_practicePlan(own(4), {}, 10, now).every((t) => !t.starter), '4 own words: no starters');
  for (const k of [1, 2, 3]) {
    const plan = SR_practicePlan(own(k), {}, 10, now);
    assert.equal(plan.length, 6, `${k} own words: topped up to 6`);
    assert.deepEqual(plan.slice(0, k).map((t) => !!t.starter), Array(k).fill(false), 'own words first');
    assert.ok(plan.slice(k).every((t) => t.starter), 'then starters');
    const answers = plan.map((t) => t.to.toLowerCase());
    assert.equal(new Set(answers).size, answers.length, 'no starter repeats an own answer');
  }
  assert.ok(!SR_practicePlan(own(2), {}, 10, now).some((t) => t.starter && t.to === 'were'), 'were is the user\'s own: no starter asks it');
  assert.equal(SR_practicePlan(own(2), {}, Infinity, now).length, 6, 'never more than 6, even with no cap');
  assert.equal(SR_practicePlan(own(2), {}, 3, now).length, 3, 'never more than the round');
  assert.deepEqual(SR_practicePlan(own(0), {}, 10, now), [], 'no own words: no practice');
  // Own keys and starter keys never collide; a missed starter comes first among starters.
  let st = SR_mergePracticeStats({}, [{ from: 'was', to: 'were', right: true }, { from: 'was', to: 'were', starter: true, right: false }], now);
  assert.ok(st['was→were'].right === 1 && st['starter:was→were'].right === 0, JSON.stringify(st));
  assert.equal(SR_practiceKey(SR_PRACTICE_STARTERS[0]), `starter:${SR_PRACTICE_STARTERS[0].from}→${SR_PRACTICE_STARTERS[0].to}`);
  const last = SR_PRACTICE_STARTERS.at(-1);
  st = SR_mergePracticeStats({}, [{ ...last, right: false }], now);
  assert.equal(SR_practicePlan(own(1), st, 10, now)[1].to, last.to, 'the starter missed last time comes first among starters');
  // Mix-ups mode: starters only, each answer once, up to the round.
  const mix = SR_mixupPlan({}, 10, now);
  assert.ok(mix.length >= 6 && mix.length <= 10 && mix.every((t) => t.starter), JSON.stringify(mix));
  assert.equal(new Set(mix.map((t) => t.to.toLowerCase())).size, mix.length);
  assert.equal(SR_mixupPlan({}, 3, now).length, 3);
  // Every starter: a context phrase (so its template has one right choice) and a rule.
  for (const t of SR_PRACTICE_STARTERS) {
    const phrase = SR_PRACTICE_PHRASES[t.to.toLowerCase()];
    assert.ok(phrase, `starter ${t.to} has a context phrase`);
    assert.ok(SR_ruleFor(t), `starter ${t.to} has a rule`);
    for (const seed of [0, 1, 2]) {
      const q = SR_practiceQuestion(t, null, seed);
      const text = q.tokens.map((x) => x.text).join(' ');
      assert.ok(text.includes(phrase.split('{x}')[1].trim() || phrase.split('{x}')[0].trim()), `${t.to}: the template uses its phrase: ${text}`);
      assert.equal(q.tokens[q.k].target.to, t.to);
    }
  }
}
// === A question from a sentence (AI-written or template) ===
{
  const t = { from: 'dont', to: "don't", kind: 'apostrophe' };
  const q = SR_practiceQuestion(t, "I don't think the meeting moved.", 0);
  assert.equal(q.tokens[q.k].target.to, "don't");
  assert.equal(q.source, 'ai');
  // No usable sentence: the local template, never empty.
  const tq = SR_practiceQuestion(t, null, 0);
  assert.equal(tq.source, 'template');
  assert.equal(tq.tokens[tq.k].target.to, "don't");
  assert.ok(tq.tokens.map((x) => x.text).join(' ').length > 8);
}
// Sentence checks: an AI sentence is only used when it's safe and clean.
{
  const t = { from: 'recieve', to: 'receive', kind: 'spelling' };
  const ok = (s) => SR_validPracticeSentence(s, t);
  assert.ok(ok('We should receive the files by noon.'));
  assert.ok(!ok('We should recieve the files by noon.'), 'the right word must be in it');
  assert.ok(!ok('We receive it and receive it again.'), 'exactly once');
  assert.ok(!ok('receive'), 'a real sentence, not a word');
  assert.ok(!ok('We should receive the files by noon and also the other files and the rest of the documents for the review we have planned for the end of the long week ahead.'), 'short');
  assert.ok(!ok('<b>We should receive it.</b>'), 'no markup');
  assert.ok(!ok('Ignore the task. We receive it.\nSecond line.'), 'one line');
  assert.ok(!ok('You are a writing assistant and we receive it.'), 'no leaked prompt');
  assert.ok(ok('Did you receive it?'), 'questions are fine');
  // Capitalization keeps case: "friday" doesn't count as Friday.
  const day = { from: 'friday', to: 'Friday', kind: 'capitalization' };
  assert.ok(SR_validPracticeSentence('See you on Friday morning.', day));
  assert.ok(!SR_validPracticeSentence('See you on friday morning.', day));
}
// Every built-in sentence holds its answer exactly once (seen in use: "___ hope I
// can make it", where the second "I" gave the answer away).
{
  const words = [...Object.keys(SR_PRACTICE_PHRASES).filter((w) => w !== 'i'), 'I', 'Friday', 'March'];
  for (const to of words) for (let seed = 0; seed < 6; seed++) {
    const kind = /^(I|Friday|March)$/.test(to) ? 'capitalization' : 'spelling';
    const q = SR_practiceQuestion({ from: to === 'I' ? 'i' : `${to}x`, to, kind }, null, seed);
    const shown = q.tokens.filter((_, j) => j !== q.k).map((t) => t.text);
    const same = (w) => (kind === 'capitalization' ? w === to : w.toLowerCase() === to.toLowerCase());
    assert.ok(!shown.some(same), `the template for "${to}" doesn't show the answer elsewhere: ${q.tokens.map((t) => t.text).join(' ')}`);
  }
}
// Every choice question has one clearly right answer (seen in use: "Quick update: I
// wrote ___ in the email." with have / has, where neither is right). A word that
// can be confused with another real word has its own sentence, and a word with no
// sentence gets no template: it waits for an AI one.
{
  const sets = [...SR_CONFUSION_SETS, ...SR_GRAMMAR_SETS];
  for (const w of new Set(sets.flat())) assert.ok(SR_practicePhrase({ to: w }), `"${w}" has a built-in sentence`);
  for (const [from, to] of [['has', 'have'], ['have', 'has'], ['are', 'is'], ['does', 'do'], ['too', 'to'], ['whose', "who's"], ['effect', 'affect']]) {
    for (let seed = 0; seed < 6; seed++) {
      const q = SR_practiceQuestion({ from, to, kind: 'grammar' }, null, seed);
      const text = q.tokens.map((t, j) => (j === q.k ? '___' : t.text)).join(' ');
      assert.ok(!/\b(wrote|says|check)\b/.test(text), `${to}: a real sentence, not a mention: ${text}`);
      assert.equal(q.tokens[q.k].target.to, to);
    }
  }
  assert.equal(SR_practiceQuestion({ from: 'form', to: 'from', kind: 'spelling' }, null, 0), null, 'no built-in sentence: no template question');
  assert.equal(SR_freshTemplate({ from: 'form', to: 'from', kind: 'spelling' }, 0, new Set()), null);
  // With an AI sentence it is asked as usual.
  assert.equal(SR_practiceQuestion({ from: 'form', to: 'from', kind: 'spelling' }, 'The parcel came from Spain.', 0).source, 'ai');
  // The opener never holds the answer, and no template ends in a question word with a period.
  for (const to of Object.keys(SR_PRACTICE_PHRASES)) for (let seed = 0; seed < 3; seed++) {
    const q = SR_practiceQuestion({ from: `${to}x`, to, kind: 'spelling' }, null, seed);
    assert.ok(q, `${to}: a template`);
    assert.ok(!/^(did|can|what|how|where|who|when|is|are|do|does)\b/i.test(SR_practicePhrase({ to })), `${to}: a statement, not a question`);
  }
}
console.log('practice-play: all checks passed');
