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

// 3. Tips: only lines that use the user's own words survive; a line that
// quotes a word that isn't in their list (a made-up example) is dropped.
assert.equal(typeof SR_checkTips, 'function', 'SR_checkTips is exported');
const pairs = [{ from: 'dont', to: "don't", n: 5 }, { from: 'recieve', to: 'receive', n: 3 }];
{
  const reply = [
    '1. You often write "dont": the apostrophe stands for the missing o in "do not".',
    '2. Remember "i before e except after c", as in receive.',
    '3. Watch "affect" and "effect" in formal writing.',
  ].join('\n');
  const tips = SR_checkTips(reply, pairs);
  assert.equal(tips.length, 2, JSON.stringify(tips));
  assert.ok(tips.every((t) => !/affect/.test(t)), 'the tip about words they never got wrong is dropped');
  assert.ok(tips.every((t) => !/^\d\./.test(t)), 'numbering removed, the list renders its own');
}
assert.deepEqual(SR_checkTips('1. Proofread carefully.\n2. Read it aloud.', pairs), [], 'generic tips are dropped');
assert.deepEqual(SR_checkTips('', pairs), []);
assert.deepEqual(SR_checkTips('1. Like dont, you also wrote "cant" without its apostrophe.', pairs), [], 'an example they never wrote is dropped');
assert.equal(SR_checkTips('1. a\n2. dont b\n3. dont c\n4. dont d\n5. dont e', pairs).length, 3, 'at most 3');
// A quoted "rule" phrase is fine as long as the tip names their word.
assert.equal(SR_checkTips('1. Write "do not" as don\'t, never dont.', pairs).length, 1);

console.log('efficiency: all checks passed');
