// Eight weeks of Proofreads for six kinds of writer, run through the real
// insights code: what each one is taught must fit them, be correct, and never
// come from the model's own one-off mistakes.
//   node test/learning-sim.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';

globalThis.self = globalThis;
new Function(fs.readFileSync(process.env.CONSTANTS || new URL('../constants.js', import.meta.url), 'utf8'))();

const DAY = 86400000;
const START = new Date(2026, 7, 3, 9).getTime(); // a Monday, local time
const WEEKS = 8;

// Seeded, so a failure reproduces.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sentences use [wrong|right] slots. The writer gets a slot wrong with the
// profile's chance for that week; the reply always has it right. {wrong|right}
// slots are private (a name, a number, a link) the model also "fixes": they must
// never be stored. Every sentence also carries names, numbers or links the
// model leaves alone.
const PROFILES = {
  apostrophe: {
    chance: (w) => Math.max(0, 0.8 - 0.16 * w), // improves, clean from week 5
    must: ['apostrophe'], may: [],
    sentences: [
      'I [dont|don\'t] think Maria saw the draft yet.',
      '[its|it\'s] on the shared drive under Q4 plans.',
      'We [cant|can\'t] ship before the 12th, sorry.',
      '[im|I\'m] out until Tuesday but reachable.',
      'The link [doesnt|doesn\'t] open from docs.example.com for me.',
      'Thanks for the notes, [thats|that\'s] really helpful.',
    ],
  },
  esl: {
    chance: () => 0.6, // flat
    must: ['agreement'], may: ['a-an'],
    sentences: [
      'Yesterday we [was|were] at the office with Kenji until 7.',
      'The reports [is|are] ready for review.',
      'She [have|has] two meetings with the client today.',
      'Can you send me [a|an] update before noon?',
      'They [was|were] happy with the 3 options we showed.',
      'It takes [a|an] hour to get to the Lisbon site.',
    ],
  },
  typist: {
    chance: (w) => Math.max(0.05, 0.7 - 0.1 * w), // improves
    must: ['letters'], may: ['order', 'ie-ei'],
    sentences: [
      'I will send [teh|the] slides to Priya after lunch.',
      'Did you [recieve|receive] the invoice for order {5521|5512}?',
      'Let us meet [tomorow|tomorrow] at the usual place.',
      'This is a good [ocasion|occasion] to review the plan.',
      'Please check [adn|and] confirm on {exampel.com|example.com} by 5pm.',
      'I [beleive|believe] the numbers on page 4 are off.',
      'We [definately|definitely] need more time.',
      'The [adress|address] is on {Jhon|John}\'s card.',
    ],
  },
  lowercase: {
    chance: () => 0.85, // flat
    must: ['lowercase-i', 'days'], may: ['sentence-start'],
    sentences: [
      '[i|I] can join the call with Ahmed at 10.',
      'see you on [friday|Friday] then.',
      'The launch moves to [march|March] this year.',
      '[the|The] new build is up at build.example.com/v2 now.',
      'ok, [we|We] will talk on [monday|Monday].',
      'Do you think [i|I] should reply to Sofia?',
      '[please|Please] send it before [june|June].',
    ],
  },
  careful: {
    chance: () => 0.01, // mostly correct
    must: [], may: [],
    sentences: [
      'Thanks, Elena, the summary looks good to me.',
      'We moved the review to room 4B on the 9th.',
      'The numbers in the sheet match the [recieve|receive] log.',
      'I will forward the deck to the team at 3pm.',
      'Please see the notes at wiki.example.com/onboarding.',
    ],
  },
  mixed: {
    chance: () => 0.5, // flat
    must: ['their', 'your'], may: ['apostrophe', 'ie-ei', 'then'],
    sentences: [
      'The vendors sent [there|their] pricing to Omar last week.',
      'Let me know if [your|you\'re] free on Thursday.',
      'I [dont|don\'t] have access to the 2025 budget.',
      'Thanks for [you\'re|your] patience with this.',
      'This one is cheaper [then|than] the last quote.',
      'see [u|you] at the standup.',
      'I hear [their|they\'re] moving the deadline to the 20th.',
    ],
  },
};
// Wrong "fixes" the model makes once: the user wrote it right.
const NOISE = [
  { day: 9, before: 'This plan is better than the old one.', after: 'This plan is better then the old one.' },
  { day: 23, before: 'The change will affect everyone.', after: 'The change will effect everyone.' },
];
const NOISE_KEYS = ['than→then', 'affect→effect'];
const SR_DAYS_MONTHS_TEST = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']);
const NAMES = ['maria', 'kenji', 'priya', 'jhon', 'john', 'ahmed', 'sofia', 'elena', 'omar', 'lisbon'];

