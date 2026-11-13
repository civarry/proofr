// Proofr's rules (mistakes found without AI): each rule fixes what it should,
// stays silent on correct writing, never touches links or quotations, and the
// hybrid Proofread runs rules, then the AI, then rules again.
//   node test/rules.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';

globalThis.self = globalThis;
new Function(fs.readFileSync(process.env.CONSTANTS || new URL('../constants.js', import.meta.url), 'utf8'))();
for (const f of ['SR_ruleCheck', 'SR_ruleFix', 'SR_applyHits', 'SR_proofreadHybrid', 'SR_reasonFromHits']) assert.equal(typeof globalThis[f], 'function', `${f} is exported`);

const fix = (s) => SR_ruleFix(s).text;

// 1. Every fix rule, on the mistake it exists for.
const CASES = [
  ['apostrophe', 'I dont know.', "I don't know."],
  ['apostrophe', 'Dont worry, it isnt late.', "Don't worry, it isn't late."],
  ['apostrophe', 'im here now.', "I'm here now."],
  ['lowercase-i', 'Yesterday i went home.', 'Yesterday I went home.'],
  ['lowercase-i', "Then i'm leaving.", "Then I'm leaving."],
  ['sentence-start', 'It rained. we stayed in.', 'It rained. We stayed in.'],
  ['sentence-start', 'Really? yes, really.', 'Really? Yes, really.'],
  ['days-months', 'See you on monday in october.', 'See you on Monday in October.'],
  ['a-an', 'It was a honest mistake and an big one.', 'It was an honest mistake and a big one.'],
  ['a-an', 'She has a idea about an university.', 'She has an idea about a university.'],
  ['a-an', 'A apple a day.', 'An apple a day.'],
  ['repeated-word', 'I saw the the report.', 'I saw the report.'],
  ['could-of', 'I could of been there.', 'I could have been there.'],
  ['could-of', 'You should of asked.', 'You should have asked.'],
  ['joined', 'There are alot of reasons and noone knows.', 'There are a lot of reasons and no one knows.'],
  ['misspelled', 'I will recieve it tommorow.', 'I will receive it tomorrow.'],
  ['everyday', 'I study everyday.', 'I study every day.'],
  ['we-was', 'We was late and they was too.', 'We were late and they were too.'],
  ['he-dont', 'He dont care.', "He doesn't care."],
  ['their-is', 'Their is a problem.', 'There is a problem.'],
  ['theyre-going', 'their going to win.', "they're going to win."],
  ['its-a', 'I think its a good plan.', "I think it's a good plan."],
  ['its-own', "The team has it's own room.", 'The team has its own room.'],
  ['youre-a', 'Your a great friend.', "You're a great friend."],
  ['youre-a', 'Thanks! Your welcome.', "Thanks! You're welcome."],
  ['then-than', 'It is better then before.', 'It is better than before.'],
  ['than-then', 'I have waited since than.', 'I have waited since then.'],
  ['lose-loose', 'I want to loose weight.', 'I want to lose weight.'],
  ['affect-effect', 'It had an affect on me.', 'It had an effect on me.'],
  ['supposed-to', 'It was suppose to rain.', 'It was supposed to rain.'],
  ['used-to', 'We use to live there.', 'We used to live there.'],
  ['double-space', 'Two  spaces here.', 'Two spaces here.'],
  ['space-before', 'Hello , world .', 'Hello, world.'],
  ['space-after-comma', 'Red,green and blue.', 'Red, green and blue.'],
  ['he-goes', 'He go to school every day.', 'He goes to school every day.'],
  ['he-goes', 'She have two cats but he are tall.', 'She has two cats but he is tall.'],
  ['he-goes', 'I stay home because it take too long. He forget to call.', 'I stay home because it takes too long. He forgets to call.'],
  ['they-go', 'They goes home and I has a question.', 'They go home and I have a question.'],
  ['they-go', "We is ready but they doesn't care.", "We are ready but they don't care."],
  ['they-go', 'Today I is happy.', 'Today I am happy.'],
  ['plural-was', 'The results was clear.', 'The results were clear.'],
  ['plural-was', 'Because the students was tired, my parents is strict.', 'Because the students were tired, my parents are strict.'],
  ['there-are-many', 'There is many reasons.', 'There are many reasons.'],
  ['there-are-many', "There's several options and there was numerous delays.", 'There are several options and there were numerous delays.'],
  ['have-went', 'I have went there and she had took it.', 'I have gone there and she had taken it.'],
  ['have-went', "We've already ate.", "We've already eaten."],
  ['could-of', 'I would of came.', 'I would have come.'],
  ['i-seen', 'I seen it yesterday.', 'I saw it yesterday.'],
  ['me-and-him', 'Me and him went to the store.', 'He and I went to the store.'],
  ['me-and-him', 'Me and my friend went home. Him and me played.', 'My friend and I went home. He and I played.'],
  ['me-and-him', 'Me and him was late. Me and her is friends.', 'He and I were late. She and I are friends.'],
  ['between-you-and-me', 'Keep this between you and I. It is for you and I.', 'Keep this between you and me. It is for you and me.'],
  ['too-much', 'It is way to much work and it was to late.', 'It is way too much work and it was too late.'],
  ['advice-advise', 'I advice you to take my advise.', 'I advise you to take my advice.'],
  ['breath-breathe', "I can't breath. Take a deep breathe.", "I can't breathe. Take a deep breath."],
  ['caps-lock', 'hELLO there, tHANKS.', 'Hello there, Thanks.'],
  ['name-are', 'Hello my name are Joy. My friend are kind.', 'Hello my name is Joy. My friend is kind.'],
  ['proper-noun', 'I live in thephilippines and speak english and tagalog.', 'I live in the Philippines and speak English and Tagalog.'],
  ['phrase', 'For all intensive purposes, I wonder weather or not it works.', 'For all intents and purposes, I wonder whether or not it works.'],
  ['misspelled', 'An intresting arguement about the enviroment.', 'An interesting argument about the environment.'],
  ['joined', 'Infact it was ontop.', 'In fact it was on top.'],
];
const covered = new Set();
for (const [id, input, want] of CASES) {
  assert.equal(fix(input), want, `${id}: ${input}`);
  const hits = SR_ruleFix(input).hits;
  assert.ok(hits.some((h) => h.id === id), `${id} is the rule that fired on: ${input}`);
  for (const h of hits) { covered.add(h.id); assert.ok(h.why && h.why.length > 8, `${h.id} gives a reason`); }
}
const fixIds = SR_RULES.filter((r) => r.kind === 'fix').map((r) => r.id);
for (const id of fixIds) assert.ok(covered.has(id), `rule ${id} has a test case`);
assert.equal(new Set(SR_RULES.map((r) => r.id)).size, SR_RULES.length, 'rule ids are unique');

