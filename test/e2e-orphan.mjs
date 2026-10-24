// After Proofr is reloaded or updated, tabs that were already open keep the
// old copy of its page scripts, which can no longer reach the extension
// (Chrome: "Extension context invalidated"). Using the hover menu or the
// dialog there must not throw; it says to reload the page instead.
//
// usage: PUPPETEER=<path to puppeteer's esm entry> node test/e2e-orphan.mjs [extDir]
const { default: puppeteer } = await import(process.env.PUPPETEER || 'puppeteer');
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const src = path.resolve(process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), '..'));
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Test copy with host access pre-granted (hover needs it; no prompt to click).
const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'proofr-orphan-'));
fs.cpSync(src, ext, { recursive: true, filter: (p) => !/\/(\.git|market-research|store|screenshots|store-screenshots|node_modules|v2shots)(\/|$)/.test(p) });
const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ ...manifest, host_permissions: ['<all_urls>'] }, null, 2));

const demoHtml = fs.readFileSync(path.join(src, 'store/demo/index.html'));
const demo = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(demoHtml); });
await new Promise((r) => demo.listen(8767, r));

const browser = await puppeteer.launch({ headless: false, pipe: true, enableExtensions: [ext], protocolTimeout: 60000, args: ['--window-size=1200,860'] });
try {
  let swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
  let sw = await swTarget.worker();
  await sw.evaluate(async () => { await chrome.storage.sync.set({ srHoverAssist: true }); await syncHoverScripts(); });

  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  // Content-script errors happen in an isolated world, so listen on every context.
  const errors = [];
  const cdp = await page.createCDPSession();
  await cdp.send('Runtime.enable');
  cdp.on('Runtime.exceptionThrown', (e) => errors.push(e.exceptionDetails.exception?.description || e.exceptionDetails.text));
  const worlds = [];
  cdp.on('Runtime.executionContextCreated', (e) => { if (e.context.auxData?.type === 'isolated') worlds.push(e.context.id); });
  // Runs in Proofr's content-script world (where its globals live), not the page's.
  const inProofr = async (expr) => {
    for (const contextId of worlds) {
      const r = await cdp.send('Runtime.evaluate', { expression: `typeof SmartRewriteModal !== 'undefined' ? (${expr}, true) : false`, contextId }).catch(() => null);
      if (r?.result?.value === true) return true;
    }
    return false;
  };
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  await page.goto('http://localhost:8767/'); await sleep(1200);

  const hoverPara = async () => {
    const box = await (await page.$('.wrap p')).boundingBox();
    await page.mouse.move(box.x + 10, box.y + 30); await sleep(200);
    await page.mouse.move(box.x + 40, box.y + 10); await sleep(800);
    return !!(await page.$('.sr-hover-icon'));
  };
  check('hover icon shows before the reload', await hoverPara());

  // Reload the extension; this tab keeps the old scripts.
  await sw.evaluate(() => { chrome.runtime.reload(); }).catch(() => {});
  await sleep(2500);

  // The icon still on screen from before: clicking it.
  const icon = await page.$('.sr-hover-icon');
  if (icon) { await icon.evaluate((el) => el.click()); await sleep(800); }
  const msg = await page.evaluate(() => document.querySelector('#smart-rewrite-modal')?.innerText || '');
  check('clicking the old hover icon says to reload the page', /Reload this page/.test(msg), msg.replace(/\s+/g, ' ').slice(0, 140));
  await page.keyboard.press('Escape'); await sleep(300);
  await page.evaluate(() => document.querySelector('#smart-rewrite-modal .sr-close, #smart-rewrite-modal [aria-label="Close"]')?.click());

  // Then the old copy stands down: no new icon on hover.
  await page.mouse.move(5, 5); await sleep(900);
  check('the old copy stops offering the hover icon', !(await hoverPara()));

  // The dialog's tone buttons in the old copy: no throw, the same message.
  const ran = await inProofr(`(SmartRewriteModal.currentText = 'hello', SmartRewriteModal.rewriteWithTone('professional'))`);
  check('found the old copy\'s dialog', ran);
  await sleep(500);
  const msg2 = await page.evaluate(() => document.querySelector('#smart-rewrite-modal')?.innerText || '');
  check('a tone button in an old dialog says to reload the page', /Reload this page/.test(msg2), msg2.replace(/\s+/g, ' ').slice(0, 140));

  await sleep(500);
  check('no "Extension context invalidated" errors', errors.length === 0, JSON.stringify(errors).slice(0, 400));
} finally {
  await browser.close();
  demo.close();
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  :: ${r.detail}` : ''}`);
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
