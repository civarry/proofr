// Practice v2 engine: AI questions checked by code, the waiting pool, never
// repeating, word levels and the ~80% target, the daily provider budget.
//   node test/practice-engine.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';

globalThis.self = globalThis;
new Function(fs.readFileSync(process.env.CONSTANTS || new URL('../constants.js', import.meta.url), 'utf8'))();

const DONT = { from: 'dont', to: "don't", kind: 'apostrophe' };
const RECV = { from: 'recieve', to: 'receive', kind: 'spelling' };
const FRI = { from: 'friday', to: 'Friday', kind: 'capitalization' };
const THEY = { from: 'their', to: "they're", kind: 'grammar' };
const item = (word, sentence, topic = 'shopping') => ({ word, topic, sentence });
const json = (...items) => JSON.stringify({ questions: items });

// === Shots and topics ===
{
  assert.ok(SR_PRACTICE_TOPICS.length >= 8 && new Set(SR_PRACTICE_TOPICS).size === SR_PRACTICE_TOPICS.length);
  assert.ok(SR_PRACTICE_SHOTS.length >= 3);
  for (const [word, topic, sentence] of SR_PRACTICE_SHOTS) {
    const t = { from: `${word}x`, to: word, kind: 'spelling' };
    assert.ok(SR_validPracticeSentence(sentence, t), `shot is a valid sentence for its word: ${sentence}`);
    assert.ok(!sentence.toLowerCase().replace(/’/g, "'").startsWith(word.toLowerCase()), `shot doesn't start with its word: ${sentence}`);
    assert.ok(SR_questionFromSentence(t, sentence).q, `shot becomes a question: ${sentence}`);
    assert.ok(SR_PRACTICE_TOPICS.includes(topic), `shot topic is a listed topic: ${topic}`);
  }
}