// 2. Correct writing: no rule may fire. Each line is a trap for one rule.
const CORRECT = [
  'A and B cleared the shipment.', 'Choose option a or b.', 'Plan A is better than plan B.',
  'I could of course leave early.', 'He would of all people know.', 'Its just price was fair.',
  'The dog wagged its tail.', 'The company lost its way.', 'Their house is big.', 'Their going-away party was fun.',
  'Gave her her book back.', 'He slipped in in safety.', 'I knew that that was wrong.', 'He had had enough.',
  'What confounded you was the noise.', 'You were right.', 'Well, well, well.', 'Bye bye now.',
  'She is a university student.', 'It is a one-time offer.', 'A European trip.', 'An hour later.', 'An honest answer.',
  'A useful tool.', 'A unique idea.', 'An umbrella.', 'An X-ray of a hand.', 'An LLM wrote it.', 'A URL is a link.',
  'Mr. Smith arrived. Dr. Jones left.', 'See e.g. the appendix.', 'Wait... and then it happened.', 'It costs approx. ten dollars.',
  'Chapter III. The beginning.', 'The U.S. economy grew.', 'The file is named report.txt today.', 'Visit example.com, then call.',
  'Go to https://example.com/a , then come back.', 'Email me at a.b@example.com today.', 'Ask @dont_panic for help.',
  'He said "i dont know" and left.', 'The sign read “we was here” in chalk.', 'Use `dont` as the variable name.',
  'It is more than enough.', 'Back then, life was simple.', 'Then we left.', 'Rather than wait, we left.',
  'The rope is loose.', 'The screw is not loose.', 'She wore a loose dress.', 'Tie up loose ends.',
  'The weather will affect the game.', 'It affects everyone.', 'The effect was clear.',
  'I suppose to some extent that is true.', 'We use tools to build.', 'I use it to write.',
  'Everyday clothes are fine.', 'It is an everyday thing.', 'We met in May and March.', 'He will march on.', 'You may go.',
  'The price is 1,000 dollars.', 'Values 1,2,3 are listed.', 'Sentence one.  Sentence two.',
  'Column A        Column B', 'iPhone sales rose. eBay did too.', 'I think, therefore I am.',
  "I'm sure it's fine.", "Don't worry; we're here.", 'The cant of the deck was steep.',
  'He went to the store.', 'They were at home.', 'It was their idea.', 'There is a problem.', "They're late.",
  "You're welcome.", 'Your very own room.', 'Your answer is right.', 'Its color is red.', "It's a good day.",
  'Students who study every day improve.', 'He doesn\'t know.', 'She does not care.', 'What is it? It is a box.',
  'Read sections i and ii.', 'Item (i) is first.', 'The variable i = 3.', 'No. 5 is mine.', 'Fig. 2 shows it.',
  'The ratio was 3:1.', 'Note : this is French spacing.', 'Bonjour !', 'Pourquoi ?',
  // Lowercase names and files at a sentence start (found on real prose).
  'It was released in 2022. nspell was too.', 'Theme colors live there. theme.js sets them.', 'It passed. e2e-ui covers the list.',
  'Post it there. r/alphaandbetausers fits.', 'Chrome underlines spelling. write-good\'s checks are opinions.',
  // Agreement: questions, objects, compound subjects and the subjunctive take the base form.
  'Does he go to school?', 'Let her go.', 'He and she go to school.', 'I insist that he go.', 'He need not worry.',
  'Can he come?', 'Why does she like it?', 'Would he or she like tea?', 'If he were here, he would help.', 'He read the book.',
  'He put it away.', 'She cut her hair.', 'She said she would.', 'She used to live here.',
  'What surprised the parents was the cost.', 'Among the reasons was the cost.', 'Before the meetings was a lunch.',
  'The news was good.', 'The series is long.', 'The Beatles was a band.', 'The bus was late.', 'The analysis was clear.',
  'Physics is hard.', 'The headquarters is in Paris.', 'His glasses were broken.', 'The odds were long.',
  'Part I has three chapters.', 'World War I is over.', 'Henry I was king.', 'The gift I gave you has arrived.',
  'Have you seen it?', 'Were they seen leaving?', 'They had come home.', 'I have come to see you.', 'The saw was sharp.',
  'There is many a slip.', 'There are many reasons.', 'I gave it to him and I left.', 'Me and him?', 'He and I went home.', 'She and he are friends.',
  'I spoke to many people.', 'The goal is to many a person.', 'The trick is to slow down.', 'I went to bed late.',
  'In the mist of the morning we walked.', 'Whatever makes you happy.', 'Take a breath.', 'Breathe in.', 'Good advice.',
  'The parents of my friend are kind.', 'The keys to my house are lost.', 'My mom and my dad are home.', 'You and my friend are invited.',
  'My family are all here.', 'The data are clear.', 'Get the mRNA and tRNA data.', 'Use iOS or eBPF.', 'A china cup and a turkey dinner.',
  'Please polish the table.', 'They speak English.', 'The Philippines is warm.',
  // Found on older novels: an inverted question, "like" as a preposition, a wrapped line.
  'What is he like?', 'Why could not he keep quiet?', 'Let it go.', 'Make it work.', 'I saw it happen.', 'We had it take shape slowly.', 'Help it grow.', 'Does it work?', 'It cost ten dollars.', 'Watch it move.', 'The account of my actions and\ntheir motives has been read.',
];
for (const s of CORRECT) assert.deepEqual(SR_ruleCheck(s).map((h) => `${h.id}: ${h.from} → ${h.to}`), [], `no fix on correct text: ${s}`);

