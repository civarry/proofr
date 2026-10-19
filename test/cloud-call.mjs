// Node-only checks for the cloud request path and model healing:
//   node test/cloud-call.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';

globalThis.self = globalThis;
new Function(fs.readFileSync(process.env.CONSTANTS || new URL('../constants.js', import.meta.url), 'utf8'))();

const provider = { id: 'groq', displayName: 'Groq', baseURL: 'https://x/v1', model: 'openai/gpt-oss-120b', apiKey: 'k' };
const reply = (choice, status = 200) => async () => ({ ok: status < 400, status, json: async () => choice });

// A cut-off answer must never come back as a result (it would replace text in place).
globalThis.fetch = reply({ choices: [{ finish_reason: 'length', message: { content: 'The meeting was moved to' } }] });
await assert.rejects(SR_callCloud(provider, 'p', 0.3, 100), /cut off before it finished/);

globalThis.fetch = reply({ choices: [{ finish_reason: 'stop', message: { content: ' Done. ' } }] });
assert.equal(await SR_callCloud(provider, 'p', 0.3, 100), 'Done.');

// Retired model → actionable message.
globalThis.fetch = reply({ error: { code: 'model_decommissioned', message: 'The model has been decommissioned' } }, 400);
await assert.rejects(SR_callCloud(provider, 'p', 0.3, 100), /no longer available/);

// Healing only lands on known-good models; never an arbitrary first pick.
assert.equal(SR_pickAvailableModel('groq', ['openai/gpt-oss-20b', 'aaa-model']), 'openai/gpt-oss-20b');
assert.equal(SR_pickAvailableModel('openai', ['aaa-model', 'gpt-6-luna']), null);
assert.equal(SR_pickAvailableModel('openrouter', ['openai/gpt-oss-120b']), 'openai/gpt-oss-120b');
assert.equal(SR_pickAvailableModel('custom', ['zeta', 'llama3']), 'llama3');
assert.equal(SR_pickAvailableModel('groq', []), null);
// A preset without a verified default takes the first listed chat model.
assert.equal(SR_pickAvailableModel('mistral', ['text-embed-1', 'mistral-small-latest']), 'mistral-small-latest');
assert.equal(SR_pickAvailableModel('ollama', []), null);

// Keyless local servers: no Authorization header, no "No API key" error.
let sent;
globalThis.fetch = async (url, init) => { sent = { url, init }; return { ok: true, status: 200, json: async () => ({ data: [{ id: 'llama3' }], choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }) }; };
const ollama = { id: 'ollama', displayName: 'Ollama', baseURL: 'http://localhost:11434/v1', model: 'llama3', apiKey: '' };
assert.equal(await SR_callCloud(ollama, 'p', 0.3, 100), 'ok');
assert.equal(sent.init.headers.Authorization, undefined);
assert.deepEqual(await SR_availableModels(ollama), ['llama3']);
assert.equal(sent.init.headers.Authorization, undefined);
assert.equal(await SR_callCloud(provider, 'p', 0.3, 100), 'ok');
assert.equal(sent.init.headers.Authorization, 'Bearer k');
// A remote endpoint with no key still needs one.
await assert.rejects(SR_callCloud({ ...provider, apiKey: '' }, 'p', 0.3, 100), /No API key/);

// Local means this computer or the user's network, nothing else.
for (const u of ['http://localhost:1234/v1', 'http://127.0.0.1:8080', 'http://[::1]:11434', 'http://192.168.1.20:11434/v1', 'http://10.0.0.5', 'http://172.20.1.1', 'http://mac-studio.local:11434']) assert.ok(SR_isLocalURL(u), u);
for (const u of ['https://api.groq.com/openai/v1', 'http://172.32.0.1', 'http://8.8.8.8', 'http://localhost.evil.com', 'not a url', '']) assert.ok(!SR_isLocalURL(u), u);

// Ready = base URL + model + (key, or a keyless/local server).
assert.ok(SR_providerReady(ollama));
assert.ok(SR_providerReady({ baseURL: 'https://x/v1', model: 'm', apiKey: 'k' }));
assert.ok(SR_providerReady({ baseURL: 'https://x/v1', model: 'm', keyless: true }));
assert.ok(!SR_providerReady({ baseURL: 'https://x/v1', model: 'm', apiKey: '' }));
assert.ok(!SR_providerReady({ ...ollama, model: '' }));
assert.ok(!SR_providerReady({ baseURL: '', model: 'm', apiKey: 'k' }));
assert.ok(!SR_providerReady(null));

// Host access only where the API doesn't send CORS headers to extensions.
assert.deepEqual(SR_CLOUD_SERVICES.filter((s) => SR_needsHostAccess(s.id)).map((s) => s.id), ['ollama', 'lmstudio', 'custom']);
// Every preset carries the fields the settings UI reads.
for (const s of SR_CLOUD_SERVICES) {
  for (const k of ['id', 'name', 'baseURL', 'keyURL', 'keyless', 'cors', 'defaultModel', 'note']) assert.ok(k in s, `${s.id}.${k}`);
  if (s.keyless) assert.ok(SR_isLocalURL(s.baseURL), `${s.id} keyless but remote`);
}

console.log('cloud-call: all checks passed');
