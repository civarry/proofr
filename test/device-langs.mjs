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


// === Streaming, warm session, Stop ===
// A session whose promptStreaming yields `chunks` through a real ReadableStream.
let mode = 'delta';
let creates = 0;
let hang = false;
const streamOf = (chunks) => new ReadableStream({ start(c) { chunks.forEach((x) => c.enqueue(x)); c.close(); } });
globalThis.LanguageModel.create = async (opts) => {
  creates++;
  return {
    prompt: () => (hang ? new Promise(() => {}) : Promise.resolve('stub output')),
    promptStreaming: () => streamOf(mode === 'delta' ? ['The ', 'report ', 'is ready.'] : ['The ', 'The report ', 'The report is ready.']),
    destroy() {},
  };
};
for (const m of ['delta', 'cumulative']) {
  mode = m;
  SR_clearCache(); // the same text twice would come from the result cache
  const seen = [];
  const r = await SR_rewriteAuto('teh report', 'grammar', { engine: 'device', onToken: (t) => seen.push(t) });
  assert.equal(r.text, 'The report is ready.', `${m} chunks give the full text`);
  assert.deepEqual(seen, ['The ', 'The report ', 'The report is ready.'], `${m}: onToken gets the text so far`);
}
// Without onToken it doesn't stream.
assert.equal(await SR_rewriteOnDevice('x', 'grammar'), 'stub output');

// Base sessions: one per task, holding the rules; each rewrite runs on a
// clone. (Replaced 1.3.0's single-use warm session: Google's guidance is to
// clone a base rather than create() per request. test/device-perf.mjs
// measures the difference.)
SR_dropAllBases(); SR_clearCache();
let clones = 0;
const baseCreate = globalThis.LanguageModel.create;
globalThis.LanguageModel.create = async (opts) => {
  const s = await baseCreate(opts);
  s.clone = async () => { clones++; return { ...s, clone: undefined }; };
  return s;
};
creates = 0;
assert.equal(await SR_warmDevice('grammar'), true);
assert.equal(creates, 1);
await SR_rewriteOnDevice('x', 'grammar');
await SR_rewriteOnDevice('y', 'grammar');
assert.equal(creates, 1, 'rewrites reuse the warm base session');
assert.equal(clones, 2, 'each rewrite runs on its own clone');
// Different options (Professional has another temperature) get their own base.
await SR_rewriteOnDevice('x', 'professional');
assert.equal(creates, 2);
SR_dropAllBases();
// Never warms (or downloads) unless the model is already available.
const avail = globalThis.LanguageModel.availability;
globalThis.LanguageModel.availability = async () => 'downloadable';
creates = 0;
assert.equal(await SR_warmDevice('friendly'), false);
assert.equal(creates, 0);
globalThis.LanguageModel.availability = avail;

// Stop: a hung prompt rejects with AbortError and does not fall through to the cloud.
hang = true;
cloudCalls.length = 0;
const ctrl = new AbortController();
const pending = SR_rewriteAuto('hello', 'grammar', { provider, engine: 'auto', signal: ctrl.signal });
setTimeout(() => ctrl.abort(), 20);
await assert.rejects(pending, (e) => e.name === 'AbortError');
assert.equal(cloudCalls.length, 0, 'stopped on-device does not retry on the cloud');
hang = false;
// Stop on the cloud path too.
globalThis.fetch = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
const c2 = new AbortController();
const cloudPending = SR_rewriteAuto('hello', 'grammar', { provider, engine: 'cloud', signal: c2.signal });
setTimeout(() => c2.abort(), 20);
await assert.rejects(cloudPending, (e) => e.name === 'AbortError');

console.log('device-langs: all checks passed');
