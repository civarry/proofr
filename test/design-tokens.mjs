// One design system across the side panel, welcome tab, and in-page UI:
// shared palette, a 7-step type scale, 4 corner radii, and text colors that
// pass WCAG AA (4.5:1) on both page backgrounds. Fails on any drift.
//
// usage: node test/design-tokens.mjs
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (f) => fs.readFileSync(path.join(repo, f), 'utf8');
const styleOf = (html) => [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
const surfaces = {
  'sidepanel.html': styleOf(read('sidepanel.html')),
  'welcome.html': styleOf(read('welcome.html')),
  'modal.css': read('modal.css'),
};

const failures = [];
const fail = (msg) => failures.push(msg);

const SIZES = new Set([11, 12, 13, 14, 15, 18, 24]);
const RADII = new Set(['4px', '8px', '12px', '999px', '50%']);
for (const [file, css] of Object.entries(surfaces)) {
  for (const m of css.matchAll(/font-size:\s*([\d.]+)px/g)) {
    if (!SIZES.has(Number(m[1]))) fail(`${file}: font-size ${m[1]}px is off the type scale`);
  }
  for (const m of css.matchAll(/border-radius:\s*([^;]+);/g)) {
    for (const part of m[1].trim().split(/\s+/)) {
      if (!RADII.has(part) && !/^var\(--radius/.test(part)) fail(`${file}: border-radius ${part} is off the radius scale`);
    }
  }
  if (/font-family:[^;]*Inter/.test(css)) fail(`${file}: names Inter, which is never loaded`);
}

// Light and dark palettes are read separately: the dark set lives in the
// file's prefers-color-scheme: dark block.
const tokensIn = (css) => Object.fromEntries([...css.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{3,8})/g)].map((m) => [m[1], m[2].toLowerCase()]));
const split = (css) => {
  const i = css.indexOf('@media (prefers-color-scheme: dark)');
  if (i < 0) return { light: tokensIn(css), dark: null };
  // the dark block: from its opening brace to the matching close
  let depth = 0, j = css.indexOf('{', i), start = j;
  for (; j < css.length; j++) { if (css[j] === '{') depth++; else if (css[j] === '}' && --depth === 0) break; }
  return { light: tokensIn(css.slice(0, i) + css.slice(j + 1)), dark: tokensIn(css.slice(start, j)) };
};
const lum = (hex) => {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
// A missing token counts as failing (ratio 0), so the check reports it.
const ratio = (a, b) => { if (!a || !b) return 0; const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const P = split(surfaces['sidepanel.html']);
const W = split(surfaces['welcome.html']);
const G = split(surfaces['modal.css']);
for (const theme of ['light', 'dark']) {
  const panel = P[theme], welcome = W[theme], page = G[theme];
  if (!panel || !welcome || !page) { fail(`${theme}: a surface has no ${theme} palette`); continue; }
  // Shared palette: panel and welcome declare the same values.
  for (const [k, v] of Object.entries(welcome)) {
    if (panel[k] && panel[k] !== v) fail(`${theme}: welcome ${k} ${v} differs from the side panel's ${panel[k]}`);
  }
  for (const [panelKey, pageKey] of [['--paper', '--sr-white'], ['--ink', '--sr-primary'], ['--ink-faint', '--sr-gray-500'], ['--ink-soft', '--sr-gray-600']]) {
    if (panel[panelKey] !== page[pageKey]) fail(`${theme}: in-page ${pageKey} ${page[pageKey]} differs from the panel's ${panelKey} ${panel[panelKey]}`);
  }
  // Contrast: every text token passes AA on the backgrounds it sits on.
  for (const k of ['--ink', '--ink-soft', '--ink-faint', '--live-ink', '--error']) {
    for (const bg of [panel['--paper'], panel['--card']]) if (ratio(panel[k], bg) < 4.5) fail(`${theme}: panel ${k} ${panel[k]} is ${ratio(panel[k], bg).toFixed(2)}:1 on ${bg}`);
  }
  // Word-strip dots are graphics: 3:1 against the card (WCAG 1.4.11).
  for (const k of ['--dot-fixed', '--dot-right']) if (ratio(panel[k], panel['--card']) < 3) fail(`${theme}: ${k} ${panel[k]} is ${ratio(panel[k], panel['--card']).toFixed(2)}:1 on cards`);
  if (ratio(panel['--warn-ink'], panel['--warn-bg']) < 4.5) fail(`${theme}: practice miss text is ${ratio(panel['--warn-ink'], panel['--warn-bg']).toFixed(2)}:1 on its fill`);
  if (ratio(panel['--accent-fg'], panel['--accent']) < 4.5) fail(`${theme}: button text on accent is ${ratio(panel['--accent-fg'], panel['--accent']).toFixed(2)}:1`);
  for (const k of ['--sr-gray-500', '--sr-gray-600', '--sr-gray-900', '--sr-error', '--sr-del-fg', '--sr-notice-fg']) {
    for (const bg of [page['--sr-white'], page['--sr-gray-50']]) if (ratio(page[k], bg) < 4.5) fail(`${theme}: in-page ${k} ${page[k]} is ${ratio(page[k], bg).toFixed(2)}:1 on ${bg}`);
  }
  if (ratio(page['--sr-ins-fg'], page['--sr-ins-bg']) < 4.5) fail(`${theme}: inserted-word text is ${ratio(page['--sr-ins-fg'], page['--sr-ins-bg']).toFixed(2)}:1 on its highlight`);
  // Brand accent: one value on every surface, readable on and as text.
  if (panel['--accent'] !== page['--sr-accent']) fail(`${theme}: in-page accent ${page['--sr-accent']} differs from the panel's ${panel['--accent']}`);
  if (welcome['--accent'] && welcome['--accent'] !== panel['--accent']) fail(`${theme}: welcome accent ${welcome['--accent']} differs from the panel's`);
  if (ratio(page['--sr-on-accent'], page['--sr-accent']) < 4.5) fail(`${theme}: text on the in-page accent is ${ratio(page['--sr-on-accent'], page['--sr-accent']).toFixed(2)}:1`);
  if (ratio(panel['--accent-ink'], panel['--accent-tint']) < 4.5) fail(`${theme}: accent text on its tint is ${ratio(panel['--accent-ink'], panel['--accent-tint']).toFixed(2)}:1`);
  if (ratio(panel['--accent-ink'], panel['--card']) < 4.5) fail(`${theme}: accent text on cards is ${ratio(panel['--accent-ink'], panel['--card']).toFixed(2)}:1`);
  if (ratio(page['--sr-on-primary'], page['--sr-primary']) < 4.5) fail(`${theme}: text on ink fills is ${ratio(page['--sr-on-primary'], page['--sr-primary']).toFixed(2)}:1`);
}
// Grays too faint for text must only be used for borders and fills.
if (/(?<![-\w])color:\s*var\(--sr-gray-(300|400)\)/.test(surfaces['modal.css'])) fail('modal.css uses gray-300/400 as a text color (fails AA)');

if (failures.length) {
  for (const f of failures) console.log(`FAIL  ${f}`);
  console.log(`${failures.length} design-token failure(s)`);
  process.exit(1);
}
console.log('design-tokens: all checks passed');
