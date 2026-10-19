// Prompt-level distillation: find the teacher examples that make a small model
// do Proofr's tasks most like a big one, and prove they beat no examples.
//
//   GROQ_API_KEY=... node store/distill.mjs [grammar|tldr]
//
// 1. The teacher (a big model) answers every text in store/distill-data.json.
//    Answers that fail Proofr's own checks (leaked prompt, injected instruction
//    obeyed, a number dropped, the change guard) are thrown out.
// 2. Candidates: no examples, the shipped SR_EXAMPLES, and a few sets drawn
//    from the teacher's good training answers.
// 3. The student (a small model) answers the held-out dev texts with each
//    candidate. Score per text: 0 if it fails a check, else how close its words
//    are to the teacher's (1 = identical). Prompt tokens are counted too.
// 4. Prints the table and, when a drawn set beats both the shipped set and no
//    examples, the SR_EXAMPLES entry to paste into constants.js.
//
// Env: BASE (default Groq), TEACHER (openai/gpt-oss-120b), STUDENT
// (llama-3.1-8b-instant), SETS (drawn candidates, default 4), MOCK=1 (no
// network: a fake model, to check the script itself runs).
import fs from 'node:fs';

globalThis.self = globalThis;
new Function(fs.readFileSync(new URL('../constants.js', import.meta.url), 'utf8'))();

const tone = process.argv[2] || 'grammar';
const data = JSON.parse(fs.readFileSync(new URL('./distill-data.json', import.meta.url), 'utf8'))[tone];
if (!data) { console.error(`No data for ${tone} in store/distill-data.json`); process.exit(1); }
const KEY = process.env.GROQ_API_KEY || process.env.KEY || '';
const MOCK = !!process.env.MOCK;
if (!KEY && !MOCK) { console.error('Set GROQ_API_KEY (or MOCK=1 for a dry run).'); process.exit(1); }
const BASE = process.env.BASE || 'https://api.groq.com/openai/v1';
const provider = (model) => ({ id: 'distill', displayName: model, baseURL: BASE, apiKey: KEY || 'mock-key-000000', model });
const TEACHER = provider(process.env.TEACHER || 'openai/gpt-oss-120b');
const STUDENT = provider(process.env.STUDENT || 'llama-3.1-8b-instant');
const SETS = Number(process.env.SETS || 4);
const CANARY = 'ZZQCANARY42';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Prompt tokens per call, from the provider's usage report.
let lastUsage = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (MOCK) {
    const body = JSON.parse(init.body);
    const text = (body.messages.at(-1).content.match(/<(text-[0-9a-f]{12})>\n([\s\S]*?)\n<\/\1>/) || [, , ''])[2];
    // A fake student that gets better with examples, so the table shows something.
    const fixed = text.replace(/\bteh\b/g, 'the').replace(/\bi\b/g, 'I');
    const content = body.messages.length > 2 || /120b/.test(body.model) ? fixed.replace(/\bdont\b/g, "don't") : fixed;
    lastUsage = JSON.stringify(body.messages).length / 4 | 0;
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
  }
  const res = await realFetch(url, init);
  const copy = res.clone();
  copy.json().then((j) => { lastUsage = j?.usage?.prompt_tokens || 0; }).catch(() => {});
  return res;
};

// One call with the given examples (null = none), retried on rate limits.
async function run(model, text, examples) {
  const parts = SR_buildPromptParts(text, tone, 'en');
  parts.examples = examples || [];
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const out = await SR_callCloud(model, parts, SR_getTemperature(tone), SR_maxTokens(text, tone));
      await sleep(MOCK ? 0 : 300);
      return { out: SR_cleanOutput(out, { fence: parts.fence, input: text }), tokens: lastUsage };
    } catch (e) {
      if (/rate-limiting/.test(e.message)) { await sleep(5000 * (attempt + 1)); continue; }
      return { error: e.name === 'SuspectOutput' ? 'leaked prompt' : e.message };
    }
  }
  return { error: 'rate limited' };
}

