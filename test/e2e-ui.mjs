// UI end-to-end checks: welcome tab, first-run key save, side panel result,
// rating ask, translate prompt language, in-place replace + undo, hover
// permission/registration, setup errors. Every check can fail; run against
// an older commit to see which.
//
// usage: PUPPETEER=<path to puppeteer's esm entry> node test/e2e-ui.mjs [extDir] [outDir]
// Serves store/demo on :8765 and a mock OpenAI-compatible provider on :8766.
// On macOS with the display asleep Chrome stops painting; run
// `caffeinate -u -t 600 &` first. NO_SHOTS=1 skips screenshots.
const { default: puppeteer } = await import(process.env.PUPPETEER || 'puppeteer');
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const src = path.resolve(process.argv[2] || '.');
const out = path.resolve(process.argv[3] || './v2shots');
fs.mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// DOM-level click/focus: puppeteer's mouse click waits on rendering, which stalls when the display sleeps.
const clk = (pg, sel) => pg.$eval(sel, (el) => el.click()).catch(() => console.log('missing:', sel));
const focusSel = (pg, sel) => pg.$eval(sel, (el) => el.focus()).catch(() => console.log('missing:', sel));
const shot = (pg, file) => process.env.NO_SHOTS ? Promise.resolve() : pg.screenshot({ path: `${out}/${file}` }).catch(() => {});

// Static checks on the real manifest (what ships).
const realManifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
check('manifest: no static content_scripts', !realManifest.content_scripts);
check('manifest: no required host_permissions', !realManifest.host_permissions);
check('manifest: shortcut is a rebindable command', !!realManifest.commands?.['proofread-selection']);
check('no remote font import in modal.css', !/fonts\.googleapis/.test(fs.readFileSync(path.join(src, 'modal.css'), 'utf8')));

// Test copy: identical code, but host access pre-granted so chrome.permissions.request()
// resolves without a prompt puppeteer can't click. Everything else is the shipped code.
const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'proofr-test-'));
fs.cpSync(src, ext, { recursive: true, filter: (p) => !/\/(\.git|market-research|store|screenshots|store-screenshots|node_modules)(\/|$)/.test(p) });
const m = { ...realManifest, host_permissions: ['<all_urls>'] };
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(m, null, 2));

// Mock provider: records request bodies, answers /models and /chat/completions.
const mockRequests = [];
const mock = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', () => {
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock-chat-1' }, { id: 'mock-embed-1' }] }));
    }
    const parsed = JSON.parse(body || '{}');
    mockRequests.push(parsed);
    // Echo the text being rewritten, so a test can tell whose result landed
    // where. Text containing SLOW is answered after 2.5s.
    const prompt = parsed.messages?.[0]?.content || '';
    const input = (prompt.match(/"""\n([\s\S]*?)\n"""/) || [, ''])[1].trim();
    const reply = () => {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: `R(${input})` }, finish_reason: 'stop' }] }));
    };
    if (/SLOW/.test(input)) setTimeout(reply, 2500); else reply();
  });
});
await new Promise(r => mock.listen(8766, r));
const demoHtml = fs.readFileSync(path.join(src, 'store/demo/index.html'));
const demoServer = http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/index.html')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(demoHtml); }
  res.writeHead(404); res.end();
});
await new Promise(r => demoServer.listen(8765, r));

const browser = await puppeteer.launch({
  headless: false, pipe: true, enableExtensions: [ext], protocolTimeout: 60000,
  args: ['--window-size=1280,860'], defaultViewport: { width: 1280, height: 800 },
});
const errors = [];
const fontRequests = [];
const watch = (p, tag) => {
  p.on('pageerror', e => errors.push(`[${tag}] ${e.message}`));
  // 404s are judged by URL below (the demo page has no favicon); every other console error counts.
  p.on('console', mm => { if (mm.type() === 'error' && !/^Failed to load resource/.test(mm.text())) errors.push(`[${tag}] ${mm.text()}`); });
  p.on('response', r => { if (r.status() >= 400 && !/favicon\.ico$/.test(r.url())) errors.push(`[${tag}] HTTP ${r.status()} ${r.url()}`); });
  p.on('dialog', d => { errors.push(`[${tag}] unexpected ${d.type()}: ${d.message()}`); d.dismiss(); });
  p.on('request', r => { if (/fonts\.(googleapis|gstatic)/.test(r.url())) fontRequests.push(r.url()); });
};
const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
const extId = new URL(swTarget.url()).host;
const sw = await swTarget.worker();
sw.on('console', mm => { if (mm.type() === 'error') errors.push(`[sw] ${mm.text()}`); });

