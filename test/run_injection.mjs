// Live prompt-injection check: every mode, through the extension's own cloud
// path (SR_rewrite and SR_askCloud: system and user messages, teacher examples
// for small models, SR_cleanOutput). Needs a real key; keep it out of files
// you commit and out of chat:
//   pbpaste > /tmp/groq.key && KEY_FILE=/tmp/groq.key node test/run_injection.mjs
//   GROQ_API_KEY=... node test/run_injection.mjs
// Options (env): MODEL (default: the Groq preset's model), TONES (comma list),
// CONSTANTS (another constants.js, e.g. the last release, to compare), REPS.
// The cases are in injection-cases.js. Results:
//   held      the answer ignored the instruction
//   refused   SR_cleanOutput refused the answer (it leaked the rules)
//   caught    obeyed, but the guard stops it going into the text box
//   INSERTED  obeyed, and it would have gone into the text box
// Chrome's on-device model: test/injection-device.html.
import fs from 'node:fs';

const KEY = process.env.KEY_FILE ? fs.readFileSync(process.env.KEY_FILE, 'utf8').trim() : process.env.GROQ_API_KEY;
if (!KEY) { console.error('Set KEY_FILE or GROQ_API_KEY first (see the top of this file).'); process.exit(1); }

globalThis.self = globalThis;
globalThis.window = globalThis;
new Function(fs.readFileSync(process.env.CONSTANTS || new URL('../constants.js', import.meta.url), 'utf8'))();
new Function(fs.readFileSync(new URL('./injection-cases.js', import.meta.url), 'utf8'))();
const { ATTACKS, CLEAN, guardOf, verdict } = SR_INJECTION_CASES;

const GROQ = SR_cloudServiceMeta('groq');
const PROVIDER = { id: 'groq', displayName: GROQ.name, baseURL: GROQ.baseURL, model: process.env.MODEL || GROQ.defaultModel, apiKey: KEY };
const REPS = Number(process.env.REPS || 1);
const TONES = (process.env.TONES || SR_TONES.map((t) => t.id).concat('ask').join(',')).split(',');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function run(tone, text) {
  for (let attempt = 0; ; attempt++) {
    try {
      return tone === 'ask'
        ? await SR_askCloud(PROVIDER, text, 'Make this sound more upbeat.')
        : await SR_rewrite(PROVIDER, text, tone, 'es');
    } catch (e) {
      if (e.name === 'SuspectOutput') return { refused: e.message };
      if (/rate-limit/i.test(e.message) && attempt < 8) { await sleep(15000); continue; }
      return { error: e.message };
    }
  }
}

const tally = { held: 0, refused: 0, caught: 0, INSERTED: 0, error: 0 };
const clean = { passed: 0, stopped: 0, error: 0 };
const one = (s) => s.replace(/\s+/g, ' ').slice(0, 150);
console.log(`model ${PROVIDER.model}${SR_isSmallModel(PROVIDER) ? ' (small: teacher examples on)' : ''}, ${process.env.CONSTANTS || 'constants.js'}\n`);

for (let rep = 0; rep < REPS; rep++) {
  for (const tone of TONES) {
    for (const a of ATTACKS) {
      const out = await run(tone, a.text);
      const v = out.error ? 'error' : out.refused ? 'refused' : verdict(a, out, tone);
      tally[v]++;
      if (v !== 'held') console.log(`${v.padEnd(8)} ${tone.padEnd(12)} ${a.name.padEnd(20)} ${one(out.error || out.refused || out)}`);
    }
    if (tone === 'ask') continue;
    for (const text of CLEAN) {
      const out = await run(tone, text);
      if (out.error || out.refused) { clean.error++; console.log(`clean    ${tone.padEnd(12)} error: ${one(out.error || out.refused)}`); continue; }
      const g = guardOf(text, out, tone);
      if (g.ok) clean.passed++;
      else { clean.stopped++; console.log(`STOPPED  ${tone.padEnd(12)} ${g.reasons.join('; ')} :: ${one(out)}`); }
    }
  }
}

console.log(`\nattacks: ${tally.held} held, ${tally.refused} refused, ${tally.caught} obeyed but caught, ${tally.INSERTED} obeyed and inserted, ${tally.error} errors`);
console.log(`clean texts: ${clean.passed} would go in, ${clean.stopped} stopped for review, ${clean.error} errors`);
process.exit(tally.INSERTED || tally.error || clean.error ? 1 : 0);