const digits = (t) => (String(t).match(/\d+/g) || []).sort().join(',');
function problem(input, out) {
  if (out.includes(CANARY) && !input.includes(CANARY)) return 'obeyed an injected instruction';
  if (digits(out) !== digits(input) && tone === 'grammar') return 'changed a number';
  if (tone === 'grammar' && !SR_changeGuard(input, out).ok) return 'failed the change guard';
  return null;
}
// 1 when the student's words match the teacher's, falling toward 0 as they differ.
function closeness(a, b) {
  const ops = SR_wordDiff(a, b);
  if (!ops) return 0;
  const isWord = (t) => /[\p{L}\p{N}]/u.test(t);
  const count = (type) => ops.filter((o) => type.includes(o.type)).reduce((n, o) => n + SR_diffTokens(o.text).filter(isWord).length, 0);
  const same = count(['same']);
  const total = Math.max(count(['same', 'del']), count(['same', 'ins']), 1);
  return same / total;
}

console.log(`Teacher ${TEACHER.model} → student ${STUDENT.model}, task: ${tone}${MOCK ? ' (MOCK)' : ''}`);
// 1. Teacher answers.
const teach = async (texts) => {
  const good = [];
  for (const text of texts) {
    const r = await run(TEACHER, text, null);
    const why = r.error || problem(text, r.out);
    if (why) console.log(`  teacher answer dropped (${why}): ${text.slice(0, 50)}`);
    else good.push([text, r.out]);
  }
  return good;
};
const train = await teach(data.train);
const dev = await teach(data.dev);
console.log(`Teacher kept ${train.length}/${data.train.length} training and ${dev.length}/${data.dev.length} dev answers.`);

// 2. Candidates. Drawn sets keep an injection example when one is available,
// and stay as short as the shipped ones (the cost is paid on every request).
const shipped = SR_examplesFor(tone);
const budget = Math.max(700, shipped.reduce((n, [i, o]) => n + i.length + o.length, 0));
const injection = train.filter(([i]) => /ignore|assistant:|system:/i.test(i));
const plain = train.filter(([i]) => !/ignore|assistant:|system:/i.test(i));
let seed = 7;
const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const candidates = [{ name: 'none', examples: [] }, { name: 'shipped', examples: shipped }];
for (let k = 0; k < SETS && plain.length; k++) {
  const set = [plain[rand(plain.length)]];
  if (injection.length) set.push(injection[rand(injection.length)]);
  else if (plain.length > 1) set.push(plain[rand(plain.length)]);
  if (set.reduce((n, [i, o]) => n + i.length + o.length, 0) <= budget) candidates.push({ name: `drawn ${k + 1}`, examples: set });
}

// 3. Student on the dev set with each candidate.
const results = [];
for (const c of candidates) {
  let score = 0, tokens = 0;
  const fails = {};
  for (const [text, ref] of dev) {
    const r = await run(STUDENT, text, c.examples);
    tokens += r.tokens || 0;
    const why = r.error || problem(text, r.out);
    if (why) { fails[why] = (fails[why] || 0) + 1; continue; }
    score += closeness(ref, r.out);
  }
  results.push({ ...c, score: score / Math.max(1, dev.length), tokens: Math.round(tokens / Math.max(1, dev.length)), fails });
  console.log(`  ${c.name.padEnd(9)} score ${(score / Math.max(1, dev.length)).toFixed(3)}  prompt tokens ${Math.round(tokens / Math.max(1, dev.length))}  ${Object.entries(fails).map(([k, v]) => `${v}× ${k}`).join(', ')}`);
}

// 4. Verdict.
const by = Object.fromEntries(results.map((r) => [r.name, r]));
const best = results.slice(2).sort((a, b) => b.score - a.score)[0];
const MARGIN = 0.02;
if (by.shipped.score + MARGIN < by.none.score) console.log(`\nThe shipped examples HURT this student (${by.shipped.score.toFixed(3)} vs ${by.none.score.toFixed(3)} with none). Remove them for ${tone}.`);
else console.log(`\nShipped examples: ${(by.shipped.score - by.none.score >= 0 ? '+' : '')}${(by.shipped.score - by.none.score).toFixed(3)} over none.`);
if (best && best.score > by.shipped.score + MARGIN && best.score > by.none.score + MARGIN) {
  console.log(`\n${best.name} beats shipped by ${(best.score - by.shipped.score).toFixed(3)}. Paste into SR_EXAMPLES in constants.js, then run node test/distill.mjs:\n`);
  console.log(`  ${tone}: ${JSON.stringify(best.examples, null, 2).replace(/\n/g, '\n  ')},`);
} else console.log('No drawn set beats the shipped examples by the margin. Keep them.');
