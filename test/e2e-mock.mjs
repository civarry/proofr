// End-to-end success paths against a local OpenAI-compatible mock (no real key,
// no network). Loads a copy of the extension in Chrome for Testing and checks:
//   1. first-run key save in the side panel actually stores the key
//   2. a side-panel turn succeeds through the cloud provider
//   3. the right-click flow (handleRewrite) translates into the requested
//      non-on-device language (the prompt the mock receives says Korean)
//   4. in-place replace into a textarea and a contenteditable, and Ctrl/Cmd+Z restores it
//   5. no errors in the service worker
//
// Run (needs puppeteer; point PUPPETEER at an install if it isn't resolvable here):
//     PUPPETEER=/path/to/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js \
//       node test/e2e-mock.mjs [extDir]
// On a sleeping or loaded Mac, run `caffeinate -u -t 600 &` first or Chrome stalls.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { default: puppeteer } = await import(process.env.PUPPETEER || 'puppeteer');
const src = path.resolve(process.argv[2] || new URL('..', import.meta.url).pathname);
const PORT = 8798;
const BASE = `http://localhost:${PORT}`;
const OUT = 'Proofr mock result.';
const KEY = 'sk-mock-1234567890';

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A step that throws counts as a failure instead of aborting the run, so an
// old or broken build still reports every check.
async function step(name, fn) {
  try { await fn(); } catch (e) { check(false, `${name}: threw ${String(e.message || e).split('\n')[0]}`); }
}
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await sleep(200); }
  return false;
}

// === Mock provider + test page ===
const requests = [];
const PAGE = `<!doctype html><meta charset="utf-8"><title>e2e</title>
<p id="para">Good morning team, the report is ready.</p>
<textarea id="ta">teh quick brown fox</textarea>
<div id="ce" contenteditable="true">teh lazy dog</div>`;
const server = http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization,content-type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.url === '/page') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PAGE); }
  if (req.url === '/v1/models') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
  }
  if (req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: OUT } }] }));
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT);

// === Extension copy with host access granted up front ===
// chrome.permissions.request() can't be clicked by puppeteer, and executeScript
// needs the activeTab grant a real right-click would give. Granting host access
// in the copy stands in for both; the code paths under test are unchanged.
const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'proofr-e2e-'));
const skip = new Set(['.git', 'market-research', 'store', 'store-screenshots', 'screenshots', 'test', 'docs']);
for (const name of fs.readdirSync(src)) {
  if (skip.has(name) || name.endsWith('.zip')) continue;
  fs.cpSync(path.join(src, name), path.join(ext, name), { recursive: true });
}
const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));

