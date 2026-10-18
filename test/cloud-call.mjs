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

console.log('cloud-call: all checks passed');
