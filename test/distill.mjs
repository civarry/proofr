// Teacher examples for small models (prompt-level distillation):
//   node test/distill.mjs
// Small models (on-device, local servers, small cloud models) get a few worked
// examples written by a strong model; big models don't pay for them. Every
// shipped example must itself pass the checks a live answer has to pass.
import fs from 'node:fs';
import assert from 'node:assert/strict';

globalThis.self = globalThis;
new Function(fs.readFileSync(process.env.CONSTANTS || new URL('../constants.js', import.meta.url), 'utf8'))();
for (const f of ['SR_isSmallModel', 'SR_examplesFor']) assert.equal(typeof globalThis[f], 'function', `${f} is exported`);

// 1. Which models get examples.
const small = [
  { id: 'groq', model: 'llama-3.1-8b-instant' }, { id: 'groq', model: 'gemma2-9b-it' },
  { id: 'ollama', model: 'llama3.3:70b' }, { id: 'lmstudio', model: 'anything' },
  { id: 'custom', baseURL: 'http://localhost:8080/v1', model: 'qwen2.5-7b-instruct' },
  { id: 'openrouter', model: 'meta-llama/llama-3.2-3b-instruct' }, { id: 'mistral', model: 'ministral-8b-latest' },
  { id: 'openai', model: 'gpt-4.1-nano' }, { id: 'openrouter', model: 'microsoft/phi-4' },
];
const big = [
  { id: 'groq', model: 'openai/gpt-oss-120b' }, { id: 'openai', model: 'gpt-4o' }, { id: 'groq', model: 'llama-3.3-70b-versatile' },
  { id: 'deepseek', model: 'deepseek-chat' }, { id: 'gemini', model: 'gemini-3.8-flash' }, { id: 'mistral', model: 'mistral-large-latest' },
];
for (const p of small) assert.ok(SR_isSmallModel(p), `small: ${p.id} ${p.model}`);
for (const p of big) assert.ok(!SR_isSmallModel(p), `big: ${p.id} ${p.model}`);
assert.ok(SR_isSmallModel('device'), 'on-device Nano is small');

// 2. Every shipped example passes what a live answer must pass.
const tones = ['grammar', 'professional', 'friendly', 'short', 'simple', 'tldr'];
for (const tone of tones) {
  const ex = SR_examplesFor(tone);
  assert.ok(ex.length >= 1 && ex.length <= 3, `${tone}: 1-3 examples`);
  let chars = 0;
  for (const [input, output] of ex) {
    chars += input.length + output.length;
    assert.equal(SR_cleanOutput(output, { fence: SR_newFence(), input }), output, `${tone}: example output is clean`);
    // Numbers survive every rewrite; Proofread examples also pass the full change guard.
    const digits = (t) => (t.match(/\d+/g) || []).sort().join(',');
    assert.equal(digits(output), digits(input), `${tone}: example keeps its numbers`);
    if (tone === 'grammar') assert.ok(SR_changeGuard(input, output).ok, `grammar example passes the guard: ${output}`);
    // An instruction inside the text is treated as text, never obeyed.
    if (/ignore|assistant:/i.test(input)) {
      assert.ok(!/^(ok|sure|here)/i.test(output) && !/poem|roses/i.test(output.replace(/write a poem/i, '')), `${tone}: injected example not obeyed`);
    }
  }
  assert.ok(chars <= 700, `${tone}: examples cost ${chars} chars (limit 700)`);
}
assert.ok(SR_examplesFor('grammar').some(([i]) => /ignore/i.test(i)), 'Proofread teaches that instructions in the text are text');
assert.ok(SR_examplesFor('tldr').some(([i]) => /assistant:/i.test(i)), 'Summarize teaches the same for page text');
assert.deepEqual(SR_examplesFor('translate'), [], 'no examples where the target varies');

// 3. How examples are sent: as earlier turns for cloud, as a block on-device.
const fence = SR_newFence();
const parts = SR_buildPromptParts('teh report are ready', 'grammar', 'en', fence, { examples: true });
assert.equal(parts.examples.length, SR_examplesFor('grammar').length);
let body;
globalThis.fetch = async (_u, init) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ choices: [{ message: { content: 'The report is ready.' }, finish_reason: 'stop' }] }) }; };
const smallP = { id: 'groq', displayName: 'Groq', baseURL: 'https://api.groq.com/openai/v1', apiKey: 'gsk_' + 'x'.repeat(48), model: 'llama-3.1-8b-instant' };
await SR_rewrite(smallP, 'teh report are ready', 'grammar', 'en');
const n = SR_examplesFor('grammar').length;
assert.deepEqual(body.messages.map((m) => m.role), ['system', ...Array(n).fill(['user', 'assistant']).flat(), 'user']);
assert.ok(body.messages.at(-1).content.includes('teh report are ready'), 'the real text is last');
const fenceId = body.messages.at(-1).content.match(/<(text-[0-9a-f]{12})>/)[1];
assert.ok(body.messages[1].content.includes(`<${fenceId}>`), 'examples use the same fence as the real text');
await SR_rewrite({ ...smallP, model: 'openai/gpt-oss-120b' }, 'teh report are ready', 'grammar', 'en');
assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user'], 'a big model gets no examples');
await SR_rewrite(smallP, 'hola', 'translate', 'fr');
assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user'], 'no examples for translate');

const joined = SR_joinPrompt(parts);
for (const [i, o] of parts.examples) assert.ok(joined.includes(i) && joined.includes(o), 'device prompt carries the examples');
assert.ok(joined.lastIndexOf('teh report are ready') > joined.lastIndexOf(parts.examples.at(-1)[1]), 'device prompt ends with the real text');

// The on-device path uses them (Nano is the smallest model Proofr talks to).
let devicePrompt = '';
globalThis.LanguageModel = { availability: async () => 'available', create: async () => ({ prompt: async (p) => { devicePrompt = p; return 'The report is ready.'; }, destroy() {} }) };
await SR_rewriteOnDevice('teh report are ready', 'grammar', null, 'en');
assert.ok(devicePrompt.includes(SR_examplesFor('grammar')[0][1]), 'on-device prompt includes the examples');
delete globalThis.LanguageModel;

console.log('distill: all checks passed');