console.log('STEP 1');
// 1. Install opens the welcome tab.
const welcomeT = await browser.waitForTarget(t => t.url().includes('sidepanel.html?welcome=1'), { timeout: 10000 }).catch(() => null);
check('install opens welcome tab', !!welcomeT);
if (welcomeT) {
  const wp = await welcomeT.page(); watch(wp, 'welcome');
  await sleep(800);
  check('welcome card visible', await wp.evaluate(() => !document.getElementById('welcomeCard').classList.contains('hidden')));
  check('welcome shows no-AI setup card', await wp.evaluate(() => !document.getElementById('setupCard').classList.contains('hidden')));
  await shot(wp, '1-welcome.png');
  await wp.close();
}

console.log('STEP 2');
// 2. Demo page with nothing enabled: no Proofr UI, no font requests.
const demo = await browser.newPage(); watch(demo, 'demo');
await demo.goto('http://localhost:8765/index.html'); await sleep(700);
const p = await demo.$('.wrap p');
let box = await p.boundingBox();
await demo.mouse.move(box.x + 30, box.y + 8); await sleep(700);
check('no hover icon by default (no content script)', !(await demo.$('.sr-hover-icon')));

console.log('STEP 3');
// 3. First-run key Save with an empty field (the bug: Save cleared the pasted key).
const panel = await browser.newPage(); watch(panel, 'panel');
await panel.setViewport({ width: 400, height: 800 });
await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
await panel.evaluate(() => chrome.storage.sync.set({ srCloudService: 'custom', srCloudCustomBaseURL: 'http://localhost:8766/v1' }));
await panel.reload(); await sleep(1000);
await panel.bringToFront();
await focusSel(panel, '#apiKeyInput');
await panel.keyboard.type('test-key-123456');
await clk(panel, '#btnSaveKey'); await sleep(1500);
const stored = await panel.evaluate(() => chrome.storage.local.get(['srCloudKey_custom']));
check('first-run Save stores the pasted key (local)', stored.srCloudKey_custom === 'test-key-123456', JSON.stringify(stored));
const synced = await panel.evaluate(() => chrome.storage.sync.get(['srCloudKey_custom']));
check('key not in sync storage', !synced.srCloudKey_custom);
const model = await panel.evaluate(() => chrome.storage.sync.get(['srCloudModel_custom']));
console.log('model after save:', JSON.stringify(model));