const browser = await puppeteer.launch({ headless: false, pipe: true, enableExtensions: [ext], args: ['--window-size=1200,800'], protocolTimeout: 30000 });
try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
  const extId = new URL(swTarget.url()).host;
  const sw = await swTarget.worker();

  const swErrors = [];
  const cdp = await swTarget.createCDPSession();
  await cdp.send('Runtime.enable');
  cdp.on('Runtime.exceptionThrown', (e) => swErrors.push(e.exceptionDetails.exception?.description || e.exceptionDetails.text));
  cdp.on('Runtime.consoleAPICalled', (e) => { if (e.type === 'error') swErrors.push(e.args.map((a) => a.value ?? a.description).join(' ')); });

  // Custom provider pointed at the mock, engine forced to cloud (CfT has no Nano anyway).
  await sw.evaluate(async (base) => {
    await chrome.storage.sync.set({ srCloudService: 'custom', srCloudCustomBaseURL: base, srCloudModel_custom: 'mock-model', srEngine: 'cloud' });
  }, `${BASE}/v1`);

  // 1. First-run key save: type into the empty field, click Save.
  const panel = await browser.newPage();
  await step('key save', async () => {
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    // DOM-level input and clicks: puppeteer's mouse/visibility helpers need painted
    // frames, which a sleeping display (or a busy machine) stops producing.
    // A local endpoint with a model is ready without a key, so the panel opens the
    // composer; open Settings (a toggle, and bound after async init, so retry while hidden).
    const ready = await waitFor(() => panel.evaluate(() => {
      if (document.getElementById('settingsPanel').classList.contains('hidden')) document.getElementById('btnSettings').click();
      const e = document.getElementById('apiKeyInput');
      return !!e && e.offsetParent !== null && !e.readOnly;
    }), 8000);
    check(ready, 'side panel: Settings shows an editable (optional) key field for a local endpoint');
    // Opening Settings re-renders the key field asynchronously (clearing it); let that land first.
    await sleep(1000);
    await panel.evaluate((k) => {
      const input = document.getElementById('apiKeyInput');
      input.value = k;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('btnSaveKey').click();
    }, KEY);
    const saved = await waitFor(() => sw.evaluate(async (k) => {
      const [l, s] = await Promise.all([chrome.storage.local.get('srCloudKey_custom'), chrome.storage.sync.get('srCloudKey_custom')]);
      return l.srCloudKey_custom === k || s.srCloudKey_custom === k;
    }, KEY), 8000);
    const hint = saved ? '' : ` (hint: ${JSON.stringify(await panel.evaluate(() => document.getElementById('keyHint').textContent.trim()))})`;
    check(saved, `side panel: pasting a key into the empty field and clicking Save stores it${hint}`);
  });

  // Seed the key directly too, so later checks don't depend on check 1.
  await sw.evaluate(async (k) => {
    await chrome.storage.local.set({ srCloudKey_custom: k });
    await chrome.storage.sync.set({ srCloudKey_custom: k });
  }, KEY);

  // 2. Side-panel turn.
  await step('panel turn', async () => {
    await panel.reload();
    // The panel binds its listeners after async setup; the send button only
    // enables once the input listener exists, so poll until it does.
    const armed = await waitFor(() => panel.evaluate(() => {
      const ta = document.getElementById('ta');
      const send = document.getElementById('sendBtn');
      if (!ta || !send) return false;
      ta.value = 'this is a panel test sentence';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return !send.disabled;
    }), 8000);
    check(armed, 'side panel: typing enables the send button');
    await panel.evaluate(() => {
      const back = document.getElementById('btnSettingsBack');
      if (back && !document.getElementById('settingsPanel').classList.contains('hidden')) back.click();
      document.getElementById('sendBtn').click();
    });
    // A Proofread turn renders a word diff; dropping the <del> parts must leave exactly the result.
    const turnOk = await waitFor(() => panel.evaluate((out) => [...document.querySelectorAll('.msg-assistant')].some((n) => {
      const c = n.cloneNode(true);
      c.querySelectorAll('del').forEach((d) => d.remove());
      return c.textContent.includes(out);
    }), OUT));
    const why = turnOk ? '' : ` (thread: ${JSON.stringify(await panel.evaluate(() => document.getElementById('thread').textContent.trim().slice(0, 160)))})`;
    check(turnOk, `side panel: a turn returns the provider result${why}`);
  });

  // 3. Right-click flow, translate to Korean (a cloud-only language).
  const page = await browser.newPage();
  await page.goto(`${BASE}/page`);
  await page.bringToFront();
  const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, `${BASE}/page`);
  await step('right-click translate', async () => {
    const before = requests.length;
    await sw.evaluate((id) => handleRewrite(id, 'Good morning team, the report is ready.', 'translate', { ensure: true, targetLang: 'ko' }), tabId);
    const prompt = requests.slice(before).map((r) => r.messages?.[0]?.content || '').join('\n');
    check(/into Korean\b/.test(prompt), `right-click translate to ko: prompt says Korean (got: ${(prompt.match(/into [A-Za-z ()]+?\./) || ['none'])[0]})`);
    const modalOk = await waitFor(() => page.evaluate((out) => (document.getElementById('sr-rewritten-text') || {}).textContent === out, OUT), 5000);
    check(modalOk, 'right-click on page text: result opens in the modal');
    await page.keyboard.press('Escape');
  });

  // 3b. Proofread on page text shows the word diff, and the toggle gives back the plain result.
  await step('proofread diff', async () => {
    await page.evaluate(() => getSelection().removeAllRanges());
    await sw.evaluate((id) => handleRewrite(id, 'Good morning team, the report is ready.', 'grammar', { ensure: true }), tabId);
    const shown = await waitFor(() => page.evaluate(() => !!document.querySelector('#sr-rewritten-text ins.sr-diff-ins') && !!document.querySelector('#sr-rewritten-text del.sr-diff-del')), 5000);
    check(shown, 'proofread result: changes shown as ins/del');
    const plain = await page.evaluate(() => {
      document.getElementById('sr-diff-toggle').click();
      return document.getElementById('sr-rewritten-text').textContent;
    });
    check(plain === OUT, `proofread result: "Show plain text" shows exactly the result (got ${JSON.stringify(plain)})`);
    await page.keyboard.press('Escape');
  });

  // 4. In-place replace + undo.
  const undo = process.platform === 'darwin' ? 'Meta' : 'Control';
  for (const [sel, label] of [['#ta', 'textarea'], ['#ce', 'contenteditable']]) {
    await step(label, async () => {
      const original = await page.evaluate((s) => {
        const el = document.querySelector(s);
        el.focus();
        if (el.tagName === 'TEXTAREA') { el.setSelectionRange(0, el.value.length); return el.value; }
        const r = document.createRange(); r.selectNodeContents(el);
        const w = getSelection(); w.removeAllRanges(); w.addRange(r);
        return el.textContent;
      }, sel);
      await sw.evaluate((id, text) => handleRewrite(id, text, 'grammar', { ensure: true }), tabId, original);
      const read = () => page.evaluate((s) => { const el = document.querySelector(s); return el.tagName === 'TEXTAREA' ? el.value : el.textContent; }, sel);
      const replaced = await waitFor(async () => (await read()) === OUT, 5000);
      check(replaced, `${label}: selection replaced in place`);
      await page.focus(sel);
      // On macOS, synthetic Cmd+Z only reaches the editor's undo when the command is named explicitly.
      await page.keyboard.down(undo); await page.keyboard.press('KeyZ', { commands: ['undo'] }); await page.keyboard.up(undo);
      const restored = await waitFor(async () => (await read()) === original, 3000);
      check(restored, `${label}: ${undo}+Z restores the original (now: ${JSON.stringify(await read())})`);
    });
  }

  // 4b. The in-place toast has a Review link that opens the diff, labelled with where the text went.
  const selectField = (text) => page.evaluate((t) => {
    const el = document.querySelector('#ta');
    el.value = t; el.focus(); el.setSelectionRange(0, t.length);
  }, text);
  await step('toast review', async () => {
    await page.evaluate(() => document.querySelectorAll('.sr-success-notification').forEach((n) => n.remove()));
    await selectField('teh quick brown fox');
    await sw.evaluate((id) => handleRewrite(id, 'teh quick brown fox', 'grammar', { ensure: true }), tabId);
    const hasReview = await waitFor(() => page.evaluate(() => !!document.querySelector('.sr-success-notification .sr-success-review')), 5000);
    check(hasReview, 'in-place toast: has a Review link');
    await page.evaluate(() => document.querySelector('.sr-success-notification .sr-success-review').click());
    const reviewed = await waitFor(() => page.evaluate(() => !!document.querySelector('#sr-rewritten-text ins.sr-diff-ins')), 3000);
    check(reviewed, 'in-place toast: Review opens the result with the diff');
    const where = await page.evaluate(() => (document.querySelector('#sr-modal-footer .sr-engine') || {}).textContent);
    // The mock is on localhost, so nothing left this computer.
    check(where === 'On your computer or network', `result dialog: says where the text went (got ${JSON.stringify(where)})`);
    await page.keyboard.press('Escape');
  });

  // 4c. The change guard: a "proofread" that drops "not" must not replace the text.
  await step('change guard', async () => {
    const risky = 'I will not be there on Monday.';
    await selectField(risky);
    await sw.evaluate((id, t) => handleRewrite(id, t, 'grammar', { ensure: true }), tabId, risky);
    const notice = await waitFor(() => page.evaluate(() => !!document.querySelector('#sr-modal-content .sr-notice')), 5000);
    check(notice, 'change guard: opens the dialog with a notice');
    check(await page.evaluate(() => document.querySelector('#ta').value) === risky, 'change guard: the field is left unchanged');
    const reason = await page.evaluate(() => document.querySelector('#sr-modal-content .sr-notice').textContent);
    check(/not/.test(reason), `change guard: the notice names the reason (got ${JSON.stringify(reason)})`);
    await page.evaluate(() => document.getElementById('sr-action-btn').click());
    const forced = await waitFor(() => page.evaluate((out) => document.querySelector('#ta').value === out
      && document.querySelector('.sr-modal-overlay').getClientRects().length === 0, OUT), 3000);
    check(forced, 'change guard: "Replace anyway" replaces the text and closes the dialog');
  });

  // 4d. A real mouse click reaches the toast's Review button (z-index, pointer-events).
  // Needs painted frames: with the display asleep or the screen locked it can hang, so it skips.
  await step('toast review (mouse)', async () => {
    await page.evaluate(() => document.querySelectorAll('.sr-success-notification').forEach((n) => n.remove()));
    await selectField('teh quick brown fox');
    await sw.evaluate((id) => handleRewrite(id, 'teh quick brown fox', 'grammar', { ensure: true }), tabId);
    await waitFor(() => page.evaluate(() => !!document.querySelector('.sr-success-notification.sr-show .sr-success-review')), 5000);
    await sleep(400); // let the slide-in finish so the box is where it will be clicked
    const clicked = await Promise.race([
      (async () => {
        const btn = await page.$('.sr-success-notification .sr-success-review');
        const box = await btn.boundingBox();
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return waitFor(() => page.evaluate(() => !!document.querySelector('#sr-rewritten-text ins.sr-diff-ins')), 3000);
      })(),
      sleep(8000).then(() => 'timeout'),
    ]);
    if (clicked === 'timeout') console.log('SKIP in-place toast: real mouse click (no painted frames: display asleep or screen locked)');
    else check(clicked, 'in-place toast: a real mouse click on Review opens the diff');
    await page.keyboard.press('Escape');
  });

  // 5. Service worker stayed clean.
  await sleep(500);
  check(swErrors.length === 0, `service worker: no errors${swErrors.length ? ` (${swErrors.join(' | ')})` : ''}`);
} finally {
  await browser.close();
  server.close();
  fs.rmSync(ext, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
