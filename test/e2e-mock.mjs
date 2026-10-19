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

// The extension's own helpers, for computing expected text (constants.js assigns to `self`).
const C = {};
new Function('self', fs.readFileSync(path.join(src, 'constants.js'), 'utf8'))(C);

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
<div id="ce" contenteditable="true">teh lazy dog</div>
<input id="other">`;
// Text containing SLOW answers after 3s; FAILONCE fails with 500 the first time it's seen.
let failedOnce = false;
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
      const parsed = JSON.parse(body);
      requests.push(parsed);
      const text = JSON.stringify(parsed.messages || '');
      if (text.includes('FAILONCE') && !failedOnce) {
        failedOnce = true;
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'mock overloaded' } }));
      }
      setTimeout(() => {
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: OUT } }] }));
      }, text.includes('SLOW') ? 3000 : 0);
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

  // 3c. The dialog's own pieces, driven in the content script's world (as background does).
  const inModal = (fn, ...args) => sw.evaluate(async (id, src, a) => {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: id }, func: new Function(`return (${src})(...arguments)`), args: a });
    return r.result;
  }, tabId, fn.toString(), args);
  await step('streaming', async () => {
    const shown = await inModal(() => {
      window.SmartRewriteModal.showLoading('Good morning team.', 'professional');
      const skeleton = !!document.querySelector('#sr-modal-content .sr-skeleton');
      window.SmartRewriteModal.streamText('Good mor');
      window.SmartRewriteModal.streamText('Good morning, team');
      return { skeleton, text: (document.getElementById('sr-rewritten-text') || {}).textContent, gone: !document.querySelector('#sr-modal-content .sr-skeleton') };
    });
    check(shown.skeleton, 'loading dialog: shows the skeleton');
    check(shown.gone && shown.text === 'Good morning, team', `streamText: replaces the skeleton with the text so far (got ${JSON.stringify(shown.text)})`);
    await page.keyboard.press('Escape');
  });
  await step('per-change revert', async () => {
    const r = await inModal(() => {
      const M = window.SmartRewriteModal;
      M.showResult('teh report are ready.', 'The report is ready.', 'grammar', 'custom');
      const box = document.getElementById('sr-rewritten-text');
      const n = box.querySelectorAll('.sr-change').length;
      box.querySelector('.sr-change[data-g="1"]').click();
      const rejected = box.querySelectorAll('.sr-change-rejected').length;
      document.getElementById('sr-diff-toggle').click();
      return { n, rejected, plain: box.textContent };
    });
    check(r.n === 2, `per-change revert: one toggle per change (got ${r.n})`);
    check(r.rejected === 1 && r.plain === 'The report are ready.', `per-change revert: a clicked change keeps the original words (got ${JSON.stringify(r.plain)})`);
    await page.keyboard.press('Escape');
  });
  await step('toast undo', async () => {
    const r = await inModal(async () => {
      const M = window.SmartRewriteModal;
      M.showSuccess('Fixed 1 thing.', { review: { original: 'teh', rewritten: 'the', tone: 'grammar' }, undo: () => true });
      const t = document.querySelector('.sr-success-notification');
      const buttons = [...t.querySelectorAll('button')].map((b) => b.textContent);
      t.querySelector('.sr-success-undo').click();
      await new Promise((res) => setTimeout(res, 50));
      const after = t.querySelector('.sr-success-text').textContent;
      M.showSuccess('Nothing to fix.', { review: { original: 'Fine.', rewritten: 'Fine.', tone: 'grammar' }, undo: () => true });
      const none = document.querySelectorAll('.sr-success-notification button').length;
      return { buttons, after, none };
    });
    check(r.buttons.join() === 'Review,Undo', `toast: Review and Undo buttons (got ${r.buttons})`);
    check(r.after === 'Undone.', `toast: Undo calls the undo function and says so (got ${JSON.stringify(r.after)})`);
    check(r.none === 0, 'toast: nothing changed → no Review, no Undo');
  });


  // 3d. Dialog semantics and focus (SATISFACTION §3 #4, K5).
  await step('dialog focus', async () => {
    // A dialog that opens while the user types in another box leaves focus there.
    await page.evaluate(() => { const o = document.getElementById('other'); o.value = ''; o.focus(); });
    const stay = await inModal(() => {
      window.SmartRewriteModal.toastAnchor = document.getElementById('ta');
      window.SmartRewriteModal.showResult('teh report', 'the report', 'grammar', 'custom');
      return document.activeElement.id;
    });
    check(stay === 'other', `dialog: doesn't take focus from a box the user is typing in (got ${stay})`);
    await page.keyboard.press('Escape');
    // The usual case: focus in the field the rewrite came from.
    await page.evaluate(() => document.getElementById('ta').focus());
    const r = await inModal(() => {
      const M = window.SmartRewriteModal;
      M.showResult('teh report', 'the report', 'grammar', 'custom');
      const c = document.querySelector('.sr-modal-container');
      const label = document.getElementById(c.getAttribute('aria-labelledby'));
      return {
        role: c.getAttribute('role'), modal: c.getAttribute('aria-modal'), label: label && label.textContent,
        close: document.getElementById('sr-close-btn').getAttribute('aria-label'),
        focus: c.contains(document.activeElement) ? document.activeElement.id : `outside:${document.activeElement.tagName}`,
      };
    });
    check(r.role === 'dialog' && r.modal === 'true' && r.label === 'Proofr', `dialog: role=dialog, aria-modal, labelled "Proofr" (got ${JSON.stringify(r)})`);
    check(r.close === 'Close', 'dialog: ✕ is named "Close"');
    check(r.focus === 'sr-copy-btn', `dialog: focus starts on the primary button (got ${r.focus})`);
    let inside = true;
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      inside = inside && await page.evaluate(() => document.querySelector('.sr-modal-container').contains(document.activeElement));
    }
    await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
    inside = inside && await page.evaluate(() => document.querySelector('.sr-modal-container').contains(document.activeElement));
    check(inside, 'dialog: Tab and Shift+Tab stay inside');
    // Ctrl/Cmd+C: copies the rewrite only when nothing is selected.
    const k5 = await inModal(() => {
      const ev = () => { const e = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }); document.dispatchEvent(e); return e.defaultPrevented; };
      getSelection().removeAllRanges();
      const empty = ev();
      document.querySelector('.sr-original').open = true;
      const r = document.createRange(); r.selectNodeContents(document.querySelector('.sr-original-text'));
      getSelection().removeAllRanges(); getSelection().addRange(r);
      const selected = ev();
      getSelection().removeAllRanges();
      return { empty, selected, hint: document.querySelector('#sr-modal-footer .sr-hint').textContent };
    });
    check(k5.empty && !k5.selected, `dialog: Ctrl/Cmd+C intercepted only with no selection (got ${JSON.stringify(k5)})`);
    check(/^Click a tone/.test(k5.hint), `dialog: hint says "Click a tone" (got ${JSON.stringify(k5.hint)})`);
    await page.keyboard.press('Escape');
    const back = await inModal(() => ({ visible: window.SmartRewriteModal.isVisible, focus: document.activeElement.id }));
    check(!back.visible && back.focus === 'ta', `dialog: Esc closes at once and gives focus back (got ${JSON.stringify(back)})`);
  });

  // 3d2. Coach mode: the original with spots marked, no fix shown; reveal or fix it yourself.
  await step('coach', async () => {
    await page.evaluate(() => document.getElementById('ta').focus());
    const before = 'hi team we was late'; // "," is a pure insertion: a gap spot
    const after = 'Hi team, we were late';
    const r = await inModal((a, b) => {
      const M = window.SmartRewriteModal;
      window.__revealed = 0;
      M.showCoach(a, b, { where: 'On this computer', onReveal: () => { window.__revealed++; M.showResult(a, b, 'grammar', 'device'); } });
      const box = document.getElementById('sr-coach-text');
      const e = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, metaKey: true, bubbles: true, cancelable: true });
      getSelection().removeAllRanges();
      document.dispatchEvent(e);
      return {
        role: document.querySelector('.sr-modal-container').getAttribute('role'),
        spots: box.querySelectorAll('.sr-spot').length, gaps: box.querySelectorAll('.sr-spot-gap').length,
        text: box.textContent, count: document.getElementById('sr-coach-count').textContent,
        focus: document.activeElement.id, buttons: [...document.querySelectorAll('#sr-modal-footer button')].map((x) => x.textContent),
        copied: e.defaultPrevented,
      };
    }, before, after);
    const n = C.SR_diffCount(C.SR_wordDiff(before, after));
    check(r.role === 'dialog' && r.spots === n && r.gaps === 1, `coach: ${n} spots marked, one a gap (got ${r.spots}, gaps ${r.gaps})`);
    check(r.text === before, `coach: shows the original, no fix (got ${JSON.stringify(r.text)})`);
    check(r.count === `${n} spots to check. Fix them in your text box, or show the fixes.`, `coach: says how many (got ${JSON.stringify(r.count)})`);
    check(r.focus === 'sr-coach-self' && r.buttons.join() === "I'll fix them,Show fixes", `coach: buttons, focus on "I'll fix them" (got ${r.focus}, ${r.buttons})`);
    check(!r.copied, 'coach: Ctrl/Cmd+C does not copy the hidden fix');
    const shown = await inModal(() => {
      document.getElementById('sr-coach-reveal').click();
      return { revealed: window.__revealed, diff: !!document.querySelector('#sr-rewritten-text ins.sr-diff-ins'), visible: window.SmartRewriteModal.isVisible };
    });
    check(shown.revealed === 1 && shown.diff && shown.visible, `coach: Show fixes opens the diff (got ${JSON.stringify(shown)})`);
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.getElementById('ta').focus());
    const self = await inModal((a, b) => {
      window.SmartRewriteModal.showCoach(a, b, {});
      document.getElementById('sr-coach-self').click();
      return { visible: window.SmartRewriteModal.isVisible, focus: document.activeElement.id };
    }, before, after);
    check(!self.visible && self.focus === 'ta', `coach: "I'll fix them" closes and returns to the text box (got ${JSON.stringify(self)})`);
  });

  // 3e. One toast per action, near the field, held while hovered (§3 #5, #6, #7, #3).
  await step('one toast', async () => {
    await page.evaluate(() => { const el = document.getElementById('ta'); el.value = 'teh quick brown fox'; el.focus(); });
    const r = await inModal(async () => {
      const M = window.SmartRewriteModal;
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      M.removeToast(); // start from no toast, as a fresh action does
      await wait(200);
      const made = [];
      const obs = new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => n.classList && /sr-(loading-toast|success)/.test(n.className) && made.push(n))));
      obs.observe(document.body, { childList: true });
      M.showLoading('teh quick brown fox', 'grammar', null, { requestId: 'x1' });
      const t = document.getElementById('sr-toast');
      const early = { role: t.getAttribute('role'), text: t.querySelector('.sr-toast-text').textContent, spin: !!t.querySelector('.sr-toast-spin'), stop: !!t.querySelector('.sr-toast-stop') };
      await wait(1200);
      const spinLater = !!t.querySelector('.sr-toast-spin');
      await wait(1300);
      const secs = t.querySelector('.sr-toast-meta').textContent;
      M.streamText('the quick');
      const pct = t.querySelector('.sr-toast-meta').textContent;
      const tr = t.getBoundingClientRect(), fr = document.getElementById('ta').getBoundingClientRect();
      const dist = Math.max(0, tr.top - fr.bottom, fr.top - tr.bottom);
      M.showSuccess('Fixed 1 thing.', { review: { original: 'teh', rewritten: 'the', tone: 'grammar' }, undo: () => true });
      const same = document.getElementById('sr-toast') === t && /sr-success-notification/.test(t.className);
      const holdMs = M.toastMs;
      t.dispatchEvent(new MouseEvent('mouseenter'));
      M.dismissToast(100);
      await wait(400);
      const held = t.isConnected;
      t.dispatchEvent(new MouseEvent('mouseleave'));
      await wait(500);
      const goneAfterLeave = !t.isConnected;
      await wait(50);
      obs.disconnect();
      return { early, spinLater, secs, pct, dist, same, holdMs, held, goneAfterLeave, made: made.length };
    });
    check(r.early.role === 'status' && r.early.text === 'Proofreading…' && r.early.stop, `toast: loading says "Proofreading…", role=status, has Stop (got ${JSON.stringify(r.early)})`);
    check(!r.early.spin && r.spinLater, 'toast: spinner only after 1s');
    check(/^\d+s$/.test(r.secs), `toast: elapsed seconds after 2s (got ${JSON.stringify(r.secs)})`);
    check(r.pct === '47%', `toast: Proofread streaming shows percent (got ${JSON.stringify(r.pct)})`);
    check(r.dist < 100, `toast: within 100px of the field (got ${r.dist}px)`);
    check(r.same && r.made === 1, `toast: one element from loading to done (same: ${r.same}, created: ${r.made})`);
    check(r.holdMs === 8000, `toast: Review/Undo stays 8s (got ${r.holdMs})`);
    check(r.held && r.goneAfterLeave, `toast: held while hovered, goes after leave (held ${r.held}, gone ${r.goneAfterLeave})`);
  });

  // 3f. Errors: light ones in the toast, retry/alternative as buttons (§3 #8).
  await step('error actions', async () => {
    const r = await inModal(async () => {
      const M = window.SmartRewriteModal;
      const ran = [];
      M.showError('Select some text first.', { light: true });
      const light = { toast: !!document.querySelector('#sr-toast.sr-success-notification'), overlay: M.isVisible };
      M.showError('The model timed out.', { title: 'Timed out', retry: { label: 'Try again', run: () => ran.push('retry') }, alternative: { label: 'Use Groq instead', run: () => ran.push('alt') } });
      const focus = document.activeElement.id;
      const buttons = [...document.querySelectorAll('#sr-modal-footer button')].map((b) => b.textContent);
      document.getElementById('sr-error-retry').click();
      return { light, focus, buttons, ran, closed: !M.isVisible, toastGone: !document.getElementById('sr-toast') };
    });
    check(r.light.toast && !r.light.overlay, `light error: a toast, not the overlay (got ${JSON.stringify(r.light)})`);
    check(r.buttons.join() === 'Try again,Use Groq instead,Close', `error: Try again, alternative, Close (got ${r.buttons})`);
    check(r.focus === 'sr-error-retry', `error: focus on Try again (got ${r.focus})`);
    check(r.ran.join() === 'retry' && r.closed && r.toastGone, `error: Try again closes the error and runs the retry (got ${JSON.stringify(r)})`);
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

    // Revert one change first: Replace anyway must insert only what was kept.
    await selectField(risky);
    await sw.evaluate((id, t) => handleRewrite(id, t, 'grammar', { ensure: true }), tabId, risky);
    await waitFor(() => page.evaluate(() => !!document.querySelector('#sr-rewritten-text .sr-change[data-g="0"]')), 5000);
    await page.evaluate(() => document.querySelector('#sr-rewritten-text .sr-change[data-g="0"]').click());
    await page.evaluate(() => document.getElementById('sr-action-btn').click());
    const expected = C.SR_applyDiff(C.SR_wordDiff(risky, OUT), new Set([0]));
    const partial = await waitFor(() => page.evaluate((want) => document.querySelector('#ta').value === want, expected), 3000);
    check(partial && expected !== OUT, `change guard: after undoing one change, Replace anyway inserts only the kept changes (want ${JSON.stringify(expected)}, got ${JSON.stringify(await page.evaluate(() => document.querySelector('#ta').value))})`);
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


  // 4e. Stop in place: Esc during a slow rewrite leaves the field alone (§3 #3).
  await step('esc stops', async () => {
    const slow = 'SLOW teh quick brown fox';
    await selectField(slow);
    const running = sw.evaluate((id, t) => handleRewrite(id, t, 'grammar', { ensure: true }), tabId, slow); // resolves when the result lands
    await waitFor(() => page.evaluate(() => !!document.querySelector('#sr-toast.sr-loading-toast')), 3000);
    await sleep(1000);
    await page.keyboard.press('Escape');
    const said = await page.evaluate(() => (document.querySelector('#sr-toast .sr-success-text') || {}).textContent);
    check(said === 'Stopped.', `Esc during a slow in-place rewrite: toast says Stopped (got ${JSON.stringify(said)})`);
    await running;
    await sleep(3000);
    const v = await page.evaluate(() => document.querySelector('#ta').value);
    check(v === slow, `Esc during a slow in-place rewrite: field unchanged after the result would have landed (got ${JSON.stringify(v)})`);
  });

  // 4f. No focus steal: move to another box mid-rewrite; the result waits for Apply (§3 #1).
  await step('no focus steal', async () => {
    const slow = 'SLOW Proofr mock result.'; // a small edit, so the change guard stays out of it
    await selectField(slow);
    const running = sw.evaluate((id, t) => handleRewrite(id, t, 'grammar', { ensure: true }), tabId, slow); // resolves when the result lands
    // Move only once the target is captured (the loading toast shows after that).
    await waitFor(() => page.evaluate(() => !!document.querySelector('#sr-toast.sr-loading-toast')), 3000);
    await page.evaluate(() => { const o = document.getElementById('other'); o.value = ''; o.focus(); });
    await page.keyboard.type('abc');
    await waitFor(() => page.evaluate(() => !!document.querySelector('#sr-toast .sr-success-apply')), 6000);
    await running;
    await page.keyboard.type('XYZ');
    const r = await page.evaluate(() => ({ active: document.activeElement.id, other: document.getElementById('other').value, ta: document.getElementById('ta').value }));
    check(r.active === 'other' && r.other === 'abcXYZ' && r.ta === slow, `result for a box you left: focus and keystrokes stay put (got ${JSON.stringify(r)})`);
    await page.evaluate(() => document.querySelector('#sr-toast .sr-success-apply').click());
    const applied = await waitFor(() => page.evaluate((out) => document.querySelector('#ta').value === out, OUT), 3000);
    check(applied, 'result for a box you left: Apply inserts it');
  });

  // 4f2. A guarded result for a box the user left: Review only, and the dialog keeps the guard's notice.
  await step('guarded, moved on', async () => {
    const risky = 'SLOW I will not be there on Monday.';
    await selectField(risky);
    const running = sw.evaluate((id, t) => handleRewrite(id, t, 'grammar', { ensure: true }), tabId, risky); // resolves when the result lands
    await waitFor(() => page.evaluate(() => !!document.querySelector('#sr-toast.sr-loading-toast')), 3000);
    await page.evaluate(() => { const o = document.getElementById('other'); o.value = ''; o.focus(); });
    await running;
    const t = await page.evaluate(() => ({
      review: !!document.querySelector('#sr-toast .sr-success-review:not(.sr-success-apply)'),
      apply: !!document.querySelector('#sr-toast .sr-success-apply'),
      dialog: window.getComputedStyle(document.getElementById('smart-rewrite-modal')).display !== 'none' && !!document.querySelector('#smart-rewrite-modal.sr-visible'),
    }));
    check(t.review && !t.apply && !t.dialog, `guarded result for a box you left: toast with Review, no Apply, no dialog (got ${JSON.stringify(t)})`);
    await page.evaluate(() => document.querySelector('#sr-toast .sr-success-review').click());
    const d = await page.evaluate(() => ({
      notice: (document.querySelector('#sr-modal-content .sr-notice') || {}).textContent || '',
      action: (document.getElementById('sr-action-btn') || {}).textContent || '',
      ta: document.querySelector('#ta').value,
    }));
    check(/not/.test(d.notice) && d.action === 'Replace anyway' && d.ta === risky, `guarded result for a box you left: Review shows the reason and Replace anyway, field untouched (got ${JSON.stringify(d)})`);
    await page.keyboard.press('Escape');
  });

  // 4g. Try again after a provider error replaces the text (§3 #8).
  await step('retry', async () => {
    const t = 'FAILONCE Proofr mock result.'; // a small edit, so the change guard stays out of it
    await selectField(t);
    await sw.evaluate((id, s) => handleRewrite(id, s, 'grammar', { ensure: true }), tabId, t);
    const retry = await waitFor(() => page.evaluate(() => !!document.getElementById('sr-error-retry')), 5000);
    check(retry, 'provider error: offers Try again');
    if (retry) await page.evaluate(() => document.getElementById('sr-error-retry').click());
    const fixed = await waitFor(() => page.evaluate((out) => document.querySelector('#ta').value === out, OUT), 5000);
    const state = fixed ? '' : await page.evaluate(() => JSON.stringify({ ta: document.querySelector('#ta').value, active: document.activeElement.id, dialog: (document.getElementById('sr-modal-content') || {}).textContent?.trim().slice(0, 80), toast: document.getElementById('sr-toast')?.textContent.trim() }));
    check(fixed, `provider error: Try again replaces the text ${state}`);
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