// 3. Quotations, links and code are never touched, even with mistakes inside.
assert.equal(fix('He wrote "i dont know" but i dont agree.'), 'He wrote "i dont know" but I don\'t agree.');
assert.equal(fix('Open www.alot.com now.'), 'Open www.alot.com now.');

// 3b. A whole box starts a sentence; a selection may not, so it's left alone.
assert.equal(SR_ruleFix('hello there.', { atStart: true }).text, 'Hello there.');
assert.equal(SR_ruleFix('hello there.').text, 'hello there.', 'a selection may start mid-sentence');
assert.equal(SR_ruleFix('nspell is a library.', { atStart: true }).text, 'nspell is a library.', 'only common sentence starters');
assert.equal(SR_ruleFix('hELLO MY name are joy and i leave in thephilippines', { atStart: true }).text, 'Hello MY name is joy and I leave in the Philippines');

// 4. Case is kept: "Dont" → "Don't", "DONT" → "DON'T".
assert.equal(fix('DONT do it.'), "DON'T do it.");
assert.equal(fix('Alot of people.'), 'A lot of people.');

// 5. School hints: only from the hint rules, never applied by SR_ruleFix.
const hints = (s) => SR_ruleCheck(s, { kind: 'hint' }).map((h) => `${h.from} → ${h.to}`);
assert.deepEqual(hints("I don't think it's done."), ["don't → do not", "it's → it is"]);
assert.deepEqual(hints("It's been a year."), ["It's → It has"]);
assert.deepEqual(hints('Due to the fact that we were gonna win, we trained in order to improve.'), ['Due to the fact that → Because', 'gonna → going to', 'in order to → to']);
assert.deepEqual(hints("He'd go. That's ok."), ["That's → That is"], "'d is ambiguous (had or would), so it's left alone");
assert.equal(fix("I don't think it's done."), "I don't think it's done.", 'hints are never applied by the fix pass');
for (const h of SR_ruleCheck('Irregardless, I gotta go.', { kind: 'hint' })) assert.ok(h.why.length > 8);