// Every word Practice puts around the user's mistakes, checked by hand for spelling.
// A new phrase in constants.js fails here until its words are reviewed and added.
const FILLER = new Set(`quick update just so you know for tomorrow i wrote in the email please check again note says
think old version works we make call today file open on my laptop room booked yet link work me update go out time
package arrived going to rain later dog wagged tail running a bit late sent draft plan now sending it team shared slides
notes are over welcome join thanks help this is easier than looks eat first and then talk takes hour need new were
hoping more meeting was short hope can see starts let if should
heads up she already left they report ready files not ride leave soon box heavy coming sure coat try keys handle feels
noise sleep change had big almost done at noon invite get copy by enough arrive signed his way her tell next meet send
tonight like be long told find page load take started keep two lists will morning wait only bring what error that
helpful early of goal good book twice start week changed venue opens nine part am sorry party six rule protect felt
after ten people rained still went walked park budget come us summary join`.split(/\s+/));
const fill = (s, wrong, pick) => s.replace(/\[([^|\]]*)\|([^\]]*)\]/g, (_, a, b) => (wrong() ? (pick.push(`${a}|${b}`), a) : b))
  .replace(/\{([^|}]*)\|([^}]*)\}/g, (_, a, b) => (wrong() ? a : b));
const words = (t) => String(t).match(/[\p{L}\p{N}]+/gu) || [];

// The same bookkeeping background.js does for each Proofread.
function record(store, before, after, now) {
  const pairs = SR_extractCorrections(before, after);
  const ops = SR_wordDiff(before, after);
  return SR_mergeInsights(store, pairs, now, words(before).length, ops ? SR_diffCount(ops) : pairs.length, before);
}

function simulate(name, profile, seed) {
  const r = rng(seed);
  let store;
  const ledger = []; // { day, t, words, before, slots: ['wrong|right'] } per Proofread, kept by the test only
  const snapshots = []; // the view at the end of each week
  for (let day = 0; day < WEEKS * 7; day++) {
    const week = Math.floor(day / 7);
    if (day % 7 === 5 && r() < 0.5) continue; // some Saturdays off
    for (let k = 0; k < 3; k++) {
      const now = START + day * DAY + k * 3600000;
      const picked = [];
      const chosen = Array.from({ length: 3 }, () => profile.sentences[Math.floor(r() * profile.sentences.length)]);
      const slots = [];
      const before = chosen.map((s) => fill(s, () => r() < profile.chance(week), slots)).join(' ');
      const after = chosen.map((s) => fill(s, () => false, picked)).join(' ');
      store = record(store, before, after, now);
      ledger.push({ day, t: now, words: words(before).length, before, slots });
    }
    const noise = NOISE.find((x) => x.day === day);
    if (noise) {
      store = record(store, noise.before, noise.after, START + day * DAY + 5 * 3600000);
      ledger.push({ day, t: START + day * DAY + 5 * 3600000, words: words(noise.before).length, before: noise.before, slots: [] });
    }
    if (day % 7 === 6) snapshots.push({ store, week: Math.floor(day / 7), now: START + day * DAY + 20 * 3600000, view: SR_insightsView(store, START + day * DAY + 20 * 3600000) });
  }
  return { name, profile, store, ledger, snapshots };
}

const runs = Object.entries(PROFILES).map(([name, p], i) => simulate(name, p, 1000 + i));
const key = (p) => `${p.from}→${p.to}`;
const fold = (s) => String(s).toLowerCase().replace(/’/g, "'");
// Every word pair a writer actually got wrong, from the sentences (not the code).
const genuine = (run) => {
  const set = new Set();
  for (const s of run.profile.sentences) for (const [, a, b] of s.matchAll(/\[([^|\]]*)\|([^\]]*)\]/g)) set.add(`${a}|${b}`);
  return set;
};
const CONTRACTIONS = { "don't": 'do not', "can't": 'cannot', "i'm": 'I am', "doesn't": 'does not', "that's": 'that is' };

