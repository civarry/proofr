// Interaction timings: how long from an action to the first visible response,
// and to the finished result, in a real Chrome with a stand-in provider that
// answers after MOCK_MS (default 600ms, roughly Groq's cloud latency).
// Targets come from market-research/SATISFACTION.md: visible feedback within
// 100ms, a finished cloud result soon after the provider answers.
//
// usage: PUPPETEER=<puppeteer esm entry> node test/perf.mjs [extDir]
const { default: puppeteer } = await import(process.env.PUPPETEER || 'puppeteer');
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const src = path.resolve(process.argv[2] || '.');
const MOCK_MS = Number(process.env.MOCK_MS || 600);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rows = [];
const record = (name, ms, target) => rows.push({ name, ms: Math.round(ms), target, ok: target == null || ms <= target });

// Same test copy as the e2e tests: host access pre-granted so pages can be scripted.
const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'proofr-perf-'));
fs.cpSync(src, ext, { recursive: true, filter: (p) => !/\/(\.git|market-research|store|screenshots|store-screenshots|node_modules)(\/|$)/.test(p) });
const m = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
m.host_permissions = ['<all_urls>'];
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(m));

const page = '<html><body style="font:16px sans-serif;padding:40px"><textarea id="t" style="width:600px;height:80px">We was hoping to recieve it by friday.</textarea><p id="p">Their going to send the report tomorow, it dont matter much.</p></body></html>';
const server = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.url === '/' ) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(page); }
  if (req.url.endsWith('/models')) { res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'mock-chat-1' }] })); }
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', () => setTimeout(() => {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'We were hoping to receive it by Friday.' }, finish_reason: 'stop' }] }));
  }, MOCK_MS));
});
await new Promise(r => server.listen(8799, r));

const browser = await puppeteer.launch({ headless: false, pipe: true, enableExtensions: [ext], protocolTimeout: 60000, defaultViewport: { width: 1280, height: 800 } });
const swT = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
const sw = await swT.worker();
const extId = new URL(swT.url()).host;
await sw.evaluate(async () => {
  await chrome.storage.sync.set({ srCloudService: 'custom', srCloudCustomBaseURL: 'http://localhost:8799/v1', srCloudModel_custom: 'mock-chat-1', srEngine: 'cloud' });
  await chrome.storage.local.set({ srCloudKey_custom: 'perf-key-123456' });
});
for (const p of await browser.pages()) if (p.url().includes('welcome')) await p.close();

// Times inside the page from an action to the first DOM change where
// `ready()` is true (MutationObserver). It doesn't wait for paint, so it
// measures our code's response, not the screen: with the screen locked,
// Chrome doesn't paint at all and requestAnimationFrame never fires.
const timeIn = (pg, action, ready, timeout = 15000) => pg.evaluate((actionSrc, readySrc, timeout) => new Promise((resolve) => {
  const act = new Function(actionSrc), isReady = new Function(`return (${readySrc})`);
  const t0 = performance.now();
  const check = () => { if (isReady()) { obs.disconnect(); resolve(performance.now() - t0); } };
  const obs = new MutationObserver(check);
  obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  setTimeout(() => { obs.disconnect(); resolve(Infinity); }, timeout);
  act(); check();
}), action, ready, timeout);

// === Side panel ===
const panel = await browser.newPage();
await panel.setViewport({ width: 400, height: 800 });
let t0 = Date.now();
await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
await panel.waitForFunction(() => document.querySelector('.thread-empty, .turn') && document.getElementById('providerPillText').textContent !== 'Checking…');
record('Panel opens, ready to type', Date.now() - t0, 1000);
await sleep(500);