// 6. Reasons in Review come from the hits that made each change.
const hits = SR_ruleFix('I could of been there everyday.').hits;
assert.match(SR_changeReason('could of', 'could have', hits), /write "have", not "of"/);
assert.match(SR_changeReason('everyday.', 'every day.', hits), /each day/);
assert.equal(SR_changeReason('blue', 'red', hits), null, 'no matching hit, no reason');

// 7. The hybrid Proofread: rules, then the AI, then rules again.
const seen = [];
const fakeAI = async (t) => { seen.push(t); return { text: t.replace('walk ', 'walked ').replace('the report', 'the the report'), provider: 'device' }; };
const r = await SR_proofreadHybrid('yesterday i walk to see the report alot.', { runAI: fakeAI });
assert.equal(seen[0], 'yesterday I walk to see the report a lot.', 'the AI sees the text after the rules');
assert.equal(r.text, 'yesterday I walked to see the report a lot.', 'rules run again on the AI result (the repeated word it added)');
assert.equal(r.ruleCount, 3, 'three rule fixes: i, alot, the the');
assert.equal(r.ai.provider, 'device');
assert.equal(r.base, 'yesterday I walk to see the report a lot.', 'base is what the AI was given, so the change guard judges the AI alone');
const only = await SR_proofreadHybrid('i dont know.', {});
assert.deepEqual([only.text, only.ai, only.ruleCount], ["I don't know.", null, 2], 'no AI: rules alone');
const school = await SR_proofreadHybrid("i don't know, it's gonna rain.", { school: true });
assert.equal(school.text, "I don't know, it's gonna rain.");
assert.deepEqual(school.hints.map((h) => h.to), ['do not', 'it is', 'going to'], 'School hints are found on the fixed text');
const touching = await SR_proofreadHybrid('I dont know.', { school: true });
assert.deepEqual(touching.hints, [], 'a hint on a word just fixed waits for the next check (it would merge with the fix)');

// 7b. Review separates the hints from the fixes: with every hint off, the text is exactly the fixed one.
const original = "i don't know, it's gonna rain.";
const hd = SR_hintDiff(original, school.text, school.hints);
assert.ok(hd, 'hints separate cleanly');
assert.equal(hd.hintGroups.size, 3);
assert.equal(SR_applyDiff(hd.ops, hd.hintGroups), school.text, 'all hints off = the fixed text');
assert.equal(SR_applyDiff(hd.ops, new Set()), 'I do not know, it is going to rain.', 'all hints on');
assert.equal(SR_hintDiff(original, school.text, []), null, 'no hints, nothing to separate');
await assert.rejects(SR_proofreadHybrid('x', { runAI: async () => { throw new Error('model failed'); } }), /model failed/, 'an AI error still reaches the caller');

// 8. Fast enough to run on every Proofread: 20,000 characters in well under 50 ms.
const long = 'We was hoping to recieve the report by friday, but it dont arrive yet. '.repeat(280);
const t0 = performance.now();
SR_ruleFix(long);
const ms = performance.now() - t0;
assert.ok(ms < 200, `rules on ${long.length} chars took ${ms.toFixed(1)} ms`);

console.log(`rules: ${fixIds.length} fix rules and ${SR_RULES.length - fixIds.length} hint rules, ${CASES.length} cases, ${CORRECT.length} correct sentences untouched, ${long.length} chars in ${ms.toFixed(1)} ms`);