let checks = 0;
for (const run of runs) {
  const { name, profile, store, snapshots } = run;
  const mid = snapshots[3].view, end = snapshots[WEEKS - 1].view;
  const slotWords = new Set([...genuine(run)].flatMap((s) => s.split('|').flatMap((w) => words(fold(w)))));
  const atAll = (fn) => snapshots.forEach((s) => fn(s.view, s));
  run.masteredWeeks = snapshots.map((x) => x.view.mastered.map((m) => m.to));

  // (a) habits fit the profile.
  const ids = SR_habits(mid).map((h) => h.id);
  for (const id of profile.must) assert.ok(ids.includes(id), `${name}: expected habit ${id}, got ${ids}`);
  for (const id of ids) assert.ok(profile.must.includes(id) || profile.may.includes(id), `${name}: habit ${id} doesn't fit`);
  for (const h of SR_habits(mid)) {
    assert.ok(!/[—–]/.test(h.label), `${name}: no em dash in "${h.label}"`);
    for (const ex of h.examples) assert.ok(mid.working.some((p) => p.to === ex), `${name}: example ${ex} is the user's own`);
  }
  run.signature = JSON.stringify(ids);
  checks += 1;

  atAll((view, snap) => {
    const tag = `${name} week ${snap.week + 1}`;
    const real = genuine(run);
    const isReal = (p) => [...real].some((s) => {
      const [a, b] = s.split('|');
      return SR_extractCorrections(a, b).some((q) => key(q) === key(p));
    });
    const practice = [0, 1, 2, 3, 4, 5, 6, 7].flatMap((seed) => SR_buildPractice(view, 3, seed));
    const habits = SR_habits(view);

    // (c) the model's one-off wrong fixes are never taught.
    const taught = [...view.working.map(key), ...practice.flatMap((it) => it.targets.map(key))];
    for (const k of NOISE_KEYS) {
      assert.ok(!taught.includes(k) && !taught.includes(k.split('→')[1]), `${tag}: noise ${k} taught`);
      assert.ok(!habits.some((h) => h.examples.includes(k.split('→')[1])), `${tag}: noise ${k} in a habit`);
    }
    for (const p of view.working) assert.ok(isReal(p) && p.n >= 2, `${tag}: working ${key(p)} is a real, repeated mistake`);

    // (b) every rule shown is right for its pair; none for pairs it doesn't know.
    for (const p of [...view.working, ...practice.flatMap((it) => it.targets)]) {
      const rule = SR_ruleFor(p);
      const to = fold(p.to);
      if (rule === null) continue;
      const ok = (CONTRACTIONS[to] && rule === `The apostrophe stands for the missing letters: ${CONTRACTIONS[to]} → ${to.replace(/^i'/, "I'")}.`)
        || (['their', 'there', "they're", 'your', "you're", 'then', 'than', 'a', 'an', 'was', 'were', "it's", 'its'].includes(to) && fold(rule).includes(to) && fold(p.from) !== to)
        || (p.kind === 'spelling' && rule === `Spelled ${p.to.split('').join('-')}.`)
        || (p.from === 'i' && p.to === 'I' && rule === '"I" is always a capital.')
        || (SR_DAYS_MONTHS_TEST.has(to) && fold(p.from) === to && rule === 'Days and months start with a capital: Friday, March.')
        || (fold(p.from) === to && /^\p{Lu}/u.test(p.to) && rule === 'A sentence starts with a capital letter.');
      assert.ok(ok, `${tag}: wrong rule for ${key(p)}: ${rule}`);
    }
    for (const p of view.working) if (p.kind === 'other' && !CONTRACTIONS[fold(p.to)]) assert.equal(SR_ruleFor(p), null, `${tag}: no rule for ${key(p)}`);

    // (d) practice: the prompt fails, the answer passes, and its only errors are the user's own.
    for (const it of practice) {
      const own = new Set(it.targets.flatMap((t) => [...words(fold(t.from)), ...words(fold(t.to))]));
      for (const w of words(fold(it.answer))) assert.ok(own.has(w) || FILLER.has(w), `${tag}: unreviewed word "${w}" in "${it.answer}"`);
      const onPrompt = SR_checkPractice(it, it.prompt);
      assert.ok(onPrompt.right.length === 0 && onPrompt.missed.length === it.targets.length, `${tag}: prompt passes: ${it.prompt}`);
      assert.deepEqual(SR_checkPractice(it, it.answer).missed, [], `${tag}: answer fails: ${it.answer}`);
      const removed = SR_wordDiff(it.prompt, it.answer).filter((o) => o.type === 'del').flatMap((o) => words(o.text)).sort();
      assert.deepEqual(removed, it.targets.flatMap((t) => words(t.from)).sort(), `${tag}: errors in "${it.prompt}" are only the targets`);
      for (const t of it.targets) assert.ok(view.working.some((p) => key(p) === key(t)) && isReal(t), `${tag}: ${key(t)} is the user's own`);
    }

    // (f) mastered only after 2+ fixes, then the right form on 3 different days and 14 days with no fix.
    for (const m of view.mastered) {
      const upTo = run.ledger.filter((e) => e.t <= snap.now);
      const fixes = upTo.filter((e) => e.slots.some((x) => SR_extractCorrections(...x.split('|')).some((q) => key(q) === key(m))));
      const lastFix = Math.max(...fixes.map((e) => e.t));
      const keepCase = SR_classifyCorrection(m) === 'capitalization';
      const rightDays = new Set(upTo.filter((e) => e.t > lastFix && SR_practiceHas(e.before, m.to, keepCase)).map((e) => e.day));
      assert.ok(fixes.length >= 2, `${tag}: ${key(m)} mastered after one fix`);
      assert.ok(rightDays.size >= 3, `${tag}: ${key(m)} mastered with right uses on ${rightDays.size} days`);
      assert.ok(snap.now - lastFix >= 14 * DAY, `${tag}: ${key(m)} mastered ${((snap.now - lastFix) / DAY).toFixed(1)} days after a fix`);
    }
    checks++;
  });

  // (e) per 100 words falls for an improving writer and not for a flat one.
  const rate = (ws) => ws.reduce((s, w) => s + w.fixes, 0) / ws.reduce((s, w) => s + w.words, 0) * 100;
  const first = rate(end.weeks.slice(0, 2)), last = rate(end.weeks.slice(6));
  const improving = profile.chance(7) < profile.chance(0);
  if (improving) assert.ok(last < first * 0.5, `${name}: per100 ${first.toFixed(1)} → ${last.toFixed(1)} should fall`);
  else if (profile.chance(0) >= 0.1) assert.ok(last > first * 0.7, `${name}: per100 ${first.toFixed(1)} → ${last.toFixed(1)} should stay flat`);
  else assert.ok(first < 1 && last < 1, `${name}: a careful writer stays under 1 per 100 words`);
  // Mastery is earned by the improving writer and never by one still making the mistake.
  if (improving) assert.ok(end.mastered.length >= 3, `${name}: improving writer masters words: ${end.mastered.map((m) => m.to)}`);
  if (profile.chance(0) >= 0.1 && !improving) assert.deepEqual(run.masteredWeeks.flat(), [], `${name}: a writer still wrong this often never masters`);
  if (name === 'apostrophe') {
  }

  // (g) nothing stored but corrected words: no name, digit, link, or sentence word.
  for (const k of Object.keys(store.pairs)) {
    assert.ok(!/\d|@|:\/\/|\.\p{L}/u.test(k), `${name}: stored ${k}`);
    assert.ok(!words(fold(k)).some((w) => NAMES.includes(w)), `${name}: name stored in ${k}`);
    const allowed = new Set([...slotWords, ...NOISE_KEYS.flatMap((n) => words(n))]);
    for (const w of words(fold(k))) assert.ok(allowed.has(w), `${name}: "${w}" in ${k} was never a corrected word`);
  }
  assert.deepEqual(Object.keys(store).sort(), ['days', 'pairs', 't', 'v']);
  for (const d of Object.values(store.days)) {
    assert.deepEqual(Object.keys(d).sort(), ['fixes', 'k', 'proofreads', 'words']);
    for (const kind of Object.keys(d.k)) assert.ok(['apostrophe', 'capitalization', 'punctuation', 'grammar', 'spelling', 'other'].includes(kind), `${name}: day kind ${kind}`);
  }
  for (const p of Object.values(store.pairs)) assert.deepEqual(Object.keys(p).sort(), ['first', 'g', 'h', 'kind', 'last', 'n', 'streak'], `${name}: pair fields`);

  checks += 2;
}

