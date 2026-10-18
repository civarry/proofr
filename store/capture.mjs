// Captures real Proofr UI for the store screenshots into store/captures/:
// the extension runs against a local mock provider that returns fixed,
// realistic text, so every capture is the shipped UI, not a mockup.
//
// usage: PUPPETEER=<path to puppeteer's esm entry> node store/capture.mjs
// Then: node store/render.mjs (composes store/screenshots.html into PNGs).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { default: puppeteer } = await import(process.env.PUPPETEER || 'puppeteer');
const root = path.resolve(new URL('..', import.meta.url).pathname);
const out = path.join(root, 'store/captures');
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Replies keyed on the instruction SR_buildPrompt puts in the prompt.
const REPLIES = [
  [/Correct only the grammar/, 'Hi team, I wanted to give a quick update. The launch is on track, but we hit a small snag with the payment flow. It is being looked at now and should be fixed by the end of the day. I will keep you posted.'],
  [/formal, polished/, 'I wanted to follow up on what we discussed last week. Please let me know whether that time still works for you, or if we should find another one.'],
  [/Summarize the following/, 'The team expected the report on Friday, but it will arrive tomorrow instead, so plan for a short delay.'],
];
const PORT = 8771;
const server = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,content-type' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.url === '/v1/models') { res.writeHead(200, cors); return res.end(JSON.stringify({ data: [{ id: 'mock' }] })); }
  if (req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const prompt = JSON.parse(body).messages[0].content;
      const text = (REPLIES.find(([re]) => re.test(prompt)) || [null, 'Done.'])[1];
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: text } }] }));
    });
    return;
  }
  const file = path.join(root, 'store/demo', req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (file.startsWith(path.join(root, 'store/demo')) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
    return res.end(fs.readFileSync(file));
  }
  res.writeHead(404); res.end();
}).listen(PORT);
const BASE = `http://localhost:${PORT}`;

// Copy with host access granted, standing in for the right-click activeTab grant
// and the hover permission prompt (neither can be clicked by puppeteer).
const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'proofr-shots-'));
for (const f of ['manifest.json', 'background.js', 'constants.js', 'content.js', 'dom-scan.js', 'hover-assist.js', 'modal.css', 'sidepanel.html', 'sidepanel.js', 'icons']) {
  fs.cpSync(path.join(root, f), path.join(ext, f), { recursive: true });
}
const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));

const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [ext], protocolTimeout: 60000, defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 2 } });
try {
  const swT = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
  const extId = new URL(swT.url()).host;
  const sw = await swT.worker();
  const panelURL = `chrome-extension://${extId}/sidepanel.html`;
  const panelShot = async (name) => {
    const p = await browser.newPage();
    await p.setViewport({ width: 400, height: 760, deviceScaleFactor: 2 });
    await p.goto(panelURL);
    await sleep(1500);
    return p;
  };

  // Setup card: first run with no on-device AI and no key (Chrome for Testing has no Nano).
  let p = await panelShot();
  await p.screenshot({ path: `${out}/panel-setup.png` });
  await p.close();

  // From here on: a connected provider (shown in the panel as "Custom").
  await sw.evaluate(async (base) => {
    await chrome.storage.sync.set({ srCloudService: 'custom', srCloudCustomBaseURL: base, srCloudModel_custom: 'mock', srEngine: 'cloud', srLastTone: 'professional' });
    await chrome.storage.local.set({ srCloudKey_custom: 'sk-mock-1234567890', srRateAsked: true });
  }, `${BASE}/v1`);

  // Side panel with a Professional result.
  p = await panelShot();
  await p.evaluate(() => {
    const back = document.getElementById('btnSettingsBack');
    if (back && !document.getElementById('settingsPanel').classList.contains('hidden')) back.click();
  });
  await p.evaluate(() => {
    const ta = document.getElementById('ta');
    ta.value = "hey! just circling back on the thing we chatted about last week. lmk if that still works for u or if we should find another time";
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('sendBtn').click();
  });
  await sleep(2500);
  await p.screenshot({ path: `${out}/panel-result.png` });
  await p.close();

  // Proofread in a text box: before, then after the in-place replace.
  const page = await browser.newPage();
  await page.goto(`${BASE}/`);
  await sleep(800);
  const ta = await page.$$('textarea');
  await ta[0].scrollIntoView();
  await page.evaluate((el) => { el.focus(); el.setSelectionRange(0, el.value.length); }, ta[0]);
  await sleep(300);
  const box = await ta[0].boundingBox();
  const clip = { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 };
  await page.screenshot({ path: `${out}/field-before.png`, clip });
  const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, `${BASE}/`);
  const original = await page.evaluate((el) => el.value, ta[0]);
  await sw.evaluate((id, text) => handleRewrite(id, text, 'grammar', { ensure: true }), tabId, original);
  await sleep(1200);
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.screenshot({ path: `${out}/field-after.png`, clip });

  // A selected paragraph, the backdrop for the right-click frame.
  await page.goto(`${BASE}/`);
  await sleep(800);
  await page.evaluate(() => {
    const el = document.querySelectorAll('p.prose.selectme')[1];
    el.scrollIntoView({ block: 'center' });
    const r = document.createRange(); r.selectNodeContents(el);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  });
  await sleep(300);
  await page.screenshot({ path: `${out}/page-selected.png` });

  // Hover Summarize on an article paragraph.
  await sw.evaluate(() => chrome.storage.sync.set({ srHoverAssist: true }));
  await sleep(800);
  await page.goto(`${BASE}/`);
  await sleep(1000);
  const para = await page.$('p.prose.selectme');
  const pb = await para.boundingBox();
  await page.mouse.move(pb.x + 40, pb.y + 10);
  await sleep(900);
  const icon = await page.waitForSelector('.sr-hover-icon', { timeout: 5000 });
  await icon.click();
  await sleep(500);
  await page.screenshot({ path: `${out}/hover-popover.png` });
  await page.click('.sr-hover-action[data-tone="tldr"]');
  await sleep(2000);
  await page.screenshot({ path: `${out}/hover-result.png` });

  console.log('captured:', fs.readdirSync(out).join(', '));
} finally {
  await browser.close();
  server.close();
  fs.rmSync(ext, { recursive: true, force: true });
}
