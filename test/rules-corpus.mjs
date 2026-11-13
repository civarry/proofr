// Proofr's rules measured on real text (needs a download, so it isn't in the
// offline suite). Two numbers:
//   1. False alarms on correct modern prose: every hit counts against a rule.
//   2. On learner sentences (JFLEG), how often a rule fix matches what a human
//      editor did, and how many sentences the rules touch at all.
// Get the data (JFLEG is CC BY-NC-SA 4.0: use it for measuring, never ship it):
//   git clone --depth 1 https://github.com/keisks/jfleg.git /tmp/corpus/jfleg
//   curl -sL -o /tmp/corpus/pg64317.txt https://www.gutenberg.org/cache/epub/64317/pg64317.txt   # a 1925 novel
// Run:
//   node test/rules-corpus.mjs /tmp/corpus [more correct .txt or .md files...]
// Exits non-zero when any rule fires on the modern prose (the Gutenberg file
// above and the files given); older novels are reported but not counted, since
// their spelling and usage ("an union") is no longer standard.
import fs from 'node:fs';
import path from 'node:path';

globalThis.self = globalThis;
new Function(fs.readFileSync(process.env.CONSTANTS || new URL('../constants.js', import.meta.url), 'utf8'))();
const D = process.argv[2];
if (!D || !fs.existsSync(path.join(D, 'jfleg'))) { console.error('usage: node test/rules-corpus.mjs <dir with jfleg/ and pg64317.txt> [files...]'); process.exit(2); }

// JFLEG is tokenized ("do n't", "word ."); put it back the way people type.
const detok = (s) => s.replace(/ (n't|'s|'re|'ve|'ll|'d|'m)\b/g, '$1').replace(/ ([.,;:!?%)])/g, '$1').replace(/([($]) /g, '$1').replace(/\s+/g, ' ').trim();
const words = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, ' ').split(/\s+/).filter(Boolean).join(' ');

// 1. False alarms on modern prose.
const modern = [];
const gut = path.join(D, 'pg64317.txt');
if (fs.existsSync(gut)) {
  const t = fs.readFileSync(gut, 'utf8');
  const body = t.slice(t.indexOf('\n', t.indexOf('*** START')) + 1, t.indexOf('*** END'));
  for (const p of body.split(/\r?\n\s*\r?\n/)) { const s = p.replace(/\s*\r?\n\s*/g, ' ').trim(); if (s.length > 20) modern.push(['pg64317', s]); }
}
for (const f of process.argv.slice(3)) for (const p of fs.readFileSync(f, 'utf8').split(/\n\s*\n/)) if (p.trim().length > 20) modern.push([path.basename(f), p.trim()]);
// Hits a person read and found to be a real mistake in the "correct" prose,
// so the rule is right. Each is exact (the words around it, the change): any
// other hit still fails. Add only with the reason.
const REVIEWED = new Set([
  'added translate to english|english → English', // a commit message written in lowercase; "English" takes a capital
]);
let alarms = 0, modernWords = 0, reviewed = 0;
for (const [f, s] of modern) {
  modernWords += s.split(/\s+/).length;
  for (const h of SR_ruleCheck(s)) {
    if (REVIEWED.has(`${s.slice(Math.max(0, h.start - 21), h.end).trim()}|${h.from} → ${h.to}`)) { reviewed++; continue; }
    alarms++; console.log(`false alarm ${h.id} (${f}): …${s.slice(Math.max(0, h.start - 40), h.end + 30)}… [${h.from} → ${h.to}]`);
  }
}

// 2. Learner sentences against four human corrections each.
let total = 0, touched = 0, agree = 0, differ = 0;
const byRule = {};
for (const split of ['dev/dev', 'test/test']) {
  const src = fs.readFileSync(path.join(D, 'jfleg', `${split}.src`), 'utf8').split('\n');
  const refs = [0, 1, 2, 3].map((i) => fs.readFileSync(path.join(D, 'jfleg', `${split}.ref${i}`), 'utf8').split('\n'));
  src.forEach((raw, i) => {
    if (!raw.trim()) return;
    total++;
    const s = detok(raw), R = refs.map((r) => detok(r[i] || ''));
    const hits = SR_ruleCheck(s);
    if (hits.length) touched++;
    for (const h of hits) {
      const to = h.to.trim(), from = h.from.trim();
      const caseOnly = to.toLowerCase() === from.toLowerCase();
      // Spacing fixes have no words to compare; the others match a human edit when
      // some correction has the fixed words (and, unless the fix contains the old
      // words, no longer has the old ones).
      const ok = ['space-before', 'double-space', 'space-after-comma'].includes(h.id)
        || R.some((r) => (caseOnly ? r.includes(to) : words(r).includes(words(to)) && (words(to).includes(words(from)) || !words(r).includes(words(from)))));
      (byRule[h.id] ||= { match: 0, differ: 0 })[ok ? 'match' : 'differ']++;
      if (ok) agree++; else { differ++; console.log(`differs ${h.id}: ${from} → ${to} | ${s}`); }
    }
  });
}

console.log(`\nmodern prose: ${modernWords.toLocaleString()} words, ${alarms} false alarm${alarms === 1 ? '' : 's'}${reviewed ? ` (and ${reviewed} reviewed real mistake${reviewed === 1 ? '' : 's'})` : ''}`);
console.log(`learner sentences: ${total}, touched by the rules: ${touched} (${Math.round((touched / total) * 100)}%)`);
console.log(`rule fixes: ${agree + differ}, matching a human editor: ${agree} (${Math.round((agree / (agree + differ)) * 100)}%)`);
console.log(byRule);
process.exit(alarms ? 1 : 0);