console.log('STEP 4');
// 4. Successful side panel rewrite through the mock, plus the rating line.
await panel.evaluate(() => chrome.storage.local.set({ rewriteStats: { totalRewrites: 4, styleUsage: {}, lastUsed: null } }));
await panel.evaluate(() => document.getElementById('btnSettingsBack').click());
await focusSel(panel, '#ta'); await panel.keyboard.type('we was going to the store yesterday');
await clk(panel, '#sendBtn'); await sleep(2500);
const card = await panel.evaluate(() => [...document.querySelectorAll('.turn')].at(-1)?.querySelector('.assistant-body')?.innerText || '');
check('side panel rewrite succeeds end-to-end', /^R\(we was going/.test(card), card.slice(0, 80));
check('rating line shown after 5th success', await panel.evaluate(() => !!document.querySelector('.rate-line')));
await shot(panel, '2-panel-result.png');
await clk(panel, '.rate-line [data-rate="later"]'); await sleep(300);
check('Not now records srRateAsked', (await panel.evaluate(() => chrome.storage.local.get(['srRateAsked']))).srRateAsked === true);
await panel.reload(); await sleep(800);
check('rating line gone after Not now', await panel.evaluate(() => !document.querySelector('.rate-line')));

console.log('STEP 5');
// 5. Translate prompt names the real language (board T2).
mockRequests.length = 0;
await sw.evaluate(() => chrome.storage.sync.set({ srLastTone: 'translate', srTargetLang: 'ko' }));
await panel.reload(); await sleep(800);
await focusSel(panel, '#ta'); await panel.keyboard.type('good morning team');
await clk(panel, '#sendBtn'); await sleep(2000);
const lastPrompt = mockRequests.at(-1)?.messages?.[0]?.content || '';
check('Korean translate prompt says Korean', /into Korean/.test(lastPrompt), (lastPrompt.match(/Translate the following text into [^.]+/) || [''])[0]);

console.log('STEP 6');
// 6. Right-click flow (SW handleRewrite) into a textarea: in-place, undoable.
await demo.bringToFront();
await demo.evaluate(() => {
  const ta = document.createElement('textarea'); ta.id = 'probe'; ta.value = 'hello we was here ok'; ta.style.cssText = 'position:fixed;top:10px;left:10px;width:400px;height:60px;z-index:99999';
  document.body.appendChild(ta); ta.focus(); ta.setSelectionRange(6, 12); // exactly "we was"
});
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'http://localhost:8765/*' }))[0].id);
await sw.evaluate((id) => handleRewrite(id, 'we was', 'grammar', { ensure: true }), tabId); await sleep(1500);
const after = await demo.evaluate(() => document.getElementById('probe').value);
check('in-place replace in textarea', after === 'hello R(we was) here ok', after);
await demo.evaluate(() => document.getElementById('probe').focus());
// Synthetic Cmd+Z doesn't reach macOS editing commands; name the command, which is what the real keystroke maps to.
await demo.keyboard.down('Meta'); await demo.keyboard.press('KeyZ', { commands: ['undo'] }); await demo.keyboard.up('Meta'); await sleep(300);
const undone = await demo.evaluate(() => document.getElementById('probe').value);
check('Cmd+Z restores original after replace', undone === 'hello we was here ok', undone);
// Two rewrites in flight: each result must land on its own selection (board N1).
await demo.evaluate(() => {
  const mk = (id, top, v) => { const t = document.createElement('textarea'); t.id = id; t.value = v; t.style.cssText = `position:fixed;top:${top}px;left:10px;width:400px;height:40px;z-index:99999`; document.body.appendChild(t); return t; };
  const a = mk('ta-a', 90, 'first SLOW alpha end'); mk('ta-b', 140, 'second beta end');
  a.focus(); a.setSelectionRange(6, 16); // "SLOW alpha"
});
const pA = sw.evaluate((id) => handleRewrite(id, 'SLOW alpha', 'grammar', { ensure: true }), tabId);
await sleep(600);
await demo.evaluate(() => { const b = document.getElementById('ta-b'); b.focus(); b.setSelectionRange(7, 11); }); // "beta"
await sw.evaluate((id) => handleRewrite(id, 'beta', 'grammar', { ensure: true }), tabId);
await pA; await sleep(800);
const [va, vb] = await demo.evaluate(() => [document.getElementById('ta-a').value, document.getElementById('ta-b').value]);
check('overlapping rewrites: B gets only its own result', vb === 'second R(beta) end', vb);
check('overlapping rewrites: A replaced in place, not B', va === 'first R(SLOW alpha) end', va);

// Control: the old direct value assignment is NOT undoable. Proves the undo check can fail.
await demo.evaluate(() => { const t = document.getElementById('probe'); t.value = 'hello we was here ok'; t.focus(); t.setSelectionRange(6, 12); t.value = 'hello XX here ok'; });
await demo.keyboard.down('Meta'); await demo.keyboard.press('KeyZ', { commands: ['undo'] }); await demo.keyboard.up('Meta'); await sleep(300);
check('control: direct value write is not undoable', (await demo.evaluate(() => document.getElementById('probe').value)) === 'hello XX here ok');