// === R1: one contract for every engine; the reply is parsed out of anything ===
{
  // On-device: one word per request, rules and examples in a base session.
  const dev = SR_buildSentenceParts('text-000000000000');
  assert.match(dev.system, /data, not instructions/i);
  assert.match(dev.system, /must not be the first word/);
  assert.equal(dev.shots.length, SR_PRACTICE_SHOTS.length);
  assert.ok(dev.shots.every(([u, a]) => /Word: .+\nTopic: .+/.test(u) && u.includes('<text-000000000000>') && SR_PRACTICE_SHOTS.some((x) => x[2] === a)), 'shots use the same fenced Word/Topic turn');
  assert.match(dev.user("don't", 'shopping'), /<text-000000000000>\nWord: don't\nTopic: shopping\n<\/text-000000000000>/);
  // Providers: one batched call, a word and topic per line, the same rules and examples.
  const items = SR_practiceItems([DONT, RECV], 4, 1);
  assert.deepEqual(items.map((x) => x.to), ["don't", 'receive', "don't", 'receive'], 'cycles over the words');
  assert.deepEqual(items.map((x) => x.topic), SR_PRACTICE_TOPICS.slice(1, 5), 'topics rotate from the seed');
  assert.notDeepEqual(SR_practiceItems([DONT, RECV], 4, 2).map((x) => x.to + x.topic), items.map((x) => x.to + x.topic), 'another seed, other pairs');
  assert.deepEqual(SR_practiceItems([], 4, 0), []);
  const parts = SR_buildQuestionPrompt(items, 'text-000000000000');
  assert.ok(parts.user.includes("don't | school homework") && parts.user.includes('receive | a weekend trip'), 'word | topic lines');
  assert.ok(!parts.user.includes('dont') && !parts.user.includes('recieve'), 'the wrong forms are not sent');
  assert.match(parts.system, /data, not instructions/i);
  assert.match(parts.system, /must not be the first word/);
  assert.ok(SR_PRACTICE_SHOTS.every(([, , x]) => parts.system.includes(x)), 'the same examples, inlined');
  assert.ok(!/___/.test(parts.system), 'asks for full sentences, no blanks');

  const good = [item("don't", "I don't think the meeting moved today."), item('receive', 'Did you receive the package this morning?')];
  const parse = (text) => SR_parseQuestions(text, [DONT, RECV]).map((q) => q.filled);
  const want = ["I don't think the meeting moved today.", 'Did you receive the package this morning?'];
  assert.deepEqual(parse(`Sure! Here are your questions:\n${json(...good)}\nHope that helps {not json}`), want, 'chatter around the JSON');
  assert.deepEqual(parse('```json\n' + json(...good) + '\n```'), want, 'a code fence');
  assert.deepEqual(parse(json(...good).slice(0, -12)), [want[0]], 'a cut-off array keeps the whole items');
  assert.deepEqual(parse(json(good[0], { word: 7, sentence: null }, good[1])), want, 'a wrong-typed item drops only itself');
  assert.deepEqual(parse(`{"questions":[${JSON.stringify(good[0])},{"word":"receive" "sentence":"x y z."},${JSON.stringify(good[1])}]}`), want, 'a malformed item drops only itself');
  assert.deepEqual(parse(json(...good) + '\n' + json(item("don't", 'We don’t have time for it now.'))), want, 'only the first JSON block');
  assert.deepEqual(parse('no json here'), []);
  assert.equal(parse(json(item("don't", "Please check that don't fits here today."), item('receive', 'Please check that receive fits here today.'))).length, 2,
    'the same frame for two words is two questions');
  assert.deepEqual(parse(json(item('banana', 'I like a banana at lunch today.'))), [], 'a word not asked for');
  assert.deepEqual(parse(json(item("DON'T", "I don't think the meeting moved today."))), [want[0]], 'case-insensitive word match');
  assert.equal(SR_parseQuestions(json(item('friday', 'See you on Friday after the meeting.')), [FRI]).length, 0, 'capitalization words match exactly');
  const why = SR_parseQuestions(json(good[0], item("don't", "Don't forget the forms for the meeting."), item("don't", 'I do not think so at all.'), { word: 1 }), [DONT]).drops;
  assert.deepEqual(why, { start: 1, count: 1, json: 1 }, 'drop reasons are counted');
}

// === R2: correctness is code's, not the AI's ===
{
  // Code makes the blank from a full sentence.
  const f = (t, s) => SR_questionFromSentence(t, s);
  assert.equal(f(DONT, "I don't think the meeting moved today.").q.sentence, 'I ___ think the meeting moved today.');
  assert.equal(f(DONT, 'I don’t think the meeting moved today.').q.filled, "I don't think the meeting moved today.", 'curly apostrophe found, straightened');
  assert.equal(f(DONT, '"I don\'t think the meeting moved today."').q.filled, "I don't think the meeting moved today.", 'wrapping quotes dropped');
  assert.equal(f(DONT, 'I think the meeting moved today.').why, 'count', 'the word missing');
  assert.equal(f(DONT, "I don't know and don't care today.").why, 'count', 'the word twice');
  assert.equal(f(DONT, "Don't forget the forms for the meeting.").why, 'start', 'starts the sentence');
  assert.equal(f(DONT, '  "Don\'t forget the forms for the meeting."').why, 'start', 'starts the sentence after a quote');
  assert.equal(f(DONT, "I don't think dont is how you spell it.").why, 'rules', 'the wrong form elsewhere');
  assert.equal(f(DONT, "I don't <b>think</b> so at all today.").why, 'rules', 'markup');
  assert.equal(f(DONT, "I don't ___ think so at all today.").why, 'rules', 'a blank written by the AI');
  assert.equal(f({ from: 'it', to: 'it', kind: 'spelling' }, "It's here and it works fine now.").why, 'rules', 'from equals to');
  assert.equal(f({ from: 'tho', to: 'it', kind: 'spelling' }, "Please send it's details to the team today.").why, 'count', "\"it\" inside \"it's\" isn't the word");
  assert.equal(f({ from: 'alot', to: 'a lot', kind: 'spelling' }, 'We laughed a  lot at the party last night.').q.filled, 'We laughed a lot at the party last night.', 'multi-word');
  assert.equal(f(FRI, 'See you on friday after the meeting.').why, 'count', 'capitalization: case counts');
  assert.ok(f({ from: 'i', to: 'I', kind: 'capitalization' }, 'I will send the notes after lunch.').q, 'a capital answer may start it');

  const q = (t, s) => SR_questionFrom(t, s);
  assert.equal(q(DONT, "I don't think the meeting moved today."), null, 'no blank');
  assert.equal(q(DONT, 'I ___ think we ___ have time today.'), null, 'two blanks');
  assert.equal(q(DONT, 'I ___ think dont is how you spell it.'), null, 'the wrong form already elsewhere');
  assert.equal(q(DONT, "I ___ think don't is how you spell it."), null, 'the answer already elsewhere');
  assert.equal(q(DONT, '___ worry about the meeting this week.'), null, 'a lowercase answer starting the sentence');
  const ok = q(THEY, 'I think ____ coming to the party later.');
  assert.ok(ok, 'any run of underscores is the blank');
  assert.equal(ok.sentence, 'I think ___ coming to the party later.');
  assert.equal(ok.filled, "I think they're coming to the party later.");
  assert.equal(ok.spot, 'I think their coming to the party later.', 'spot is built by code: the wrong form in the blank');
  // Spot always holds the wrong form exactly once, across awkward pairs.
  const pairs = [THEY, DONT, RECV, FRI, { from: 'should of', to: 'should have', kind: 'grammar' }, { from: 'alot', to: 'a lot', kind: 'spelling' }, { from: 'can not', to: 'cannot', kind: 'spelling' }, { from: 'its', to: "it's", kind: 'apostrophe' }];
  const frames = ['We ___ not go there today at all.', 'Most of ___ time it works for us.', 'I said ___ and its fine for now.', 'They ___ should of known about it.', 'The plan is ___ alot better than before.', 'See you ___ on the call later today.'];
  let made = 0;
  for (const t of pairs) for (const fr of frames) {
    const x = q(t, fr);
    if (!x) continue;
    made++;
    const keep = t.kind === 'capitalization';
    const words = (str) => SR_diffTokens(keep ? str : str.toLowerCase()).filter((w) => /\p{L}/u.test(w));
    const hay = words(x.spot), nd = words(t.from);
    assert.equal(hay.filter((_, i) => nd.every((w, j) => hay[i + j] === w)).length, 1, `spot once: ${x.spot}`);
  }
  assert.ok(made >= 20, `enough sentences made it through: ${made}`);
  assert.deepEqual([...SR_practiceChoices(THEY, 0)].sort(), ['their', 'there', "they're"].sort(), 'choices come from code alone');
}

// === R3: stage A (rules) then stage B (Proofread) ===
{
  // Real Nano output from the batch-blank design, now as full sentences.
  const batch = json(
    item("don't", "Why don't you worried about the upcoming school dance?"), // wrong English, Proofread fixes it
    item("don't", "We don't need the slides until the meeting starts."),
    item('receive', 'Please let me know when you receive the forms.'),
    item('receive', 'We receive and receive the same forms each week.'), // stage A: the word twice
  );
  const prompts = [];
  const generate = async (parts) => { prompts.push(parts); return batch; };
  // A stand-in Proofread that fixes "don't you worried" and leaves the rest alone.
  const proofreads = [];
  const proofread = async (text) => { proofreads.push(text); return text.replace(/don't you worried/g, "aren't you worried"); };
  const items = SR_practiceItems([DONT, RECV], 4, 0);
  const out = await SR_makeQuestions(items, { generate, proofread });
  assert.equal(prompts.length, 1, 'providers: one generate call');
  assert.equal(proofreads.length, 1, 'providers: one Proofread call for the whole batch');
  assert.equal(proofreads[0].split('\n').length, 3, 'stage A dropped the bad item before the check');
  assert.deepEqual(out.questions.map((q) => q.filled), ["We don't need the slides until the meeting starts.", 'Please let me know when you receive the forms.'], 'what Proofread changed is dropped');
  assert.ok(out.questions.every((q) => q.checked === true));
  assert.deepEqual(out.drops, { count: 1, check: 1 });
  // A final period is not a change; a misaligned reply drops the whole batch.
  const two = SR_parseQuestions(batch, [DONT, RECV]).slice(1, 3);
  assert.equal(SR_checkedQuestions(two, SR_checkText(two).replace(/\.$/gm, '')).length, 2, 'a dropped final period is fine');
  assert.equal(SR_checkedQuestions(two, `Here you go:\n${SR_checkText(two)}`).length, 0, 'chatter: misaligned');
  assert.equal(SR_checkedQuestions(two, SR_checkText(two).split('\n')[0]).length, 0, 'a missing line drops the batch');
  assert.equal(SR_checkedQuestions(two, SR_checkText(two).replace(/\n/, ' ')).length, 0, 'merged lines drop the batch');
  // No checker available: stage A only, marked unchecked.
  const unchecked = await SR_makeQuestions(items, { generate });
  assert.equal(unchecked.questions.length, 3);
  assert.ok(unchecked.questions.every((q) => q.checked === false));

  // On-device: one sentence per item, each proofread on its own; the bad one drops.
  // items cycle don't, receive, don't, receive.
  const replies = ["Why don't you worried about the upcoming school dance?", 'Please let me know when you receive the forms.\nExtra line.', "Don't forget the forms for the meeting.", 'We receive the new slides before every meeting.'];
  const asked = [], checked = [];
  const each = await SR_makeQuestionsEach(items, {
    write: async (it) => { asked.push(`${it.to}/${it.topic}`); return replies[asked.length - 1]; },
    proofread: async (text) => { checked.push(text); return text.replace(/don't you worried/g, "aren't you worried"); },
  });
  assert.equal(asked.length, 4, 'one request per item');
  assert.equal(new Set(asked).size, 4, 'each with its own word+topic');
  assert.equal(checked.length, 3, 'stage B per sentence, after stage A');
  assert.deepEqual(each.questions.map((q) => q.filled), ['Please let me know when you receive the forms.', 'We receive the new slides before every meeting.'], 'first line only; what Proofread changed is dropped');
  assert.deepEqual(each.drops, { check: 1, start: 1 }, 'drop reasons, including starting with the word');
  assert.ok(each.questions.every((q) => q.checked === true));
}

// === R5: never repeat unless missed ===
{
  const a = SR_practiceFingerprint('I ___ think so today.', "don't");
  assert.match(a, /^[0-9a-f]{8}$/, 'a short hash, not the text');
  assert.equal(a, SR_practiceFingerprint('i  ___ think so, today', "Don’t"), 'normalized');
  assert.notEqual(a, SR_practiceFingerprint('I ___ think so today.', 'do'));
  // The same sentence twice in one reply, and again in a later batch: served once.
  const s = item("don't", "I don't think the meeting moved today.");
  const pool = SR_practicePoolRead(null);
  const seen = new Set();
  const dup = SR_parseQuestions(json(s, s), [DONT]);
  assert.equal(dup.length, 1, 'a duplicate in one reply is parsed once (not checked twice)');
  assert.equal(dup.drops.repeat, 1);
  SR_practicePoolAdd(pool, SR_parseQuestions(json(s, s), [DONT]), seen);
  assert.equal(pool.words["don't"].length, 1, 'a duplicate in one reply is kept once');
  const first = SR_poolTake(pool, DONT, seen);
  assert.ok(first);
  seen.add(SR_questionPrint(first));
  const again = await SR_makeQuestions([{ ...DONT, topic: 'shopping' }], { generate: async () => json(s), seen });
  assert.equal(again.questions.length, 0, 'a seen sentence is skipped at generation');
  assert.equal(again.drops.seen, 1);
  const againDev = await SR_makeQuestionsEach([{ ...DONT, topic: 'shopping' }, { ...DONT, topic: 'the weather' }], { write: async () => s.sentence, seen });
  assert.equal(againDev.questions.length, 0, 'on-device too, and the same sentence twice in one refill');
  const twice = await SR_makeQuestionsEach([{ ...DONT, topic: 'shopping' }, { ...DONT, topic: 'the weather' }], { write: async () => 'We don’t need it until the end of the week.' });
  assert.equal(twice.questions.length, 1, 'the same sentence twice in one on-device refill is kept once');
  assert.ok(seen.size === 1, 'the caller\'s seen set is not changed by a refill');
  SR_practicePoolAdd(pool, SR_parseQuestions(json(s), [DONT]), seen);
  assert.equal(SR_poolTake(pool, DONT, seen), null, 'and at the pool');
  // Served-time skip too (it was waiting before it was seen).
  const p2 = SR_practicePoolRead({ v: 2, words: { "don't": [{ s: first.sentence, c: true }, { s: 'We ___ need it until the end of the week.', c: true }] } });
  assert.equal(SR_poolTake(p2, DONT, seen).filled, "We don't need it until the end of the week.", 'serve time skips a seen one');
  // Bounded: 2000 fingerprints, oldest dropped.
  let list = [];
  for (let i = 0; i < 2100; i++) list = SR_addSeen(list, [i.toString(16).padStart(8, '0')]);
  assert.equal(list.length, 2000);
  assert.equal(list[0], (100).toString(16).padStart(8, '0'));
  assert.deepEqual(SR_addSeen(['junk', '0000000a'], ['0000000a']), ['0000000a']);
  // A miss comes back 3 to 5 questions later, clamped to the round.
  for (const r of [0, 0.5, 0.99]) {
    const at = SR_requeueAt(1, 8, () => r);
    assert.ok(at - 1 >= 3 && at - 1 <= 5, `3-5 later: ${at}`);
  }
  assert.equal(SR_requeueAt(7, 8, () => 0.99), 8, 'at most the end of the round');
  // With no AI question waiting, the retry's template is a sentence not shown this round.
  const t1 = SR_freshTemplate(RECV, 5, new Set());
  const t2 = SR_freshTemplate(RECV, 5, new Set([t1.print]));
  const text = (x) => x.q.tokens.map((t) => t.text).join(' ');
  assert.equal(t1.q.source, 'template');
  assert.notEqual(text(t2), text(t1), 'a different template sentence on the retry');
  assert.notEqual(t2.print, t1.print);
  // Right on the retry: the word still comes early next session.
  const st = SR_mergePracticeStats({}, [{ from: 'dont', to: "don't", right: false }, { from: 'dont', to: "don't", right: true, again: true }], 1);
  assert.equal(st["dont→don't"].wrongLast, true, 'a retry does not clear the miss');
  const plan = SR_practicePlan({ working: [{ from: 'teh', to: 'the', n: 9, kind: 'spelling' }, { ...DONT, n: 2 }] }, st, 2, 2);
  assert.equal(plan[0].to, "don't", 'missed word first next session');
}

// === No giveaways: a sentence never shows a later word's fix ===
{
  const TMRW = { from: 'tomorow', to: 'tomorrow', kind: 'spelling' };
  const FRIDAY = { from: 'friday', to: 'Friday', kind: 'capitalization' };
  assert.ok(SR_givesAway('We should ___ clear skies tomorrow after the rain.', RECV, [TMRW]));
  assert.ok(!SR_givesAway('We should ___ clear skies tomorow after the rain.', RECV, [TMRW]), 'the wrong form is no giveaway');
  assert.ok(SR_givesAway('Please submit ___ report by Friday.', DONT, [FRIDAY]));
  assert.ok(!SR_givesAway('Please submit ___ report by friday.', DONT, [FRIDAY]), 'capitalization: case counts');
  assert.ok(!SR_givesAway('We should ___ clear skies tomorrow.', RECV, []), 'nothing later');
  assert.ok(!SR_givesAway('We should ___ it, so they’re told.', RECV, [{ from: 'their', to: 'there', kind: 'grammar' }]), 'whole words only');
  // The pool skips a giveaway now and keeps it for later; the clean one is served.
  const leak = 'We should ___ clear skies tomorrow after the rain.', clean = 'Please let me know when you ___ the forms.';
  const pool = SR_practicePoolRead({ v: 2, words: { receive: [{ s: leak, c: true }, { s: clean, c: true }] } });
  assert.equal(SR_poolTake(pool, RECV, new Set(), [TMRW]).sentence, clean, 'served: the clean one');
  assert.deepEqual(pool.words.receive, [{ s: leak, c: true }], 'the giveaway waits in the pool');
  assert.equal(SR_poolTake(pool, RECV, new Set(), [TMRW]), null, 'only a giveaway left: none (a template is used)');
  assert.equal(SR_poolTake(pool, RECV, new Set(), []).sentence, leak, 'served once tomorrow is no longer to come');
  // Templates: "For tomorrow: ..." is skipped while "tomorrow" is still to come.
  for (let seed = 0; seed < 6; seed++) {
    const x = SR_freshTemplate(RECV, seed, new Set(), [TMRW]);
    const text = x.q.tokens.map((t) => t.text).join(' ');
    assert.ok(!/tomorrow/i.test(text), `template gives nothing away: ${text}`);
  }
  // An opener word still to come: "Quick update: ..." is skipped while "update" is.
  const UPD = { from: 'updaet', to: 'update', kind: 'spelling' };
  for (let seed = 0; seed < 6; seed++) assert.ok(!/update/i.test(SR_freshTemplate(RECV, seed, new Set(), [UPD]).q.tokens.map((t) => t.text).join(' ')));
  assert.ok([0, 1, 2].some((seed) => /update/i.test(SR_freshTemplate(RECV, seed, new Set()).q.tokens.map((t) => t.text).join(' '))), 'control: an opener does hold "update"');
}

// === Pool v2: shape, migration, caps ===
{
  assert.deepEqual(SR_practicePoolRead({ "don't": ["I don't think so."] }), { v: 2, words: {} }, 'the v1 shape is dropped');
  assert.deepEqual(SR_practicePoolRead('junk'), { v: 2, words: {} });
  const pool = SR_practicePoolRead({ v: 2, words: { x: [{ s: 1 }, null, { s: 'ok ___ fine.', c: 1 }] } });
  assert.deepEqual(pool.words.x, [{ s: 'ok ___ fine.', c: true }]);
  const many = SR_practicePoolRead(null);
  const ws = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
  for (let i = 0; i < 70; i++) {
    const t = { from: `w${i}x`, to: `w${i}`, kind: 'spelling' };
    SR_practicePoolAdd(many, ws.map((w) => SR_questionFrom(t, `We said ___ to ${w} again.`)).filter(Boolean), new Set());
  }
  assert.equal(Object.keys(many.words).length, 60, 'words capped');
  assert.ok(Object.values(many.words).every((l) => l.length === 6), 'per word capped');
  assert.ok(many.words.w69 && !many.words.w0, 'the newest words kept');
  assert.ok(!JSON.stringify(many).includes('wrong'), 'no stats in the pool');
}

// === R6: word levels ===
{
  let st = { level: 1, streak: 0 };
  const step = (right, served) => { st = SR_practiceLevelStep(st, right, served); return st.level; };
  assert.equal(step(true), 1, 'one right: not yet');
  assert.equal(step(true), 2, 'two in a row: up');
  assert.equal(step(true), 2);
  assert.equal(step(false), 1, 'a miss: down, streak reset');
  assert.equal(step(true), 1);
  assert.equal(step(false), 1, 'never below 1');
  st = { level: 4, streak: 1 };
  assert.equal(step(true), 4, 'never above 4');
  st = { level: 3, streak: 0 };
  assert.equal(step(true, 2), 3, 'asked below the level: does not count');
  assert.equal(step(true, 2), 3);
  assert.equal(step(true, 4), 3, 'asked above it: counts');
  assert.equal(step(true, 3), 4);
  assert.equal(step(false, 4), 3, 'a miss asked above: one down, not more');
  assert.equal(SR_practiceLevel('junk'), 1);
  assert.equal(SR_practiceLevel(9), 4);
  // Persisted through the stats merge.
  const stats = SR_mergePracticeStats({}, [{ from: 'dont', to: "don't", right: true, served: 1 }, { from: 'dont', to: "don't", right: true, served: 1 }], 1);
  assert.equal(stats["dont→don't"].level, 2);
  assert.equal(SR_mergePracticeStats(stats, [{ from: 'dont', to: "don't", right: false, served: 2 }], 2)["dont→don't"].level, 1);
  assert.equal(SR_mergePracticeStats({ 'a→b': { seen: 1, right: 1, last: 1 } }, [], 1)['a→b'].level, 1, 'old stats start at level 1');
  // Typed answers.
  assert.ok(SR_typedRight("  don’t ", DONT), 'trim, curly apostrophe');
  assert.ok(SR_typedRight("Don't", DONT), 'case-free for non-capitalization');
  assert.ok(!SR_typedRight('dont', DONT));
  assert.ok(!SR_typedRight('', DONT));
  assert.ok(SR_typedRight('Friday', FRI));
  assert.ok(!SR_typedRight('friday', FRI), 'case counts for capitalization');
  assert.ok(SR_typedRight('should   have', { from: 'should of', to: 'should have', kind: 'grammar' }));
}

// === R7: about 80% right ===
{
  const run = (pattern) => Array.from({ length: 10 }, (_, i) => pattern(i));
  assert.equal(SR_servedLevel(2, run(() => true)), 3, 'all right: one harder');
  assert.equal(SR_servedLevel(4, run(() => true)), 4, 'max 4');
  assert.equal(SR_servedLevel(2, run((i) => i % 2 === 0)), 1, '50%: one easier');
  assert.equal(SR_servedLevel(1, run(() => false)), 1, 'min 1');
  assert.equal(SR_servedLevel(2, run((i) => i !== 3 && i !== 7)), 2, '80%: as is');
  assert.equal(SR_servedLevel(2, run((i) => i !== 3)), 2, '90% is not above 90%');
  assert.equal(SR_servedLevel(2, [true, true, true]), 2, 'too few answers to judge');
  assert.equal(SR_servedLevel(2, [...run(() => false), ...run(() => true)]), 3, 'only the last 10 count');
}

// === F: where the answer sits ===
{
  let seed = 7;
  const rand = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
  const pick = (n, k) => { const h = []; for (let i = 0; i < k; i++) h.push(SR_answerSlot(n, h, rand)); return h; };
  const two = pick(2, 300);
  assert.ok(two.every((p, i) => i < 2 || !(p === two[i - 1] && p === two[i - 2])), 'with 2: never 3 times running');
  const alternates = two.every((p, i) => i === 0 || p !== two[i - 1]);
  assert.ok(!alternates, 'with 2: not a strict A/B/A/B');
  const repeats = two.filter((p, i) => i && p === two[i - 1]).length;
  assert.ok(repeats > 50, `with 2: the same slot twice happens (${repeats}/299)`);
  const three = pick(3, 300);
  assert.ok(three.every((p, i) => i === 0 || p !== three[i - 1]), 'with 3: never the same twice');
  assert.deepEqual(new Set(three).size, 3);
}

// === R8: the daily provider budget ===
{
  const today = '2026-10-20';
  let day = null;
  let calls = 0;
  for (let i = 0; i < 30; i++) { const b = SR_practiceBudget(day, today, 2); if (b.ok) { calls += 2; day = b.next; } }
  assert.equal(calls, 40, 'stops at 40 calls a day');
  assert.equal(SR_practiceBudget({ date: '2026-10-19', count: 40 }, today, 2).ok, true, 'a new day resets it');
  assert.equal(SR_practiceBudget({ date: today, count: 'x' }, today, 2).next.count, 2, 'junk counts as 0');
}

console.log('practice-engine: all checks passed');
