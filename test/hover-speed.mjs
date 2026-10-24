// How long hover detection (dom-scan.js resolveBlock) takes on heavy pages,
// old code against new, and that both pick the same block for every target.
//   PUPPETEER=<puppeteer esm entry> node test/hover-speed.mjs
//   OLD=path/to/dom-scan.js ...   (default: the version before the speed work, fda50bf)
//
// Pages are built in the browser: a Gmail-like message (deep wrappers, one div
// per line, a big sidebar), a Reddit-like thread (nested comments), and a worst
// case (thousands of inline spans with no block inside, under deep wrappers).
// "cold" is the first hover on each target after a page change; "warm" is the
// same target again, as when the pointer rests and moves within a paragraph.
const { default: puppeteer } = await import(process.env.PUPPETEER || 'puppeteer');
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const repo = new URL('..', import.meta.url).pathname;
const NEW = fs.readFileSync(process.env.NEW || `${repo}dom-scan.js`, 'utf8');
const OLD = process.env.OLD ? fs.readFileSync(process.env.OLD, 'utf8') : execSync('git show fda50bf:dom-scan.js', { cwd: repo }).toString();

const failures = [];
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
await page.setContent('<!doctype html><html><body></body></html>');

// Load each version under its own name.
for (const [name, src] of [['OLD', OLD], ['NEW', NEW]]) {
  await page.evaluate((code, n) => { delete self.SR_DOM; new Function(code)(); self[`SR_DOM_${n}`] = self.SR_DOM; delete self.SR_DOM; }, src, name);
}

const builders = {
  gmail: () => {
    let root = document.body;
    for (let i = 0; i < 18; i++) { const d = document.createElement('div'); d.className = `w${i}`; root.appendChild(d); root = d; }
    const side = document.createElement('div');
    for (let i = 0; i < 1500; i++) { const s = document.createElement('span'); s.textContent = `Label ${i} `; side.appendChild(s); }
    root.appendChild(side);
    const msg = document.createElement('div');
    for (let i = 0; i < 30; i++) { const l = document.createElement('div'); l.textContent = `This is line ${i} of the message, long enough to count.`; msg.appendChild(l); }
    root.appendChild(msg);
    for (let m = 0; m < 40; m++) {
      const row = document.createElement('div');
      row.innerHTML = `<div><div><span><b>Sender ${m}</b></span><span>Subject line number ${m} with some words</span><span> - a preview of the message text ${m}</span></div></div>`;
      root.appendChild(row);
    }
  },
  reddit: () => {
    const main = document.createElement('main');
    document.body.appendChild(main);
    const comment = (depth) => {
      const c = document.createElement('div'); c.className = 'comment';
      c.innerHTML = `<div class="meta"><a href="#">user${depth}</a><span> 3h ago</span></div><div class="body"><p>This is a comment at depth ${depth} saying something useful about the post.</p><p>A second paragraph with <a href="#">a link</a> and <em>emphasis</em> in it.</p></div><div class="actions"><button>Reply</button><button>Share</button></div>`;
      if (depth < 6) for (let k = 0; k < 2; k++) c.appendChild(comment(depth + 1));
      return c;
    };
    for (let i = 0; i < 6; i++) main.appendChild(comment(0));
  },
  worst: () => {
    let root = document.body;
    for (let i = 0; i < 25; i++) { const d = document.createElement('div'); root.appendChild(d); root = d; }
    const big = document.createElement('div');
    for (let i = 0; i < 4000; i++) { const s = document.createElement('span'); s.textContent = `word${i} `; big.appendChild(s); }
    root.appendChild(big);
    const p = document.createElement('div');
    p.textContent = 'A short note next to the big inline run, long enough to count.';
    root.appendChild(p);
  },
};

const results = {};
for (const [name, build] of Object.entries(builders)) {
  const r = await page.evaluate((buildSrc) => {
    document.body.innerHTML = '';
    new Function(`return (${buildSrc})`)()();
    // Every element with its own text is a hover target; sample them evenly.
    const all = [...document.body.querySelectorAll('*')].filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
    const step = Math.max(1, Math.floor(all.length / 300));
    const targets = all.filter((_, i) => i % step === 0);
    const id = (b) => (b ? `${[...document.querySelectorAll('*')].indexOf(b.el)}|${b.text}` : 'null');
    const time = (api) => {
      const cold = [], warm = [], picks = [];
      for (const t of targets) {
        if (api.invalidate) api.invalidate(); // a page change between hovers: nothing cached
        let t0 = performance.now(); const b = api.resolveBlock(t.firstChild || t); cold.push(performance.now() - t0);
        t0 = performance.now(); api.resolveBlock(t.firstChild || t); warm.push(performance.now() - t0);
        picks.push(id(b));
      }
      const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
      const stats = (a) => ({ median: q(a, 0.5), p95: q(a, 0.95), max: Math.max(...a), total: a.reduce((x, y) => x + y, 0) });
      return { cold: stats(cold), warm: stats(warm), picks };
    };
    const old = time(self.SR_DOM_OLD), neu = time(self.SR_DOM_NEW);
    const differ = old.picks.map((p, i) => (p === neu.picks[i] ? null : { i, old: p.slice(0, 80), new: neu.picks[i].slice(0, 80) })).filter(Boolean);
    return { targets: targets.length, elements: document.body.querySelectorAll('*').length, old: { cold: old.cold, warm: old.warm }, new: { cold: neu.cold, warm: neu.warm }, differ };
  }, build.toString());
  results[name] = r;
}
await browser.close();

const ms = (x) => `${x.toFixed(2)}ms`;
for (const [name, r] of Object.entries(results)) {
  console.log(`\n${name}: ${r.elements} elements, ${r.targets} hover targets`);
  for (const k of ['cold', 'warm']) {
    console.log(`  ${k.padEnd(4)} old median ${ms(r.old[k].median)} p95 ${ms(r.old[k].p95)} max ${ms(r.old[k].max)}   new median ${ms(r.new[k].median)} p95 ${ms(r.new[k].p95)} max ${ms(r.new[k].max)}`);
  }
  if (r.differ.length) failures.push(`${name}: new code picks a different block for ${r.differ.length} target(s), e.g. ${JSON.stringify(r.differ[0])}`);
  // One frame is 16ms; a hover lookup should never cost a noticeable share of one.
  if (r.new.cold.max > 4) failures.push(`${name}: slowest cold lookup ${ms(r.new.cold.max)} (limit 4ms)`);
  if (r.new.warm.max > 0.5) failures.push(`${name}: slowest repeat lookup ${ms(r.new.warm.max)} (limit 0.5ms)`);
}
if (failures.length) { for (const f of failures) console.log(`FAIL  ${f}`); process.exit(1); }
console.log('\nhover-speed: all checks passed');
