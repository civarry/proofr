// The promise behind "Replace": whatever text box the selection is in, the
// result goes back into it, with no copy and paste. One box of each kind real
// sites use, driven the way the right-click menu and the shortcut drive them.
//
// A box counts as passing only if its text really changed to the expected
// result (line breaks included) and Proofr did not fall back to a Copy dialog.
//
// usage: PUPPETEER=<path to puppeteer's esm entry> node test/e2e-replace.mjs [extDir]
const { default: puppeteer } = await import(process.env.PUPPETEER || 'puppeteer');
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const src = path.resolve(process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), '..'));
const PORT = 8771;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); };

// One word per box lets the mock answer for the right box. It fixes "teh" only,
// so the change guard stays out of it.
const one = (w) => `teh ${w} report is ready for review`;
const two = (w) => `teh ${w} report is ready\nteh second line is here too`;
const three = (w) => `teh ${w} report is ready\nteh second line is here\nteh third line is here too`;
const fix = (s) => s.replace(/teh/g, 'the');

// Each box: its markup, how to reach the editable element, its text.
const BOXES = {
  textarea: { text: one('alpha') },
  input: { text: one('bravo') },
  ce: { text: one('charlie') },
  ceParas: { text: three('delta') },
  ceDivs: { text: two('echo') },
  ceBreaks: { text: two('foxtrot') },
  shadowTextarea: { text: one('golf') },
  shadowCe: { text: two('hotel') },
  frameCe: { text: two('indigo') }, // not a country: Proofr's rules would capitalize one
  frameTextarea: { text: one('juliet') },
  frameDesign: { text: two('kilo') },
  rerender: { text: one('lima') },
  pasteOnly: { text: one('mike') },
  wholePlain: { text: two('nimbus') }, // not a month: Proofr's rules would capitalize one before the mock sees it
  wholeRich: { text: one('oscar') },
  // Same letters, only spacing changes: "did the letters change?" can't tell.
  spacing: { text: 'the papa report   is   ready', result: 'the papa report is ready' },
  // Drops a number, so the change guard stops it and the dialog offers Replace anyway.
  guarded: { text: 'teh quebec total is 40 today', result: 'the quebec total is today' },
};
const lines = (s) => s.split('\n').map((l) => `<div>${l}</div>`).join('');

const PAGE = `<!doctype html><meta charset="utf-8"><title>replace</title>
<body style="height:1600px">
<textarea id="textarea" rows="2" cols="60">${BOXES.textarea.text}</textarea>
<input id="input" size="60" value="${BOXES.input.text}">
<div id="ce" contenteditable="true">${BOXES.ce.text}</div>
<div id="ceParas" contenteditable="true">${BOXES.ceParas.text.split('\n').map((l) => `<p>${l}</p>`).join('')}</div>
<div id="ceDivs" contenteditable="true">${lines(BOXES.ceDivs.text)}</div>
<div id="ceBreaks" contenteditable="true">${BOXES.ceBreaks.text.split('\n').join('<br>')}</div>
<x-box id="shadowTextarea"></x-box>
<x-box id="shadowCe"></x-box>
<iframe id="frameCe" style="height:70px;width:500px" srcdoc='<!doctype html><body contenteditable="true">${lines(BOXES.frameCe.text)}</body>'></iframe>
<iframe id="frameTextarea" style="height:70px;width:500px" srcdoc='<!doctype html><textarea id="t" cols="50">${BOXES.frameTextarea.text}</textarea>'></iframe>
<iframe id="frameDesign" style="height:70px;width:500px" srcdoc='<!doctype html><body>${lines(BOXES.frameDesign.text)}<script>document.designMode="on"</script></body>'></iframe>
<div id="spacing" contenteditable="true" style="white-space:pre-wrap">${BOXES.spacing.text}</div>
<iframe id="frameGuarded" style="height:70px;width:500px" srcdoc='<!doctype html><body contenteditable="true">${BOXES.guarded.text}</body>'></iframe>
<div id="rerender" contenteditable="true">${BOXES.rerender.text}</div>
<div id="pasteOnly" contenteditable="true">${BOXES.pasteOnly.text}</div>
<div id="wholePlain" contenteditable="true">${lines(BOXES.wholePlain.text)}</div>
<div id="wholeRich" contenteditable="true">${BOXES.wholeRich.text} <a href="https://example.com">a link</a></div>
<script>
customElements.define('x-box', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'open' });
    if (this.id === 'shadowTextarea') root.innerHTML = '<textarea id="t" cols="60">${BOXES.shadowTextarea.text}</textarea>';
    else root.innerHTML = '<div id="t" contenteditable="true">${lines(BOXES.shadowCe.text)}</div>';
  }
});
// A framework that redraws the box while the answer is on its way: same text, new nodes.
// It fires as Proofr's "working" note appears: after the selection is captured,
// before any answer can land, however fast that is.
window.redrawOnNote = (redraw) => {
  const seen = new MutationObserver(() => { if (document.getElementById('sr-toast')) { seen.disconnect(); redraw(document.getElementById('rerender')); window.redrawn = true; } });
  seen.observe(document.documentElement, { childList: true, subtree: true });
};
// An editor that keeps its own model (Slate, Draft): a change it didn't make is
// undone at once, and text only comes in through paste.
const po = document.getElementById('pasteOnly');
let poModel = po.textContent;
po.addEventListener('input', () => { if (po.textContent !== poModel) po.textContent = poModel; });
po.addEventListener('paste', (e) => {
  e.preventDefault();
  const text = e.clipboardData.getData('text/plain');
  const s = getSelection(); const r = s.getRangeAt(0); r.deleteContents(); r.insertNode(document.createTextNode(text)); s.collapseToEnd(); poModel = po.textContent;
});
</script>`;

