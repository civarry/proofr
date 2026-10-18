// Runs the extension exactly as it ships: the real manifest, no pre-granted
// site access. The other browser tests pre-grant <all_urls> so they can
// script pages; this one checks what a user without that grant gets.
//
// usage: PUPPETEER=<puppeteer esm entry> node test/e2e-shipped.mjs [extDir]
const { default: puppeteer } = await import(process.env.PUPPETEER || 'puppeteer');
import http from 'node:http';
import path from 'node:path';

const ext = path.resolve(process.argv[2] || '.');
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const page = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<p>Some text on a page that the user never used Proofr on.</p>'); });
await new Promise(r => page.listen(8797, r));

const b = await puppeteer.launch({ headless: false, pipe: true, enableExtensions: [ext], protocolTimeout: 30000 });
const swT = await b.waitForTarget(t => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
const sw = await swT.worker();
const swErrors = [];
const cdp = await swT.createCDPSession();
await cdp.send('Runtime.enable');
cdp.on('Runtime.exceptionThrown', (e) => swErrors.push(e.exceptionDetails?.exception?.description || 'exception'));
cdp.on('Runtime.consoleAPICalled', (e) => { if (e.type === 'error') swErrors.push(e.args.map(a => a.value).join(' ')); });

const perms = await sw.evaluate(() => chrome.permissions.getAll());
check('fresh install holds no site access', perms.origins.length === 0, JSON.stringify(perms.origins));

const tab = await b.newPage();
await tab.goto('http://localhost:8797/'); await sleep(500);
check('nothing injected into a page by default', await tab.evaluate(() => !document.querySelector('#smart-rewrite-modal, .sr-hover-icon, link[href*="fonts.googleapis"]')));

// Without a user gesture there's no activeTab grant: the rewrite path must fail quietly.
// Without host access the extension can't even see tab URLs, so take the newest tab.
const tabId = await sw.evaluate(async () => Math.max(...(await chrome.tabs.query({})).map(t => t.id)));
await sw.evaluate((id) => handleRewrite(id, 'some text', 'grammar', { ensure: true }), tabId);
await sleep(800);
check('no access → no page changes', await tab.evaluate(() => !document.querySelector('#smart-rewrite-modal')));

// Hover setting forced on without the permission: scripts must not register,
// and the setting must snap back off.
await sw.evaluate(() => chrome.storage.sync.set({ srHoverAssist: true }));
await sleep(1200);
const regs = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
check('hover without permission registers nothing', regs.length === 0, JSON.stringify(regs.map(r => r.id)));
check('hover setting resets to off without permission', (await sw.evaluate(() => chrome.storage.sync.get(['srHoverAssist']))).srHoverAssist === false);

check('service worker: no errors or uncaught exceptions', swErrors.length === 0, swErrors.join(' | '));

await b.close();
page.close();
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  :: ' + r.detail : ''}`);
process.exit(results.every(r => r.ok) ? 0 : 1);
