// Stubbed Prompt API check for on-device language handling (CfT and most CI
// machines have no Gemini Nano, so this is the check that can fail):
//   node test/device-langs.mjs
// The stub behaves like Chrome for Testing 155, which accepts only en/es/ja.
import fs from 'node:fs';
import assert from 'node:assert/strict';

globalThis.self = globalThis;
new Function(fs.readFileSync(process.env.CONSTANTS || new URL('../constants.js', import.meta.url), 'utf8'))();

const SUPPORTED = ['en', 'es', 'ja'];
const calls = [];
globalThis.LanguageModel = {
  async availability(opts) { calls.push(['availability', opts]); return 'available'; },
  async create(opts) {
    calls.push(['create', opts]);
    const langs = [...opts.expectedInputs[0].languages, ...opts.expectedOutputs[0].languages];
    if (!langs.every((l) => SUPPORTED.includes(l))) {
      const e = new Error(`Unsupported LanguageModel API languages were specified. [${SUPPORTED.join(', ')}]`);
      e.name = 'NotSupportedError';
      throw e;
    }
    return { prompt: async () => 'stub output', destroy() {} };
  },
};

assert.equal(await SR_deviceAvailability(), 'available');
assert.deepEqual(calls[0][1].expectedInputs[0].languages, ['en'], 'availability asks about English only');

calls.length = 0;
assert.equal(await SR_rewriteOnDevice('teh text', 'grammar'), 'stub output');
assert.deepEqual(calls.at(-1)[1].expectedInputs[0].languages, ['en'], 'falls back to English input after a language rejection');

assert.equal(await SR_rewriteOnDevice('hello', 'translate', null, 'es'), 'stub output');

await assert.rejects(SR_rewriteOnDevice('hello', 'translate', null, 'fr'), /French isn't supported by Chrome's on-device model here/);

// On Auto with a cloud key, the on-device rejection falls through to the cloud.
const cloudCalls = [];
globalThis.fetch = async (url, init) => {
  cloudCalls.push(JSON.parse(init.body));
  return { ok: true, json: async () => ({ choices: [{ message: { content: 'cloud output' } }] }) };
};
const provider = { id: 'groq', displayName: 'Groq', baseURL: 'https://x/v1', model: 'm', apiKey: 'k' };
const out = await SR_rewriteAuto('hello', 'translate', { provider, engine: 'auto', targetLang: 'fr' });
assert.deepEqual(out, { text: 'cloud output', provider: 'groq' });
assert.match(cloudCalls[0].messages[0].content, /into French\./);

console.log('device-langs: all checks passed');