// A correct text pasted in (or proofread again) masters nothing: one right use a day.
{
  const { store: st, now } = runs.find((r) => r.name === 'typist').snapshots[3];
  const paste = PROFILES.typist.sentences.map((x) => x.replace(/\[[^|\]]*\|([^\]]*)\]/g, '$1').replace(/\{[^|}]*\|([^}]*)\}/g, '$1')).join(' ');
  let pasted = st;
  for (let i = 1; i <= 5; i++) pasted = record(pasted, paste, paste, now + 60000 * i);
  const grew = Object.keys(st.pairs).filter((k) => pasted.pairs[k].streak > st.pairs[k].streak);
  assert.ok(grew.length > 0, 'the paste does count as a right use');
  for (const k of grew) assert.equal(pasted.pairs[k].streak, st.pairs[k].streak + (st.pairs[k].h.endsWith('g') && SR_dayKey(st.pairs[k].g) === SR_dayKey(now) ? 0 : 1), `${k}: at most one right use a day`);
  assert.deepEqual(SR_newlyMastered(st, pasted), [], 'the same correct text 5 times in a day masters nothing');
}

// (a) no two writers are told the same thing.
const sigs = runs.map((r) => r.signature);
assert.equal(new Set(sigs).size, sigs.length, `profiles look alike:\n${sigs.join('\n')}`);
console.log(`learning-sim: ${runs.length} writers, 8 weeks, ${checks} checks passed`);
for (const r of runs) console.log(`  ${r.name}: ${r.signature} mastered by week: ${JSON.stringify(r.masteredWeeks)}`);
