// Hover "Ask about this…" uses the same engines as the other actions:
// on-device first on Auto, else the provider. No browser: a stand-in
// LanguageModel records what Ask sends it.
//   node test/ask-device.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';

globalThis.self = globalThis;
new Function(fs.readFileSync(process.env.CONSTANTS || new URL('../constants.js', import.meta.url), 'utf8'))();

const provider = { id: 'groq', displayName: 'Groq', baseURL: 'https://api.groq.com/openai/v1', apiKey: 'gsk-test-0000000000000000', model: 'llama' };
let cloudCalls = 0;
globalThis.fetch = async () => { cloudCalls++; return { ok: true, json: async () => ({ choices: [{ message: { content: 'From the cloud.' }, finish_reason: 'stop' }] }) }; };

// mode: 'ok' answers; 'fail' throws on prompt; inline: create() rejects initialPrompts.
function fakeModel({ mode = 'ok', inline = false } = {}) {
  const seen = { creates: [], prompts: [], destroyed: 0 };
  globalThis.LanguageModel = {
    async availability() { return 'available'; },
    async create(opts) {
      if (inline && opts.initialPrompts) throw new Error('initialPrompts not supported');
      seen.creates.push(opts);
      return {
        async prompt(p) { seen.prompts.push(String(p)); if (mode === 'fail') throw new Error('model broke'); return 'The key has no limits.'; },
        destroy() { seen.destroyed++; },
      };
    },
  };
  return seen;
}
const page = 'A key was issued for credential "groq" named "proofr", with no limits.';

// 1. Auto with on-device AI: answered on this computer, no cloud call, the
// instruction in the rules and the page text fenced in the request.
{
  cloudCalls = 0;
  const seen = fakeModel();
  const r = await SR_askAuto(page, 'What does this mean?', { provider, engine: 'auto' });
  assert.deepEqual(r, { text: 'The key has no limits.', provider: 'device', engine: 'Gemini Nano' });
  assert.equal(cloudCalls, 0, 'nothing sent to the provider');
  const sys = seen.creates[0].initialPrompts[0].content;
  assert.match(sys, /Apply this instruction to the text: What does this mean\?/);
  assert.ok(!sys.includes(page), 'the page text is not in the rules');
  assert.match(seen.prompts[0], /<text-[0-9a-f]{12}>\n[\s\S]*named "proofr"/, 'the page text is fenced');
  assert.equal(seen.destroyed, 1, 'the session is freed');
}

// 2. A build without initialPrompts: the whole prompt goes in the request.
{
  const seen = fakeModel({ inline: true });
  await SR_askAuto(page, 'Summarize', { provider, engine: 'auto' });
  assert.match(seen.prompts[0], /Apply this instruction to the text: Summarize[\s\S]*<text-[0-9a-f]{12}>/);
}

// 3. On-device fails on Auto with a provider: the provider answers.
{
  cloudCalls = 0;
  fakeModel({ mode: 'fail' });
  const r = await SR_askAuto(page, 'Summarize', { provider, engine: 'auto' });
  assert.deepEqual(r, { text: 'From the cloud.', provider: 'groq' });
  assert.equal(cloudCalls, 1);
}

// 4. On-device fails with nothing to fall back to, or "On-device only": the error shows.
{
  fakeModel({ mode: 'fail' });
  await assert.rejects(SR_askAuto(page, 'Summarize', { provider: {}, engine: 'auto' }), /model broke/);
  cloudCalls = 0;
  await assert.rejects(SR_askAuto(page, 'Summarize', { provider, engine: 'device' }), /model broke/);
  assert.equal(cloudCalls, 0, 'On-device only never falls back to the cloud');
}

// 5. "Cloud only": never touches the on-device model.
{
  cloudCalls = 0;
  const seen = fakeModel();
  const r = await SR_askAuto(page, 'Summarize', { provider, engine: 'cloud' });
  assert.equal(r.provider, 'groq');
  assert.equal(seen.creates.length, 0);
  assert.equal(cloudCalls, 1);
}

// 6. Too long for on-device: says so instead of trying.
{
  const seen = fakeModel();
  await assert.rejects(SR_askOnDevice('x'.repeat(4001), 'Summarize'), /too long for the on-device model/);
  assert.equal(seen.creates.length, 0);
}

// 7. A reply that leaks the rules is refused on-device too.
{
  globalThis.LanguageModel = {
    async availability() { return 'available'; },
    async create(opts) { const sys = opts.initialPrompts[0].content; return { async prompt() { return sys; }, destroy() {} }; },
  };
  await assert.rejects(SR_askOnDevice(page, 'Summarize'), (e) => e.name === 'SuspectOutput');
}

console.log('ask-device: all checks passed');
