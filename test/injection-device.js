// On-device half of the live injection check (the cloud half is run_injection.mjs).
// Serve the repo on localhost and open test/injection-device.html in a Chrome
// that has Gemini Nano, or open it as chrome-extension://<id>/test/injection-device.html.
// The summary also lands in window.__srInjection for a script to read.
const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const say = (t) => { $('status').textContent = t; };
const print = (t) => { $('out').textContent += `${t}\n`; };
const load = (src) => new Promise((resolve, reject) => {
  const s = document.createElement('script');
  s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`couldn't load ${src}`));
  document.head.appendChild(s);
});

async function run() {
  $('run').disabled = true;
  $('out').textContent = '';
  const { ATTACKS, CLEAN, guardOf, verdict } = SR_INJECTION_CASES;
  const tones = (params.get('tones') || SR_TONES.map((t) => t.id).join(',')).split(',');
  const tally = { held: 0, refused: 0, caught: 0, INSERTED: 0, error: 0 };
  const clean = { passed: 0, stopped: 0, error: 0 };
  const rows = [];
  const one = (s) => String(s).replace(/\s+/g, ' ').slice(0, 150);
  const attempt = async (text, tone) => {
    try {
      return { text: (await SR_rewriteAuto(text, tone, { engine: 'device', targetLang: 'es' })).text };
    } catch (e) {
      return e.name === 'SuspectOutput' ? { refused: e.message } : { error: e.message };
    }
  };
  print(`constants: ${params.get('constants') || '../constants.js'}`);
  let done = 0;
  const total = tones.length * (ATTACKS.length + CLEAN.length);
  for (const tone of tones) {
    for (const a of ATTACKS) {
      say(`${++done} of ${total}: ${tone}, ${a.name}`);
      const r = await attempt(a.text, tone);
      const v = r.error ? 'error' : r.refused ? 'refused' : verdict(a, r.text, tone);
      tally[v]++;
      rows.push({ tone, attack: a.name, verdict: v, out: r.text || r.refused || r.error });
      if (v !== 'held') print(`${v.padEnd(8)} ${tone.padEnd(12)} ${a.name.padEnd(20)} ${one(r.text || r.refused || r.error)}`);
    }
    for (const text of CLEAN) {
      say(`${++done} of ${total}: ${tone}, clean text`);
      const r = await attempt(text, tone);
      if (!r.text) { clean.error++; print(`clean    ${tone.padEnd(12)} error: ${one(r.refused || r.error)}`); continue; }
      const g = guardOf(text, r.text, tone);
      rows.push({ tone, clean: text.slice(0, 30), stopped: !g.ok, reasons: g.reasons, out: r.text });
      if (g.ok) clean.passed++;
      else { clean.stopped++; print(`STOPPED  ${tone.padEnd(12)} ${g.reasons.join('; ')} :: ${one(r.text)}`); }
    }
  }
  const summary = `attacks: ${tally.held} held, ${tally.refused} refused, ${tally.caught} obeyed but caught, ${tally.INSERTED} obeyed and inserted, ${tally.error} errors\n`
    + `clean texts: ${clean.passed} would go in, ${clean.stopped} stopped for review, ${clean.error} errors`;
  print(`\n${summary}`);
  say('Done.');
  window.__srInjection = { tally, clean, rows, summary, done: true };
  $('run').disabled = false;
}

(async () => {
  try {
    await load(params.get('constants') || '../constants.js');
    await load('injection-cases.js');
  } catch (e) { say(e.message); return; }
  if (typeof LanguageModel === 'undefined') { say('Gemini Nano is not available in this Chrome (no LanguageModel).'); return; }
  const availability = await LanguageModel.availability({ expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] }).catch((e) => `error: ${e.name}`);
  say(`Gemini Nano: ${availability}`);
  if (availability !== 'available') return;
  $('run').disabled = false;
  $('run').addEventListener('click', run);
  if (params.get('run') === '1') run();
})();
