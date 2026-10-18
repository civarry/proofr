// Renders the five frames in store/screenshots.html (which embed the real UI
// captured by store/capture.mjs) to store/frames/, then converts them to the
// store spec (1280×800, 24-bit PNG, no alpha) in store-screenshots/.
//
// usage: PUPPETEER=<path to puppeteer's esm entry> node store/render.mjs
// Uses chrome-headless-shell, which renders even while the screen is locked.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const { default: puppeteer } = await import(process.env.PUPPETEER || 'puppeteer');
const store = path.resolve(new URL('.', import.meta.url).pathname);
const frames = path.join(store, 'frames');

const missing = ['field-before', 'field-after', 'page-selected', 'panel-result', 'panel-setup', 'hover-result']
  .filter((n) => !fs.existsSync(path.join(store, 'captures', `${n}.png`)));
if (missing.length) { console.error(`missing captures (run store/capture.mjs): ${missing.join(', ')}`); process.exit(1); }

fs.rmSync(frames, { recursive: true, force: true });
fs.mkdirSync(frames);
const browser = await puppeteer.launch({ headless: 'shell', args: ['--allow-file-access-from-files'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  await page.goto(`file://${path.join(store, 'screenshots.html')}`, { waitUntil: 'networkidle0' });
  const els = await page.$$('.frame');
  if (els.length !== 5) throw new Error(`expected 5 frames, found ${els.length}`);
  for (const [i, el] of els.entries()) await el.screenshot({ path: path.join(frames, `frame-${i + 1}.png`) });
} finally {
  await browser.close();
}
execFileSync('python3', ['-I', path.join(store, 'prep_screenshots.py'), frames, '--out', path.join(store, '..', 'store-screenshots')], { stdio: 'inherit' });