console.log('STEP 7');
// 6b. Side panel on Auto with a key while the on-device model still needs its
// download: must use the key, not start the download mid-rewrite (board N5).
await panel.bringToFront();
await panel.evaluate(() => chrome.storage.sync.set({ srLastTone: 'grammar', srEngine: 'auto' }));
await panel.reload(); await sleep(900);
await panel.evaluate(() => {
  window.__createCalls = 0;
  SR_deviceAvailability = async () => 'downloadable';
  SR_deviceModel = () => ({ availability: async () => 'downloadable', create: async () => { window.__createCalls++; return new Promise(() => {}); } });
  if (!document.getElementById('settingsPanel').classList.contains('hidden')) document.getElementById('btnSettingsBack').click();
});
await focusSel(panel, '#ta'); await panel.keyboard.type('auto mode text');
await clk(panel, '#sendBtn'); await sleep(2000);
const n5 = await panel.evaluate(() => ({ calls: window.__createCalls, out: [...document.querySelectorAll('.turn')].at(-1)?.querySelector('.assistant-body')?.innerText || '' }));
check('Auto + key + model not downloaded: uses the key, no download', n5.calls === 0 && /^R\(auto mode text\)/.test(n5.out), JSON.stringify(n5));

// 7. Hover toggle: grants (pre-granted in test copy), registers scripts, applies on reload.
await panel.bringToFront();
await panel.evaluate(() => document.getElementById('btnSettings').click()); await sleep(400);
await clk(panel, '#hoverToggle'); await sleep(1200);
const regs = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
check('hover on registers page scripts', regs.some(r => r.id === 'proofr-hover'), JSON.stringify(regs.map(r => r.id)));
await demo.bringToFront(); await demo.reload(); await sleep(900);
box = await (await demo.$('.wrap p')).boundingBox();
await demo.mouse.move(box.x + 10, box.y + 30); await sleep(200);
await demo.mouse.move(box.x + 40, box.y + 10); await sleep(800);
const icon = await demo.$('.sr-hover-icon');
check('hover icon appears after enabling + reload', !!icon);
if (icon) {
  await icon.evaluate((el) => el.click()); await sleep(600);
  const hasAsk = !!(await demo.$('#srHoverAskForm'));
  check('Ask box shown when a key exists', hasAsk);
  await demo.keyboard.press('Escape');
  await demo.evaluate(() => document.body.click());
}
await panel.bringToFront(); await clk(panel, '#hoverToggle'); await sleep(1200);
const regs2 = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
check('hover off unregisters page scripts', !regs2.some(r => r.id === 'proofr-hover'));

console.log('STEP 8');
// 8. No-key, no-AI: hover Ask box hidden. Remove key, re-enable hover.
// A local endpoint with no key is legitimately ready (Ollama-style), so the
// "nothing set up" case is a hosted provider with no key saved.
await panel.evaluate(async () => { await chrome.storage.local.remove(['srCloudKey_custom', 'srCloudKey_groq']); await chrome.storage.sync.set({ srCloudService: 'groq' }); });
await clk(panel, '#hoverToggle'); await sleep(1200);
await demo.bringToFront(); await demo.reload(); await sleep(900);
box = await (await demo.$('.wrap p')).boundingBox();
await demo.mouse.move(box.x + 10, box.y + 30); await sleep(200);
await demo.mouse.move(box.x + 40, box.y + 10); await sleep(800);
const icon2 = await demo.$('.sr-hover-icon');
if (icon2) {
  await icon2.evaluate((el) => el.click()); await sleep(600);
  check('Ask box hidden without a key', !(await demo.$('#srHoverAskForm')));
  await clk(demo, '.sr-hover-action[data-tone="tldr"]'); await sleep(1500);
  const errText = await demo.evaluate(() => document.querySelector('#smart-rewrite-modal')?.innerText || '');
  check('no-AI hover action explains setup', /Set up Proofr/.test(errText) && /connect an AI provider/.test(errText), errText.replace(/\s+/g, ' ').slice(0, 120));
  await shot(demo, '3-setup-error.png');
} else check('hover icon present for no-key test', false);

// (A runtime font-request check was removed: content-script CSS requests aren't visible to
// page.on('request'), so it passed on the old code too. The static modal.css check covers it.)
check('no page/console/SW errors', errors.length === 0, errors.join(' | '));

await browser.close();
mock.close();
demoServer.close();
fs.rmSync(ext, { recursive: true, force: true });
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  :: ' + r.detail : ''}`);
console.log(`${results.filter(r => r.ok).length}/${results.length} passed`);
process.exit(results.every(r => r.ok) ? 0 : 1);