await panel.evaluate(() => { const t = document.getElementById('ta'); t.value = 'We was hoping to recieve it by friday.'; t.dispatchEvent(new Event('input')); });
record('Send → card appears', await timeIn(panel, "document.getElementById('sendBtn').click()", "!!document.querySelector('.turn .assistant-card')"), 100);
await sleep(MOCK_MS + 1500);
await panel.evaluate(() => { const t = document.getElementById('ta'); t.value = 'We was hoping to recieve it by friday.'; t.dispatchEvent(new Event('input')); });
const before = await panel.evaluate(() => document.querySelectorAll('.turn').length);
record('Send → finished result shown', await timeIn(panel, "document.getElementById('sendBtn').click()", `document.querySelectorAll('.turn').length > ${before} && !!document.querySelectorAll('.turn')[document.querySelectorAll('.turn').length-1].querySelector('.assistant-actions')`), MOCK_MS + 300);
record('Status pill → menu open', await timeIn(panel, "document.getElementById('providerPill').click()", "!document.getElementById('engineMenu').classList.contains('hidden') && document.querySelectorAll('#engineMenu .engine-item').length > 0"), 100);
await panel.evaluate(() => document.body.click());
record('Settings → visible', await timeIn(panel, "document.getElementById('btnSettings').click()", "!document.getElementById('settingsPanel').classList.contains('hidden')"), 100);
record('Settings → model list loaded', await timeIn(panel, '', "/available/.test(document.getElementById('modelHint').textContent)", 5000), 1000);
record('Settings → back', await timeIn(panel, "document.getElementById('btnSettingsBack').click()", "document.getElementById('settingsPanel').classList.contains('hidden')"), 100);
await panel.evaluate(() => [...document.querySelectorAll('.turn')].at(-1).querySelector('[data-action=copy]').click());
record('Copy → "Copied" shown', await timeIn(panel, "[...document.querySelectorAll('.turn')].at(-1).querySelectorAll('[data-action=copy]').forEach(b=>b.click())", "!![...document.querySelectorAll('.turn')].at(-1).querySelector('.copied')"), 100);

// === On a page: right-click proofread in a text box (in place) and on page text (dialog) ===
const demo = await browser.newPage();
await demo.goto('http://localhost:8799/'); await sleep(500);
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'http://localhost:8799/*' }))[0].id);
await demo.evaluate(() => { const t = document.getElementById('t'); t.focus(); t.select(); });
const tStart = Date.now();
sw.evaluate((id) => handleRewrite(id, 'We was hoping to recieve it by friday.', 'grammar', { ensure: true }), tabId);
await demo.waitForFunction(() => document.getElementById('sr-loading-toast') || document.querySelector('#smart-rewrite-modal.sr-visible'), { timeout: 5000, polling: 10 }).catch(() => {});
record('Text box: action → "working" visible', Date.now() - tStart, 300);
await demo.waitForFunction(() => /Fixed|Nothing/.test(document.querySelector('.sr-success-notification')?.textContent || ''), { timeout: 10000, polling: 10 }).catch(() => {});
record('Text box: action → fixed + toast', Date.now() - tStart, MOCK_MS + 500);
await sleep(800);
await demo.evaluate(() => { const sel = window.getSelection(); sel.selectAllChildren(document.getElementById('p')); document.activeElement.blur(); });
const pStart = Date.now();
sw.evaluate((id) => handleRewrite(id, 'Their going to send the report tomorow, it dont matter much.', 'grammar', { ensure: true }), tabId);
await demo.waitForFunction(() => document.querySelector('#smart-rewrite-modal.sr-visible'), { timeout: 5000, polling: 10 }).catch(() => {});
record('Page text: action → dialog visible', Date.now() - pStart, 300);
await demo.waitForFunction(() => document.querySelector('#smart-rewrite-modal #sr-copy-btn'), { timeout: 10000, polling: 10 }).catch(() => {});
record('Page text: action → result in dialog', Date.now() - pStart, MOCK_MS + 500);

await browser.close();
server.close();
fs.rmSync(ext, { recursive: true, force: true });
console.log(`Stand-in provider answers after ${MOCK_MS}ms.\n`);
for (const r of rows) console.log(`${r.ok ? 'OK  ' : 'SLOW'}  ${String(r.ms).padStart(6)} ms  ${r.name}${r.target != null ? `  (target ≤ ${r.target})` : ''}`);