const server = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.url === '/page') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PAGE); }
  if (req.url === '/v1/models') { res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] })); }
  if (req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const sent = JSON.stringify(JSON.parse(body).messages);
      const hit = Object.values(BOXES).find((b) => sent.includes(b.text.split(' ')[1]));
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: hit ? (hit.result || fix(hit.text)) : 'no match' } }] }));
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT);

const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'proofr-replace-'));
fs.cpSync(src, ext, { recursive: true, filter: (p) => !/\/(\.git|market-research|store|screenshots|store-screenshots|node_modules|v2shots|test)(\/|$)/.test(p) });
const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ ...manifest, host_permissions: ['http://localhost/*'] }, null, 2));

const browser = await puppeteer.launch({ headless: false, pipe: true, enableExtensions: [ext], protocolTimeout: 60000, args: ['--window-size=1200,1000'] });
try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
  const sw = await swTarget.worker();
  await sw.evaluate(async (base) => {
    await chrome.storage.sync.set({ srCloudService: 'custom', srCloudCustomBaseURL: base, srCloudModel_custom: 'mock-model', srEngine: 'cloud', srWelcomeSeen: true });
  }, `http://localhost:${PORT}/v1`);

  // A fresh page per run, so one box's dialog can't affect the next.
  const openPage = async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 950 });
    await page.goto(`http://localhost:${PORT}/page`);
    await page.bringToFront();
    await sleep(300);
    return page;
  };

  // Puts focus in a box and selects all of it.
  const select = (page, id) => page.evaluate((boxId) => {
    const selectAll = (el, doc = document, sel = getSelection()) => {
      el.focus();
      if (el.select) { el.select(); return; }
      const r = doc.createRange(); r.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(r);
    };
    const host = document.getElementById(boxId);
    if (boxId.startsWith('shadow')) {
      const inner = host.shadowRoot.getElementById('t');
      selectAll(inner, document, host.shadowRoot.getSelection ? host.shadowRoot.getSelection() : getSelection());
      return;
    }
    if (boxId.startsWith('frame')) {
      const d = host.contentDocument;
      host.focus();
      const el = d.getElementById('t') || d.body;
      selectAll(el, d, d.getSelection());
      return;
    }
    selectAll(host);
  }, id);

  const textOf = (page, id) => page.evaluate((boxId) => {
    const host = document.getElementById(boxId);
    let el = host;
    if (boxId.startsWith('shadow')) el = host.shadowRoot.getElementById('t');
    if (boxId.startsWith('frame')) { const d = host.contentDocument; el = d.getElementById('t') || d.body; }
    return 'value' in el && el.tagName !== 'DIV' ? el.value : el.innerText;
  }, id);
  const clean = (s) => String(s).split('\n').map((l) => l.trim()).filter(Boolean).join('\n');

  // Is a Copy dialog open, in the page or in a frame?
  const dialogState = (page) => page.evaluate(() => {
    const docs = [document, ...[...document.querySelectorAll('iframe')].map((f) => f.contentDocument).filter(Boolean)];
    for (const d of docs) {
      const m = d.querySelector('#smart-rewrite-modal');
      if (m && m.classList.contains('sr-visible') || (m && getComputedStyle(m).display !== 'none' && m.offsetParent !== null)) {
        return { open: true, action: !!m.querySelector('#sr-action-btn'), inTop: d === document };
      }
    }
    return { open: false };
  });

  // The two ways in: the shortcut reads the page itself; the right-click menu gets
  // Chrome's selectionText, which has its line breaks collapsed to spaces.
  const run = async (page, how, flat) => {
    await sw.evaluate(async ({ how, flat }) => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (how === 'shortcut') {
        await runProofreadShortcut(tab);
        return;
      }
      if (how === 'field') { await handleMenuClick({ menuItemId: 'srField:grammar', frameId: flat.frameId || 0 }, tab); return; }
      await handleMenuClick({ menuItemId: 'sr:grammar', selectionText: flat.text, frameId: flat.frameId || 0 }, tab);
    }, { how, flat });
  };
  const trial = async (id, how) => {
    const box = BOXES[id];
    const page = await openPage();
    const name = `${id} via ${how}`;
    try {
      await select(page, id);
      const frameId = id.startsWith('frame')
        ? await sw.evaluate(async (i) => {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const res = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: () => !!(document.hasFocus() && window !== top) });
          return (res.find((r) => r.result) || {}).frameId || 0;
        }, id) : 0;
      const flat = { text: box.text.replace(/\n/g, ' '), frameId };
      if (id === 'rerender') await page.evaluate(() => window.redrawOnNote((b) => { b.innerHTML = `<span>${b.textContent}</span>`; }));
      await run(page, how, flat);
      await sleep(900);
      const got = clean(await textOf(page, id));
      const want = clean(fix(box.text));
      const dlg = await dialogState(page);
      if (id === 'rerender') check(`${name}: the redraw really happened first`, await page.evaluate(() => window.redrawn === true));
      check(name, got === want && !dlg.open, got === want ? `dialog ${JSON.stringify(dlg)}` : `text is ${JSON.stringify(got)}, dialog ${JSON.stringify(dlg)}`);
    } catch (e) {
      check(name, false, `threw ${String(e.message || e).split('\n')[0]}`);
    } finally {
      await page.close();
    }
  };

  for (const id of ['textarea', 'input', 'ce', 'ceParas', 'ceDivs', 'ceBreaks', 'shadowTextarea', 'shadowCe', 'frameCe', 'frameTextarea', 'frameDesign', 'rerender', 'pasteOnly']) {
    await trial(id, 'menu');
    await trial(id, 'shortcut');
  }

  // After a redraw the text is found again, unless it's there twice: then Proofr
  // must not guess which one to overwrite.
  {
    const page = await openPage();
    await page.evaluate(() => { const e = document.getElementById('rerender'); e.innerHTML = `<div>${e.textContent}</div><div>${e.textContent}</div>`; const r = document.createRange(); r.selectNodeContents(e.firstChild); e.focus(); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
    await page.evaluate(() => window.redrawOnNote((b) => { b.innerHTML = String(b.innerHTML); }));
    await run(page, 'menu', { text: BOXES.rerender.text, frameId: 0 });
    await sleep(900);
    const t = await textOf(page, 'rerender');
    check('text there twice after a redraw is not guessed at', (t.match(/teh lima/g) || []).length === 2 && (await dialogState(page)).open, JSON.stringify(t));
    await page.close();
  }

  // A box in a frame: Undo on the note works from the top page, and Proofr's own
  // UI is never added to the editable frame.
  {
    const page = await openPage();
    await select(page, 'frameCe');
    const frameId = await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const res = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: () => !!(document.hasFocus() && window !== top) });
      return (res.find((r) => r.result) || {}).frameId || 0;
    });
    await run(page, 'menu', { text: BOXES.frameCe.text.replace(/\n/g, ' '), frameId });
    await sleep(800);
    const ui = await page.evaluate(() => ({
      top: !!document.querySelector('#sr-toast'),
      frame: !!document.getElementById('frameCe').contentDocument.querySelector('#sr-toast, #smart-rewrite-modal'),
    }));
    check('frame: the note is in the top page, nothing added to the editable frame', ui.top && !ui.frame, JSON.stringify(ui));
    const undone = await page.evaluate(() => { const b = document.querySelector('#sr-toast .sr-success-undo') || [...document.querySelectorAll('#sr-toast button')].find((x) => /undo/i.test(x.textContent)); if (b) b.click(); return !!b; });
    await sleep(600);
    check('frame: Undo on the note restores the original', undone && clean(await textOf(page, 'frameCe')) === clean(BOXES.frameCe.text), clean(await textOf(page, 'frameCe')));
    await page.close();
  }

  // A fix of spacing alone goes in, in any box.
  for (const how of ['menu', 'shortcut']) {
    const page = await openPage();
    await select(page, 'spacing');
    await run(page, how, { text: BOXES.spacing.text, frameId: 0 });
    await sleep(800);
    const raw = await page.evaluate(() => document.getElementById('spacing').textContent);
    check(`spacing-only fix via ${how}`, raw === BOXES.spacing.result, JSON.stringify(raw));
    await page.close();
  }

  // The change guard stops a Proofread for a box in a frame: the dialog opens in
  // the top page, and its Replace anyway reaches into the frame.
  {
    const page = await openPage();
    await select(page, 'frameGuarded');
    const frameId = await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const res = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: () => !!(document.hasFocus() && window !== top) });
      return (res.find((r) => r.result) || {}).frameId || 0;
    });
    await run(page, 'menu', { text: BOXES.guarded.text, frameId });
    await sleep(800);
    const frameText = () => page.evaluate(() => document.getElementById('frameGuarded').contentDocument.body.innerText.trim());
    const dlg = await dialogState(page);
    check('frame + guard: dialog in the top page, box not changed yet', dlg.open && dlg.inTop && dlg.action && (await frameText()) === BOXES.guarded.text, JSON.stringify(dlg));
    await page.evaluate(() => document.getElementById('sr-action-btn').click());
    await sleep(800);
    check('frame + guard: Replace anyway writes into the frame', (await frameText()) === BOXES.guarded.result, await frameText());
    await page.close();
  }

  // A frame from another site, which Proofr has no access to under the one-tab
  // grant: no error, the result still arrives, in a dialog with Copy.
  {
    const page = await openPage();
    await page.evaluate((port) => { const f = document.createElement('iframe'); f.id = 'other'; f.src = `http://127.0.0.1:${port}/page`; document.body.prepend(f); }, PORT);
    await sleep(500);
    const frame = page.frames().find((f) => f.url().includes('127.0.0.1'));
    await run(page, 'menu', { text: BOXES.textarea.text, frameId: 999999 });
    await sleep(700);
    const dlg = await dialogState(page);
    check('unreachable frame: the result opens in a dialog with Copy', !!frame && dlg.open && !dlg.action, JSON.stringify(dlg));
    await page.close();
    // The shortcut asks every frame; one it can't reach must not stop it.
    const page2 = await openPage();
    await page2.evaluate((port) => { const f = document.createElement('iframe'); f.src = `http://127.0.0.1:${port}/page`; document.body.prepend(f); }, PORT);
    await sleep(500);
    await select(page2, 'textarea');
    await run(page2, 'shortcut', {});
    await sleep(700);
    check('another site\'s frame on the page: the shortcut still replaces in the top page', clean(await textOf(page2, 'textarea')) === clean(fix(BOXES.textarea.text)));
    await page2.close();
  }

  // No selection, cursor in a rich text box with nothing but plain lines.
  const whole = async (id, how) => {
    const page = await openPage();
    await page.evaluate((i) => { const e = document.getElementById(i); e.focus(); const r = document.createRange(); r.selectNodeContents(e); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }, id);
    await run(page, how, { frameId: 0 });
    await sleep(900);
    const notice = await page.evaluate(() => document.querySelector('#smart-rewrite-modal .sr-notice')?.innerText || '');
    const r = { text: clean(await textOf(page, id)), dlg: await dialogState(page), notice };
    await page.close();
    return r;
  };
  for (const how of ['shortcut', 'field']) {
    const r = await whole('wholePlain', how);
    // A whole box starts a sentence, so its first word gets a capital too.
    const want = clean(fix(BOXES.wholePlain.text)).replace(/^t/, 'T');
    check(`wholePlain (no selection, plain lines) via ${how}`, r.text === want && !r.dlg.open, JSON.stringify(r));
    // With a link in it, plain text would destroy the link: never silently, and
    // the box must be unchanged with the result shown for review.
    const rich = await whole('wholeRich', how);
    check(`wholeRich (has a link) is left alone via ${how}`, /teh/.test(rich.text) && rich.dlg.open && /Select just your text/.test(rich.notice), JSON.stringify(rich));
  }
} finally {
  await browser.close();
  server.close();
  fs.rmSync(ext, { recursive: true, force: true });
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  :: ${r.detail}`}`);
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
