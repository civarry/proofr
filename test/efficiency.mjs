// What Proofr spends of the user's own AI (bring-your-own key), and that tips
// shown are grounded in the user's list:
//   node test/efficiency.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';

globalThis.self = globalThis;
new Function(fs.readFileSync(process.env.CONSTANTS || new URL('../constants.js', import.meta.url), 'utf8'))();

// 1. Instructions stay small: a 4-word proofread must not cost hundreds of
// tokens of boilerplate. ~4 chars per token; 1.3.0 sent ~1,300 chars.
for (const tone of ['grammar', 'professional', 'friendly', 'tldr', 'translate']) {
  const p = SR_buildPromptParts('teh report are ready', tone, 'es');
  const overhead = p.system.length + p.user.length - 'teh report are ready'.length;
  assert.ok(overhead <= 1000, `${tone}: ${overhead} chars of instructions (limit 1000)`);
}
{
  const a = SR_buildAskParts('x', 'What is the main point?');
  assert.ok(a.system.length + a.user.length <= 700, `ask: ${a.system.length + a.user.length} chars`);
}

// 2. The answer budget fits the input: small for short text, enough for long
// text (1.3.0 used a flat 1000, which cut off long selections).
assert.equal(typeof SR_maxTokens, 'function', 'SR_maxTokens is exported');
assert.ok(SR_maxTokens('teh report are ready', 'grammar') <= 300, 'short proofread gets a small budget');
assert.ok(SR_maxTokens('word '.repeat(800), 'grammar') >= 1400, 'a 4000-char proofread can finish');
assert.ok(SR_maxTokens('word '.repeat(800), 'tldr') <= 400, 'a summary is short whatever the input');
assert.ok(SR_maxTokens('猫'.repeat(10) + ' hello there friend '.repeat(50), 'translate', 'ja') >= SR_maxTokens(' hello there friend '.repeat(50), 'grammar'), 'translation into Japanese gets room to grow');
for (const n of [0, 10, 100, 4000, 20000]) {
  const t = SR_maxTokens('a'.repeat(n), 'grammar');
  assert.ok(Number.isInteger(t) && t >= 200 && t <= 4000, `budget for ${n} chars is ${t}`);
}

// The cloud call uses that budget.
{
  let body;
  globalThis.fetch = async (_u, init) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ choices: [{ message: { content: 'The report is ready.' }, finish_reason: 'stop' }] }) }; };
  const provider = { id: 'openai', displayName: 'OpenAI', baseURL: 'https://api.openai.com/v1', apiKey: 'sk-test-0000000000000000', model: 'gpt-4o-mini' };
  await SR_rewrite(provider, 'teh report are ready', 'grammar', 'en');
  assert.equal(body.max_tokens, SR_maxTokens('teh report are ready', 'grammar'));
}

// 3. Tips: one per word, as "word | tip" lines. A tip survives only when its
// word is one of the user's, it names that word, and every word it quotes is
// theirs (a made-up example is dropped). The rest of the words just get none.
assert.equal(typeof SR_checkTips, 'function', 'SR_checkTips is exported');
const pairs = [{ from: 'dont', to: "don't", n: 5 }, { from: 'recieve', to: 'receive', n: 3 }];
{
  const reply = [
    '1. don\'t | You often write "dont": the apostrophe stands for the missing o in "do not".',
    '- receive | Remember i before e except after c, as in receive.',
    'affect | Watch affect and effect in formal writing.',
  ].join('\n');
  const tips = SR_checkTips(reply, pairs);
  assert.deepEqual(Object.keys(tips).sort(), ["don't", 'receive'], JSON.stringify(tips));
  assert.ok(Object.values(tips).every((t) => !/^\d|\|/.test(t)), 'numbering and the word column removed');
}
assert.deepEqual(SR_checkTips("don't | Proofread carefully.\nreceive | Read it aloud.", pairs), {}, 'a tip that never names its word is dropped');
assert.deepEqual(SR_checkTips('', pairs), {});
assert.deepEqual(SR_checkTips('1. Proofread carefully.\n2. Read it aloud.', pairs), {}, 'lines without a word column are dropped');
assert.deepEqual(SR_checkTips('don\'t | Like dont, you also wrote "cant" without its apostrophe.', pairs), {}, 'an example they never wrote is dropped');
assert.deepEqual(SR_checkTips("don't | dont needs it.\ndon't | Write don't, a second time.", pairs), { "don't": 'dont needs it.' }, 'one tip per word, the first');
assert.ok(SR_checkTips('dont | Write dont as don\'t.', pairs)["don't"], 'the wrong form names the row too');
// A quoted phrase (a rule, not an example) is fine as long as the tip names their word.
assert.ok(SR_checkTips('don\'t | Write "do not" as don\'t, never dont.', pairs)["don't"]);
{
  const many = Array.from({ length: 9 }, (_, i) => ({ from: `w${i}x`, to: `w${i}`, n: 2 }));
  assert.equal(Object.keys(SR_checkTips(many.map((p) => `${p.to} | Spell ${p.to} right.`).join('\n'), many)).length, SR_TIPS_MAX, 'at most 6');
}

console.log('efficiency: all checks passed');
