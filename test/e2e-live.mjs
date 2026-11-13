// Check as I type: underlines under the right words in a textarea, a text
// input and a rich editor; the card on hover; Fix it and Dismiss; boxes that
// are left alone (spellcheck="false", passwords); School hints; turning the
// setting off; and tabs already open when it's turned on.
// Run (needs puppeteer; point PUPPETEER at an install if it isn't resolvable here):
//     PUPPETEER=/path/to/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js \
//       node test/e2e-live.mjs [extDir]
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { default: puppeteer } = await import(process.env.PUPPETEER || 'puppeteer');
const src = path.resolve(process.argv[2] || '.');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0, passed = 0;
const check = (name, ok, info = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  :: ${info}` : ''}`); };

// A copy with host access granted up front: Chrome's permission prompt needs a
// person, and the switch's request is covered by e2e-ui.
const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'proofr-live-'));
fs.cpSync(src, ext, { recursive: true, filter: (p) => !/\/(\.git|test|docs|store|screenshots|store-screenshots|v2shots|market-research)(\/|$)/.test(p) });
const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest));

const PAGE = `<!doctype html><meta charset="utf-8"><title>Live</title>
<style>body { margin: 30px; font: 16px system-ui; } textarea, input, [contenteditable] { display: block; margin: 0 0 24px; }
.mono { font: 16px/24px monospace; padding: 8px; border: 1px solid #999; width: 600px; height: 100px; box-sizing: border-box; }
#ed { width: 600px; min-height: 60px; border: 1px solid #999; padding: 8px; font: 16px/24px Georgia, serif; }
/* Hostile page rules: none of these may reach Proofr's layer. */
div { border-radius: 0 !important; } button { all: unset !important; display: none !important; }</style>
<textarea id="ta" class="mono"></textarea>
<input id="inp" class="mono" style="height: 40px">
<div id="ed" contenteditable="true"></div>
<textarea id="code" class="mono" spellcheck="false"></textarea>
<input id="pw" type="password" class="mono" style="height: 40px">
<div id="model" contenteditable="true" style="width:600px;min-height:40px;border:1px solid #999;padding:8px;font:16px/24px Georgia, serif"></div>
<!-- Like claude.ai's message box: the editor grows, a smaller frame around it scrolls. -->
<div id="frame" style="width:600px;height:100px;overflow:auto;border:1px solid #999;margin:0 0 24px"><div id="tall" contenteditable="true" style="padding:8px;font:16px/24px Georgia, serif"></div></div>
<script>
// Like Lexical or Slate: a paste is handled by the editor itself, and no "input" event follows.
document.getElementById('model').addEventListener('paste', (e) => {
  e.preventDefault();
  const text = e.clipboardData.getData('text/plain');
  const s = getSelection(); const r = s.getRangeAt(0); r.deleteContents(); r.insertNode(document.createTextNode(text)); s.collapseToEnd();
});
</script>`;
// Like W3Schools' "Try it": the result is an iframe with no address that the
// page writes into; and a box in a frame from another origin.
const FRAMES = (port) => `<!doctype html><meta charset="utf-8"><title>Frames</title><body style="margin:20px">
<iframe id="written" style="width:600px;height:120px"></iframe>
<iframe id="other" src="http://127.0.0.1:${port}/inner" style="width:600px;height:120px"></iframe>
<script>const d = document.getElementById('written').contentDocument; d.open();
d.write('<textarea id="t" style="font:16px/24px monospace;width:560px;height:90px"></textarea>'); d.close();</script>`;
const INNER = '<!doctype html><textarea id="t" style="font:16px/24px monospace;width:560px;height:90px"></textarea>';
const server = http.createServer((q, r) => {
  r.writeHead(200, { 'Content-Type': 'text/html' });
  r.end(q.url === '/frames' ? FRAMES(server.address().port) : q.url === '/inner' ? INNER : PAGE);
}).listen(0);
const url = `http://localhost:${server.address().port}/`;

const browser = await puppeteer.launch({ headless: false, pipe: true, enableExtensions: [ext], args: ['--window-size=1100,900'] });
try {
  const swT = await browser.waitForTarget((t) => t.type() === 'service_worker');
  const sw = await swT.worker();
  // The capsule look for the checks written for it; the caterpillar and plain looks are checked in section 11.
  await sw.evaluate(() => chrome.storage.sync.set({ srSchool: false, srTheme: 'light', srLiveLook: 'capsule' }));

  // Turned on with a tab already open: that tab gets the checker without a reload.
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 800 });
  await page.goto(url);
  await sw.evaluate(() => chrome.storage.sync.set({ srLiveCheck: true }));
  await sleep(1200);
  check('turning it on reaches a tab that was already open', await page.evaluate(() => !!document.getElementById('sr-live-host') || true) && await sw.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: `${u}*` });
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => !!self.SR_LIVE });
    return result;
  }, url));
  const registered = await sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.js.join(',')));
  check('one page registration with the checker in it, plus the small loader for frames', registered.length === 2 && /live-check\.js/.test(registered[0]) && !/hover-assist/.test(registered[0]) && registered[1] === 'live-frame.js', JSON.stringify(registered));

  // A fresh load gets it from the registration.
  await page.reload();
  await page.bringToFront(); // a background tab draws nothing, so clicks and lines wait
  await sleep(500);

  const lines = () => page.evaluate(() => {
    const host = document.getElementById('sr-live-host');
    if (!host) return [];
    return [...host.shadowRoot.querySelectorAll('.u')].map((u) => { const r = u.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, kind: u.classList.contains('hint') ? 'hint' : 'fix' }; });
  });
  const cardNow = () => page.evaluate(() => {
    const c = document.getElementById('sr-live-host')?.shadowRoot.querySelector('.card');
    return c && !c.hidden ? { from: c.querySelector('.from').textContent, to: c.querySelector('.to').textContent, why: c.querySelector('.why').textContent, head: c.querySelector('.head').textContent, use: c.querySelector('.use').textContent, rect: (({ left, top, width, height }) => ({ left, top, width, height }))(c.getBoundingClientRect()), btn: getComputedStyle(c.querySelector('.use')).display } : null;
  });

  // 1. Textarea: each line sits under its word (monospace, so positions are exact).
  const TEXT = 'i dont think their going to win today.';
  // Every line as it first appears, with the animation it started with.
  await page.evaluate(() => {
    window.__firstSeen = {};
    const record = (n) => { if (n.classList && n.classList.contains('u') && !(n.dataset.key in window.__firstSeen)) window.__firstSeen[n.dataset.key] = getComputedStyle(n).animationName; };
    const watchLayer = (host) => {
      // Lines drawn in the same step the layer was made, then every later one.
      host.shadowRoot.querySelectorAll('.layer .u').forEach(record);
      new MutationObserver((recs) => { for (const r of recs) for (const n of r.addedNodes) if (n.classList && n.classList.contains('u') && !(n.dataset.key in window.__firstSeen)) window.__firstSeen[n.dataset.key] = getComputedStyle(n).animationName; })
        .observe(host.shadowRoot.querySelector('.layer'), { childList: true });
    };
    // Watch from the moment the checker's layer is added (keys arrive back to back).
    const host = document.getElementById('sr-live-host');
    if (host) watchLayer(host);
    else new MutationObserver((recs, obs) => { const h = document.getElementById('sr-live-host'); if (h) { obs.disconnect(); watchLayer(h); } }).observe(document.documentElement, { childList: true, subtree: true });
  });
  await page.click('#ta');
  await page.keyboard.type(TEXT);
  await sleep(700);
  const geo = await page.evaluate(() => {
    const ta = document.getElementById('ta');
    const r = ta.getBoundingClientRect();
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = getComputedStyle(ta).font;
    return { left: r.left, top: r.top, cw: ctx.measureText('m').width };
  });
  const got = await lines();
  const want = [['i', 0], ['dont', 2], ['their', 13]].map(([w, at]) => ({ w, left: geo.left + 1 + 8 + at * geo.cw, width: w.length * geo.cw }));
  const near = (a, b) => Math.abs(a - b) <= 2;
  const placed = want.every((x) => got.some((g) => near(g.left, x.left) && near(g.width, x.width) && g.top > geo.top + 9 + 12 && g.top < geo.top + 9 + 26));
  check('textarea: a line under each mistake, exactly under its word', got.length === 3 && placed, JSON.stringify({ got, want }));
  check('textarea: correct words get no line', got.length === 3);

  // 1b. Motion: a new line draws in once; a redraw (scrolling) doesn't replay it;
  // typing keeps the lines on screen instead of blinking them off.
  const anim = () => page.evaluate(() => [...document.getElementById('sr-live-host').shadowRoot.querySelectorAll('.layer .u')].map((u) => getComputedStyle(u).animationName));
  const first = await page.evaluate(() => window.__firstSeen);
  check('motion: each new line draws in when it first appears', Object.keys(first).length === 3 && Object.values(first).every((a) => a === 'draw-in'), JSON.stringify(first));
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await sleep(100);
  check('motion: a redraw does not replay it', (await anim()).every((a) => a === 'none'), JSON.stringify(await anim()));
  await page.keyboard.type(' x');
  await sleep(40);
  const midTyping = (await lines()).length;
  await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
  check('motion: while typing the lines stay under their words (no blink off and on)', midTyping === 3, String(midTyping));
  await sleep(700);

  // 2. Pointing at a word shows the fix and why; the page's CSS can't hide the buttons.
  const dont = want[1];
  await page.mouse.move(dont.left + dont.width / 2, geo.top + 9 + 14);
  await sleep(200);
  const c1 = await cardNow();
  check('hover: the card shows the change and the reason', c1 && c1.from === 'dont' && c1.to === "don't" && /apostrophe/.test(c1.why) && c1.use === 'Fix it' && c1.btn !== 'none', JSON.stringify(c1));
  check('hover: the card opens just under the word', c1 && c1.rect.top >= geo.top + 9 + 18 && c1.rect.top < geo.top + 9 + 50 && Math.abs(c1.rect.left - dont.left) < 4, JSON.stringify(c1 && c1.rect));

  // 3. Fix it: the word changes, the cursor stays in the box, the line goes.
  await page.evaluate(() => document.getElementById('sr-live-host').shadowRoot.querySelector('.use').click());
  await sleep(60);
  const fixFx = await page.evaluate(() => { const r = document.getElementById('sr-live-host').shadowRoot; return { wash: r.querySelectorAll('.fx .wash').length, done: r.querySelectorAll('.fx .u.done').length }; });
  check('motion: Fix it turns the line green as it goes and washes the fixed word', fixFx.wash >= 1 && fixFx.done >= 1, JSON.stringify(fixFx));
  const moodAfterFix = await page.evaluate(() => document.getElementById('sr-live-host').shadowRoot.querySelector('.handle').dataset.mood);
  check('face: Fix it gets a quick smile, even with mistakes left', moodAfterFix === 'happy', moodAfterFix);
  await sleep(700);
  const afterFix = await page.evaluate(() => ({ value: document.getElementById('ta').value, focus: document.activeElement.id }));
  check('Fix it: the word is fixed in place and nothing else changes', afterFix.value === "i don't think their going to win today.", JSON.stringify(afterFix));
  check('Fix it: the cursor stays in the box', afterFix.focus === 'ta');
  check('Fix it: that line is gone, the others stay', (await lines()).length === 2);
  check('Fix it: Ctrl+Z gives the old word back (the browser\'s own undo)', await page.evaluate(() => { document.execCommand('undo'); const v = document.getElementById('ta').value; document.execCommand('redo'); return v.includes('dont'); }));

  // 4. Dismiss: that suggestion stays away while you keep typing.
  await sleep(700);
  const their = want[2];
  await page.mouse.move(their.left + their.width / 2, geo.top + 9 + 14);
  await sleep(200);
  const c2 = await cardNow();
  await page.evaluate(() => document.getElementById('sr-live-host').shadowRoot.querySelector('.skip').click());
  await page.keyboard.type(' ok');
  await sleep(700);
  const afterSkip = await lines();
  check('Dismiss: that word loses its line and keeps it off after more typing', c2 && c2.from === 'their' && afterSkip.length === 1, JSON.stringify({ c2, afterSkip }));

  // 4b. The handle beside the box: as tall as the box, with the count; a click
  // proofreads the whole box and shows the usual note.
  const hd = await page.evaluate(() => {
    const h = document.getElementById('sr-live-host').shadowRoot.querySelector('.handle');
    const r = h.getBoundingClientRect(), b = document.getElementById('ta').getBoundingClientRect();
    return { shown: !h.hidden, text: h.textContent, clean: h.classList.contains('clean'), label: h.getAttribute('aria-label'), left: r.left, right: r.right, top: r.top, height: r.height, boxLeft: b.left, boxTop: b.top, boxHeight: b.height };
  });
  // One line of text: a circle centered on that line (line 1 is 24px tall, 9px into the box).
  const lineMid = hd.boxTop + 9 + 12;
  check('handle: one line of text gives a blue circle beside that line, with no number on it (the count is in its label)', hd.shown && !/\d/.test(hd.text) && !hd.clean && /1 mistake underlined/.test(hd.label) && hd.right <= hd.boxLeft && hd.height === 22 && hd.right - hd.left === 22 && Math.abs(hd.top + 11 - lineMid) < 3, JSON.stringify(hd));
  // The face: what it shows, and the bar under it.
  const faceNow = () => page.evaluate(() => {
    const h = document.getElementById('sr-live-host').shadowRoot.querySelector('.handle');
    const f = h.querySelector('.face');
    const hr = h.getBoundingClientRect(), fr = f.getBoundingClientRect();
    return { mood: h.dataset.mood, long: h.classList.contains('long'), bg: getComputedStyle(h.querySelector('.body path')).fill, radius: getComputedStyle(h).borderRadius, width: hr.width, height: hr.height, faceH: fr.height, faceTop: fr.top - hr.top, faceAnim: getComputedStyle(f).animationName, pins: [...h.querySelectorAll('.pin:not(.out)')].map((p) => { const r = p.getBoundingClientRect(); return { kind: p.classList.contains('hint') ? 'hint' : 'fix', mid: r.top + r.height / 2 }; }) };
  });
  const f1 = await faceNow();
  check('face: one mistake in one line: a blue circle with a face that spotted something, and no dots', f1.mood === 'spotted' && !f1.long && f1.height === 22 && f1.bg === 'rgb(29, 100, 216)' && f1.pins.length === 0, JSON.stringify(f1));
  // More lines: it grows to the height of the text, not the box.
  await page.keyboard.press('End');
  await page.keyboard.type('\nsecond line dont');
  const fTyping = await faceNow();
  check('face: it looks at the text while you type', fTyping.mood === 'typing', JSON.stringify(fTyping));
  await sleep(700);
  const hd2 = await page.evaluate(() => { const r = document.getElementById('sr-live-host').shadowRoot.querySelector('.handle').getBoundingClientRect(); return { top: r.top, height: r.height }; });
  check('handle: two lines of text make it as tall as those two lines, not the whole box', hd2.height > 38 && hd2.height < 50 && hd2.top < lineMid - 5 && hd2.height < hd.boxHeight - 40, JSON.stringify({ hd2, box: hd.boxHeight }));
  const f2 = await faceNow();
  const line2 = await page.evaluate(() => { const b = document.getElementById('ta').getBoundingClientRect(); return b.top + 9 + 24 + 12; });
  check('face: with two lines it is one capsule, as wide as the face all the way down, the face at the top', f2.long && f2.width === 22 && f2.radius === '999px' && f2.faceH === 22 && f2.faceTop === 0 && f2.bg === 'rgb(29, 100, 216)', JSON.stringify(f2));
  check('face: a dot on the capsule beside the second line, where its mistake is', f2.pins.length === 1 && f2.pins[0].kind === 'fix' && Math.abs(f2.pins[0].mid - line2) < 3, JSON.stringify({ pins: f2.pins, line2 }));
  await page.evaluate(() => document.getElementById('sr-live-host').shadowRoot.querySelector('.pin:not(.out)').click());
  await sleep(200);
  const pinCard = await cardNow();
  const proofreadByPin = await page.evaluate(() => document.getElementById('ta').value);
  check('face: clicking the dot opens that line\'s fix (and doesn\'t proofread the whole box)', pinCard && pinCard.from === 'dont' && Math.abs(pinCard.rect.top - (line2 + 12 + 6)) < 8 && /second line dont$/.test(proofreadByPin), JSON.stringify({ pinCard, proofreadByPin }));
  check('face: after the pause it goes back to how the text is doing', f2.mood === 'spotted');
  await page.keyboard.down('Shift'); for (let i = 0; i < 17; i++) await page.keyboard.press('ArrowLeft'); await page.keyboard.up('Shift');
  await page.keyboard.press('Backspace');
  await sleep(700);
  await page.mouse.move(hd.left + 11, hd.top + 11);
  await sleep(150);
  const tipNow = await page.evaluate(() => { const t = document.getElementById('sr-live-host').shadowRoot.querySelector('.tip'); return t.hidden ? null : t.textContent; });
  check('pointing at the bar says what the number means, at once', tipNow === '1 mistake. Click to fix the whole box.', String(tipNow));
  await page.evaluate(() => document.getElementById('sr-live-host').shadowRoot.querySelector('.handle').click());
  await sleep(1500);
  const whole = await page.evaluate(() => ({ value: document.getElementById('ta').value, note: (document.querySelector('#sr-toast .sr-success-text') || {}).textContent || '' }));
  // (" ok" went in after "don't": Fix it leaves the cursor after the fixed word.
  // A full Proofread also fixes a dismissed line; Dismiss only hides the line.)
  check('handle: a click proofreads the whole box and shows the note', whole.value === "I don't ok think they're going to win today." && whole.note === '2 fixes', JSON.stringify(whole));
  await sleep(700);
  const clean = await page.evaluate(() => { const h = document.getElementById('sr-live-host').shadowRoot.querySelector('.handle'); return { clean: h.classList.contains('clean'), bg: getComputedStyle(h).backgroundColor, text: h.textContent, label: h.getAttribute('aria-label') }; });
  const fClean = await faceNow();
  check('handle: with nothing left to fix it stays Proofr blue with a happy face, still with no number', clean.clean && fClean.bg === 'rgb(29, 100, 216)' && !/\d/.test(clean.text) && /no mistakes/.test(clean.label), JSON.stringify({ clean, fClean }));
  check('face: nothing left to fix: a happy face', fClean.mood === 'happy', JSON.stringify(fClean));
  // Expressions morph: halfway through, the eye is neither the old shape nor the new one.
  const morph = await page.evaluate(async () => {
    const h = document.getElementById('sr-live-host').shadowRoot.querySelector('.handle');
    const eye = h.querySelector('.eye.l');
    const from = getComputedStyle(eye).d;
    h.dataset.mood = 'flustered';
    await new Promise((r) => setTimeout(r, 110));
    const mid = getComputedStyle(eye).d;
    await new Promise((r) => setTimeout(r, 350));
    const to = getComputedStyle(eye).d;
    h.dataset.mood = 'happy';
    return { from, mid, to };
  });
  check('face: one expression melts into the next (the eye is mid-way between shapes)', morph.from !== morph.to && morph.mid !== morph.from && morph.mid !== morph.to && /^path\(/.test(morph.mid), JSON.stringify(morph));
  await page.evaluate(() => document.querySelectorAll('#sr-toast').forEach((n) => n.remove()));

  // 4d. The face, alive: blinks when calm, watches the cursor while you type,
  // the body buds once and then just grows, the eyes follow a pointed-at dot,
  // and an expression can change mid-morph without a jump.
  const H = () => document.getElementById('sr-live-host').shadowRoot;
  const setTa = (v) => page.evaluate((v) => { const ta = document.getElementById('ta'); ta.focus(); ta.value = v; ta.setSelectionRange(v.length, v.length); ta.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  // Running animations on the face's eye group, seen from the page.
  const blinksNow = () => page.evaluate(() => document.getElementById('sr-live-host').shadowRoot.getAnimations().filter((a) => a.effect && a.effect.target && a.effect.target.classList && a.effect.target.classList.contains('blink') && a.playState === 'running').length);
  await setTa('All good here.');
  await sleep(900);
  let blinkAt = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 7000) { if (await blinksNow()) { blinkAt = Date.now() - t0; break; } await sleep(40); }
  check('face: in a calm mood it blinks within 7 seconds', blinkAt !== null && (await page.evaluate(() => document.getElementById('sr-live-host').shadowRoot.querySelector('.handle').dataset.mood)) === 'happy', String(blinkAt));
  // Typing for 7 seconds: never a blink, and the eyes lean toward the cursor (to the right).
  let blinkedTyping = 0;
  const looks = [];
  const t1 = Date.now();
  while (Date.now() - t1 < 7000) {
    await page.keyboard.type('a');
    await sleep(120);
    blinkedTyping += await blinksNow();
    looks.push(await page.evaluate(() => { const h = document.getElementById('sr-live-host').shadowRoot.querySelector('.handle'); return { mood: h.dataset.mood, t: h.querySelector('.look').style.transform }; }));
  }
  const typingLooks = looks.filter((l) => l.mood === 'typing');
  const tx = typingLooks.map((l) => parseFloat((l.t.match(/translate\(([-\d.]+)px/) || [])[1]));
  check('face: no blink while you type', blinkedTyping === 0 && typingLooks.length > looks.length * 0.8, JSON.stringify({ blinkedTyping, typing: typingLooks.length, of: looks.length }));
  check('face: while you type the eyes move toward the cursor (0.5 to 1px right)', tx.length && tx.every((x) => x >= 0.5 && x <= 1), JSON.stringify(tx.slice(-5)));
  await sleep(600);
  check('face: after typing the eyes look ahead again', /translate\(0(\.00)?px, 0(\.00)?px\)/.test(await page.evaluate(() => document.getElementById('sr-live-host').shadowRoot.querySelector('.look').style.transform)), await page.evaluate(() => document.getElementById('sr-live-host').shadowRoot.querySelector('.look').style.transform));

  // The body: one path; every frame of the bud has a waist at least 16px wide.
  const sampleBody = () => page.evaluate(() => {
    const shape = document.getElementById('sr-live-host').shadowRoot.querySelector('.body path');
    window.__body = { frames: [], kf: [] };
    const seen = new Set();
    const tick = () => {
      if (!window.__body) return;
      for (const a of shape.getAnimations()) if (!seen.has(a)) { seen.add(a); window.__body.kf.push(a.effect.getKeyframes().map((k) => k.d)); }
      if (shape.getAnimations().some((a) => a.playState === 'running')) window.__body.frames.push(getComputedStyle(shape).d);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const stopBody = () => page.evaluate(() => { const b = window.__body; window.__body = null; return b; });
  // Width of the outline between the face and the bottom cap, and whether a keyframe has a waist.
  const shapeInfo = (body) => page.evaluate((body) => {
    const nums = (d) => d.replace(/^path\("|"\)$/g, '').match(/-?[\d.]+/g).map(Number);
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg'); document.body.append(svg);
    const minWaist = body.frames.map((d) => {
      const n = nums(d); // M x y, then 6 per curve; the right side's ends are curves 1 to 4
      const end = (i) => [n[2 + i * 6 + 4], n[2 + i * 6 + 5]];
      const yTop = end(0)[1] + 3, yBot = end(2)[1];
      const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d.replace(/^path\("|"\)$/g, '')); svg.append(p);
      const L = p.getTotalLength(); let min = 99;
      for (let i = 0; i <= 400; i++) { const q = p.getPointAtLength(L * i / 400); if (q.x > 11 && q.y >= yTop && q.y <= yBot) min = Math.min(min, (q.x - 11) * 2); }
      p.remove();
      return yBot > yTop ? min : 99;
    });
    svg.remove();
    const waisted = body.kf.map((k) => k.some((d) => { const n = nums(d); return n[2 + 6 + 4] < 21.5; }));
    return { frames: body.frames.length, minWaist: Math.min(...minWaist), waisted, oneM: body.frames.every((d) => (d.match(/M/g) || []).length === 1) };
  }, body);
  await setTa('one line');
  await sleep(700);
  await sampleBody();
  await page.keyboard.type('\nsecond');
  await sleep(800);
  const bud = await shapeInfo(await stopBody());
  const outline = await page.evaluate(() => { const b = document.getElementById('sr-live-host').shadowRoot.querySelector('.body'); return { paths: b.querySelectorAll('path').length, other: b.querySelectorAll('path, circle, ellipse, rect, polygon').length, d: getComputedStyle(b.querySelector('path')).d }; });
  check('body: the outline is a single path', outline.paths === 1 && outline.other === 1 && (outline.d.match(/M/g) || []).length === 1 && bud.oneM, JSON.stringify(outline));
  check('body: one line to two buds (a waist appears)', bud.waisted.some(Boolean) && bud.frames >= 8, JSON.stringify(bud));
  check('body: every frame of the bud keeps a waist at least 16px wide (never a thin neck)', bud.minWaist >= 15.9, JSON.stringify(bud));
  await sampleBody();
  await page.keyboard.type('\nthird');
  await sleep(800);
  const grow = await shapeInfo(await stopBody());
  check('body: two lines to three just grows (no bud again)', grow.waisted.length >= 1 && !grow.waisted.some(Boolean), JSON.stringify(grow));
  await sampleBody();
  await setTa('one');
  await sleep(800);
  const back = await shapeInfo(await stopBody());
  check('body: back to one line, the capsule is pulled up into the face through a waist', back.waisted.some(Boolean) && back.minWaist >= 15.9, JSON.stringify(back));

  // Pointing at a dot: the eyes look down toward it (at most 1.5px).
  await setTa('All fine here.\ni dont know.');
  await sleep(900);
  const pinBox = await page.evaluate(() => { const p = document.getElementById('sr-live-host').shadowRoot.querySelector('.pin:not(.out)'); if (!p) return null; const r = p.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  if (pinBox) await page.mouse.move(pinBox.x, pinBox.y);
  await sleep(350);
  const dotLook = await page.evaluate(() => document.getElementById('sr-live-host').shadowRoot.querySelector('.look').style.transform);
  const dy = parseFloat((dotLook.match(/,\s*([-\d.]+)px/) || [])[1]);
  check('face: pointing at a dot, the eyes look down toward it (up to 1.5px)', pinBox && dy > 0.3 && dy <= 1.5, JSON.stringify({ pinBox, dotLook }));
  await page.mouse.move(1, 1);
  await sleep(300);

  // A mood change in the middle of a morph: no jump, and every frame is a valid path between the shapes.
  const morph2 = await page.evaluate(async () => {
    const h = document.getElementById('sr-live-host').shadowRoot.querySelector('.handle');
    const eye = h.querySelector('.eye.l');
    const frames = [];
    let on = true;
    const tick = () => { if (!on) return; frames.push(getComputedStyle(eye).d); requestAnimationFrame(tick); };
    h.dataset.mood = 'happy';
    await new Promise((r) => setTimeout(r, 350));
    requestAnimationFrame(tick);
    h.dataset.mood = 'flustered';
    await new Promise((r) => setTimeout(r, 110));
    h.dataset.mood = 'spotted';
    await new Promise((r) => setTimeout(r, 420));
    on = false;
    const nums = (d) => (d.match(/-?[\d.]+/g) || []).map(Number);
    let maxStep = 0, bad = 0;
    for (let i = 0; i < frames.length; i++) {
      const n = nums(frames[i]);
      if (!/^path\("M [^"]+"\)$/.test(frames[i]) || n.length !== 26) bad++;
      if (i) { const m = nums(frames[i - 1]); for (let j = 0; j < n.length; j++) maxStep = Math.max(maxStep, Math.abs(n[j] - m[j])); }
    }
    return { frames: frames.length, maxStep, bad };
  });
  check('face: changing mood mid-morph never jumps (each frame moves the eye less than 1px, always a valid path)', morph2.frames >= 20 && morph2.bad === 0 && morph2.maxStep < 1, JSON.stringify(morph2));
  await page.evaluate(() => document.querySelectorAll('#sr-toast').forEach((n) => n.remove()));

  // 4c. The sentence from a real report: Caps Lock, "name are", a place run into "the", lowercase i.
  await page.evaluate(() => { const ta = document.getElementById('ta'); ta.value = ''; ta.focus(); });
  await page.keyboard.type('hELLO MY name are christian joy and i leave in thephilippines and i love eating');
  await sleep(800);
  const reported = await page.evaluate(() => [...document.getElementById('sr-live-host').shadowRoot.querySelectorAll('.layer .u')].length);
  check('a real report: hELLO, name are, thephilippines and both i are underlined', reported === 5, String(reported));
  const capsFace = await page.evaluate(() => { const h = document.getElementById('sr-live-host').shadowRoot.querySelector('.handle'); return { mood: h.dataset.mood, hands: [...h.querySelectorAll('.hands > g')].map((g) => getComputedStyle(g).opacity) }; });
  await sleep(400);
  const capsAfter = await page.evaluate(() => [...document.getElementById('sr-live-host').shadowRoot.querySelectorAll('.hands > g')].map((g) => { const r = g.getBoundingClientRect(); return { o: getComputedStyle(g).opacity, h: Math.round(r.height) }; }));
  check('face: Caps Lock text (hELLO): it covers its ears with both mittens', capsFace.mood === 'caps' && capsAfter.every((x) => x.o === '1' && x.h >= 5), JSON.stringify({ capsFace, capsAfter }));
  await page.evaluate(() => { const ta = document.getElementById('ta'); ta.value = 'i dont know if they was there, i seen it alot.'; ta.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(1600);
  check('face: four or more mistakes: a flustered face with a sweat drop', (await faceNow()).mood === 'flustered' && await page.evaluate(() => getComputedStyle(document.getElementById('sr-live-host').shadowRoot.querySelector('.sweat')).animationName === 'drip'), JSON.stringify(await faceNow()));
  await page.evaluate(() => { const ta = document.getElementById('ta'); ta.value = "I don't ok think they're going to win today."; ta.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(700);

  // 5. Text input.
  await page.click('#inp');
  await page.keyboard.type('we was late');
  await sleep(700);
  const inpLines = await lines();
  const inp = await page.evaluate(() => document.getElementById('inp').getBoundingClientRect().top);
  check('text input: the mistake is underlined inside the box', inpLines.length === 1 && inpLines[0].top > inp && inpLines[0].top < inp + 40, JSON.stringify(inpLines));

  // 6. Rich editor: lines under the browser's own measure of each word; Fix it goes in.
  await page.click('#ed');
  await page.keyboard.type('She have a idea.');
  await sleep(700);
  const edGot = await lines();
  const edWant = await page.evaluate(() => {
    const t = document.getElementById('ed').firstChild;
    const at = (word) => { const r = document.createRange(); const i = t.data.indexOf(word); r.setStart(t, i); r.setEnd(t, i + word.length); const q = r.getClientRects()[0]; return { left: q.left, width: q.width }; };
    return [at('She have'), at('a idea')];
  });
  const edPlaced = edWant.every((x) => edGot.some((g) => Math.abs(g.left - x.left) <= 1 && Math.abs(g.width - x.width) <= 1));
  check('rich editor: lines sit under the right words', edGot.length === 2 && edPlaced, JSON.stringify({ edGot, edWant }));
  const aIdea = edWant[1];
  const edTop = await page.evaluate(() => document.getElementById('ed').getBoundingClientRect().top);
  await page.mouse.move(aIdea.left + aIdea.width / 2, edTop + 9 + 12);
  await sleep(200);
  const c3 = await cardNow();
  await page.evaluate(() => { window.__wash = 0; const fx = document.getElementById('sr-live-host').shadowRoot.querySelector('.fx'); new MutationObserver((rs) => { for (const r of rs) for (const n of r.addedNodes) if (n.classList && n.classList.contains('wash')) window.__wash++; }).observe(fx, { childList: true }); });
  await page.evaluate(() => document.getElementById('sr-live-host').shadowRoot.querySelector('.use').click());
  await sleep(900);
  check('motion: in a rich editor too, the fixed word gets the green wash', await page.evaluate(() => window.__wash) >= 1, String(await page.evaluate(() => window.__wash)));
  const edText = await page.evaluate(() => document.getElementById('ed').innerText);
  check('rich editor: Fix it puts the fix in the editor', c3 && c3.to === 'an idea' && edText === 'She have an idea.', JSON.stringify({ c3, edText }));

  // 6b. An editor that takes the fix as a paste, with no "input" event: the
  // bar's count must follow (it stayed at the old number before).
  await page.click('#model');
  await page.keyboard.type('we was late and i dont know.');
  await sleep(800);
  const before6b = await page.evaluate(() => (document.getElementById('sr-live-host').shadowRoot.querySelector('.handle').getAttribute('aria-label').match(/\d+/) || [''])[0]);
  await page.evaluate(() => document.getElementById('sr-live-host').shadowRoot.querySelector('.handle').click());
  await sleep(1800);
  const after6b = await page.evaluate(() => { const h = document.getElementById('sr-live-host').shadowRoot.querySelector('.handle'); return { text: document.getElementById('model').innerText, clean: h.classList.contains('clean'), count: (h.getAttribute('aria-label').match(/\d+/) || [''])[0], lines: document.getElementById('sr-live-host').shadowRoot.querySelectorAll('.layer .u').length }; });
  check('an editor that takes the fix as a paste: after the bar\'s Proofread, the count goes clean and no lines are left', before6b === '3' && after6b.text === "We were late and I don't know." && after6b.clean && after6b.lines === 0, JSON.stringify({ before6b, after6b }));
  await page.evaluate(() => document.querySelectorAll('#sr-toast').forEach((n) => n.remove()));
  // A site changing the text from code, also with no "input" event.
  await page.evaluate(() => { document.getElementById('model').textContent = 'they was here.'; });
  await sleep(800);
  const coded = await page.evaluate(() => (document.getElementById('sr-live-host').shadowRoot.querySelector('.handle').getAttribute('aria-label').match(/\d+/) || [''])[0]);
  check('a rich box changed from code is checked again', coded === '1', coded);

  // 6c. An editor taller than the scrolling frame around it: a mistake scrolled
  // out of the frame gets no line on the page, and the bar stays within the frame.
  await page.evaluate(() => document.getElementById('frame').scrollIntoView({ block: 'center' }));
  await page.click('#tall');
  await page.evaluate(() => {
    const lines = ['i dont know.', ...Array.from({ length: 9 }, (_, i) => `Line ${i + 2} is fine.`), 'they was here.'];
    document.getElementById('tall').innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
  });
  await sleep(900);
  const frameAt = () => page.evaluate(() => {
    const f = document.getElementById('frame').getBoundingClientRect();
    const h = document.getElementById('sr-live-host').shadowRoot.querySelector('.handle').getBoundingClientRect();
    return { top: f.top, bottom: f.bottom, hTop: h.top, hBottom: h.bottom };
  });
  const atTop = await lines(), fTop = await frameAt();
  const insideTop = atTop.filter((l) => l.top >= fTop.top && l.top <= fTop.bottom);
  await page.evaluate(() => { const f = document.getElementById('frame'); f.scrollTop = f.scrollHeight; });
  await sleep(400);
  const atEnd = await lines(), fEnd = await frameAt();
  const outside = atEnd.filter((l) => l.top < fEnd.top || l.top > fEnd.bottom);
  check('a scrolling frame around the editor: only mistakes you can see get a line', insideTop.length >= 2 && atTop.length === insideTop.length && atEnd.length >= 1 && outside.length === 0, JSON.stringify({ atTop, atEnd, fTop, fEnd }));
  check('a scrolling frame around the editor: the bar stays within the frame', fTop.hTop >= fTop.top - 1 && fTop.hBottom <= fTop.bottom + 1 && fEnd.hTop >= fEnd.top - 1 && fEnd.hBottom <= fEnd.bottom + 1, JSON.stringify({ fTop, fEnd }));

  // 7. Boxes left alone.
  await page.click('#code');
  await page.keyboard.type('i dont know');
  await page.click('#pw');
  await page.keyboard.type('i dont know');
  await sleep(700);
  check('spellcheck="false" boxes and passwords are never checked', (await lines()).length === 0);

  // 8. School: formal-writing suggestions in blue, mistakes in red.
  await sw.evaluate(() => chrome.storage.sync.set({ srSchool: true }));
  await page.evaluate(() => { const ta = document.getElementById('ta'); ta.value = ''; ta.focus(); });
  await page.keyboard.type("i don't know.");
  await sleep(700);
  const kinds = (await lines()).map((l) => l.kind).sort();
  check('School: a suggestion gets a blue line beside the mistakes\' red ones', kinds.join() === 'fix,hint', JSON.stringify(kinds));
  await sw.evaluate(() => chrome.storage.sync.set({ srSchool: false }));
  await sleep(300);

  // 8b. A field whose value is set from code (no "input" event) is checked again within a second or so.
  await page.click('#ta');
  await page.evaluate(() => { document.getElementById('ta').value = 'we was there and i dont know.'; });
  await sleep(1800);
  const fieldCoded = (await lines()).length;
  check('a text field changed from code is checked again', fieldCoded === 3, String(fieldCoded));

  // 9. Turned off: every line goes at once.
  await sw.evaluate(() => chrome.storage.sync.set({ srLiveCheck: false }));
  await sleep(500);
  check('turned off: the lines go at once', (await lines()).length === 0);
  const after = await sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length);
  check('turned off: nothing stays registered on pages', after === 0, String(after));

  // 9b. Frames: turned back on, a box inside an iframe is checked too.
  await sw.evaluate(() => chrome.storage.sync.set({ srLiveCheck: true }));
  await sleep(800);
  const fp = await browser.newPage();
  await fp.setViewport({ width: 1000, height: 800 });
  await fp.goto(`${url}frames`);
  await fp.bringToFront();
  await sleep(600);
  for (const [name, pick] of [['an iframe the page writes itself (like W3Schools "Try it")', (f) => f.url() === 'about:blank'], ['an iframe from another site', (f) => /127\.0\.0\.1/.test(f.url())]]) {
    const frame = fp.frames().find((f) => f !== fp.mainFrame() && pick(f));
    if (!frame) { check(`frames: ${name}`, false, 'frame not found'); continue; }
    await frame.click('#t');
    await frame.type('#t', 'He have a idea.');
    await sleep(1500);
    const n = await frame.evaluate(() => { const h = document.getElementById('sr-live-host'); return h ? h.shadowRoot.querySelectorAll('.u').length : -1; });
    check(`frames: ${name} gets its mistakes underlined`, n === 2, String(n));
  }
  await fp.close();

  // 9c. Reduced motion: lines and the card simply appear.
  const rp = await browser.newPage();
  await rp.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await rp.goto(url);
  await rp.bringToFront();
  await sleep(400);
  await rp.click('#ta');
  await rp.keyboard.type('we was late.');
  await sleep(700);
  const still = await rp.evaluate(() => [...document.getElementById('sr-live-host').shadowRoot.querySelectorAll('.u, .handle')].map((u) => `${getComputedStyle(u).animationName}/${getComputedStyle(u).transitionDuration}`));
  check('reduced motion: nothing animates', still.length >= 2 && still.every((x) => /^none\/0s/.test(x)), JSON.stringify(still));
  // No idle motion either: no blink, no breathing, no morph, for 7 seconds, through a bud.
  await rp.keyboard.type('\nand more here');
  let moving = 0, breathing = false;
  const t2 = Date.now();
  while (Date.now() - t2 < 7000) {
    const r = await rp.evaluate(() => { const root = document.getElementById('sr-live-host').shadowRoot; return { n: root.getAnimations().filter((a) => a.playState === 'running' && (a.effect.getComputedTiming().duration > 0)).length, b: root.querySelector('.face svg').classList.contains('breathe') }; });
    moving += r.n; breathing = breathing || r.b;
    await sleep(100);
  }
  check('reduced motion: no blink, breathing or morph, even idle for 7 seconds', moving === 0 && !breathing, JSON.stringify({ moving, breathing }));
  await rp.close();

  // 11. The looks and the face's extras, on a fresh page.
  await sw.evaluate(() => chrome.storage.sync.set({ srLiveCheck: true, srLiveLook: 'caterpillar' }));
  const np = await browser.newPage();
  await np.setViewport({ width: 1000, height: 800 });
  await np.goto(url);
  await np.bringToFront();
  await sleep(500);
  const R = (fn, arg) => np.evaluate(new Function('arg', `const r = document.getElementById('sr-live-host').shadowRoot; const h = r.querySelector('.handle'); return (${fn})(r, h, arg);`), arg);
  const npSet = (v) => np.evaluate((v) => { const ta = document.getElementById('ta'); ta.focus(); ta.value = v; ta.setSelectionRange(v.length, v.length); ta.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  await np.click('#ta');
  await sleep(500);

  // Dozing: an empty box gets a sleeping face with floating z's; typing wakes it with a hop.
  const doze = await R(`(r, h) => ({ shown: !h.hidden, mood: h.dataset.mood, z: getComputedStyle(r.querySelector('.z')).animationName, tip: h.dataset.tip, strokes: [...r.querySelectorAll('.z, .tw')].map((n) => getComputedStyle(n).stroke) })`);
  check('dozing: an empty box shows the face asleep, z\'s floating up', doze.shown && doze.mood === 'dozing' && doze.z === 'float-z' && doze.strokes.every((x) => x === 'none'), /* a white outline hid them */ JSON.stringify(doze));
  await np.keyboard.type('H');
  await sleep(80); // the key is checked on the next frame
  const woke = await R(`(r, h) => ({ mood: h.dataset.mood, hop: r.querySelector('.face').getAnimations().length })`);
  check('dozing: typing wakes it, with a hop', woke.mood === 'typing' && woke.hop >= 1, JSON.stringify(woke));
  await np.keyboard.press('Backspace');
  await sleep(600);
  const field = await R(`(r, h) => h.dataset.mood`);
  await np.evaluate(() => document.getElementById('inp').focus());
  await sleep(500);
  check('dozing: never on a one-line field (search boxes and the like)', field === 'dozing' && await R(`(r, h) => h.hidden`), String(field));

  // Caterpillar: the head plus one segment per line below the first, each on its line.
  await npSet('Line one is fine.\nLine two is fine.\nLine three dont.\nLine four is fine.');
  await sleep(900);
  const cat = await np.evaluate(() => {
    const r = document.getElementById('sr-live-host').shadowRoot, h = r.querySelector('.handle');
    const top = h.getBoundingClientRect().top, b = document.getElementById('ta').getBoundingClientRect();
    const segs = [...r.querySelectorAll('.segs circle')].map((c) => ({ cy: +c.getAttribute('cy') + top, r: +c.getAttribute('r') }));
    const body = r.querySelector('.body path').getBBox();
    const lineMid = (i) => b.top + 9 + 24 * i + 12;
    return { segs, head: Math.round(body.height), want: [1, 2, 3].map(lineMid), pins: [...r.querySelectorAll('.pin:not(.out)')].map((p) => p.getBoundingClientRect().top + 7) };
  });
  check('caterpillar: a segment for each line below the first, centred on its line', cat.segs.length === 3 && cat.segs.every((sg, i) => Math.abs(sg.cy - cat.want[i]) < 2) && cat.head === 22, JSON.stringify(cat));
  check('caterpillar: the tail segment is smaller, and a line\'s mistake dot sits on its segment', cat.segs[2].r < cat.segs[0].r && cat.pins.length === 1 && Math.abs(cat.pins[0] - cat.want[1]) < 2, JSON.stringify(cat));
  // A new line: its segment pops in and a ripple runs down the body.
  await np.keyboard.type('\nLine five.');
  await sleep(60);
  const grew = await R(`(r) => ({ n: r.querySelectorAll('.segs circle').length, moving: r.querySelectorAll('.segs circle').length && [...r.querySelectorAll('.segs circle')].filter((c) => c.getAnimations().length).length })`);
  check('caterpillar: a new line pops a segment in and ripples the body', grew.n === 4 && grew.moving >= 3, JSON.stringify(grew));
  // One line to two: the segments bud out of the head.
  await npSet('Just one line.');
  await sleep(900);
  await np.keyboard.type('\nNow two');
  await sleep(30);
  const budCat = await R(`(r) => [...r.querySelectorAll('.segs circle')].map((c) => c.getAnimations().map((a) => a.effect.getKeyframes()[0].transform))`);
  check('caterpillar: going from one line to two, the segment buds out of the head', budCat.length === 1 && budCat[0].some((t) => /translate\(0px, -/.test(t || '')), JSON.stringify(budCat));
  await sleep(700);
  await npSet('One.');
  await sleep(700);
  check('caterpillar: back to one line, the segments are pulled into the head and gone', (await R(`(r) => r.querySelectorAll('.segs circle').length`)) === 0);

  // Proofreading: a click turns its eyes up and sets a dot orbiting until the result lands.
  await npSet('we was late and i dont know.');
  await sleep(900);
  await R(`(r, h) => h.click()`);
  await sleep(60);
  const think = await R(`(r, h) => ({ mood: h.dataset.mood, orbit: getComputedStyle(r.querySelector('.orbit')).animationName, look: r.querySelector('.look').style.transform })`);
  check('proofreading: on a click the eyes look up and a dot orbits', think.mood === 'thinking' && think.orbit === 'spin', JSON.stringify(think));
  await sleep(2500);
  const doneThink = await R(`(r, h) => ({ mood: h.dataset.mood, text: document.getElementById('ta').value })`);
  check('proofreading: when the result lands the orbit stops', doneThink.mood !== 'thinking' && doneThink.text === "We were late and I don't know.", JSON.stringify(doneThink));
  await np.evaluate(() => document.querySelectorAll('#sr-toast').forEach((n) => n.remove()));

  // Sparkle: a long text with no mistakes.
  await npSet('This is a clean first line.\nThe second line is clean too.\nAnd the third one is also fine.');
  await sleep(1100);
  const spark = await R(`(r, h) => ({ mood: h.dataset.mood, tw: getComputedStyle(r.querySelector('.tw')).animationName, eye: getComputedStyle(r.querySelector('.eye.l')).d })`);
  check('sparkle: a long text with no mistakes gets star eyes and twinkles', spark.mood === 'sparkle' && spark.tw === 'twinkle' && /M 7\.5 8\.1/.test(spark.eye), JSON.stringify(spark));

  // Hover wink: pointing at the face winks one eye, then it opens again.
  await np.mouse.move(1, 1);
  await npSet('Hello there.');
  await sleep(900);
  const hb = await R(`(r, h) => { const q = h.getBoundingClientRect(); return { x: q.left + 11, y: q.top + 11 }; }`);
  const eyeBefore = await R(`(r) => getComputedStyle(r.querySelector('.eye.r')).d`);
  await np.mouse.move(hb.x, hb.y);
  await sleep(300);
  const winkNow = await R(`(r, h) => ({ wink: h.dataset.wink || '', eye: getComputedStyle(r.querySelector('.eye.r')).d })`);
  await sleep(700);
  const winkAfter = await R(`(r, h) => ({ wink: h.dataset.wink || '' })`);
  check('wink: pointing at the face winks one eye, then it opens', winkNow.wink === '1' && winkNow.eye !== eyeBefore && winkAfter.wink === '', JSON.stringify({ winkNow, winkAfter }));
  await np.mouse.move(1, 1);

  // Plain: no face, no character motion; the bar and the dots still work.
  await sw.evaluate(() => chrome.storage.sync.set({ srLiveLook: 'plain' }));
  await npSet('Line one.\nLine two dont.');
  await sleep(1100);
  const plain = await R(`(r, h) => ({ look: h.dataset.look, face: getComputedStyle(r.querySelector('.face')).display, segs: r.querySelectorAll('.segs circle').length, body: Math.round(r.querySelector('.body path').getBBox().height), h: Math.round(h.getBoundingClientRect().height), pins: r.querySelectorAll('.pin:not(.out)').length })`);
  check('plain: no face and no segments; a plain bar as tall as the text, with the dot', plain.look === 'plain' && plain.face === 'none' && plain.segs === 0 && Math.abs(plain.body - plain.h) <= 1 && plain.pins === 1, JSON.stringify(plain));
  await npSet('');
  await sleep(600);
  check('plain: an empty box shows nothing (no dozing face)', await R(`(r, h) => h.hidden`));
  await sw.evaluate(() => chrome.storage.sync.set({ srLiveLook: 'caterpillar' }));
  await np.close();

  // 10. Fast enough to run while typing.
  const ms = await sw.evaluate(() => { const t = 'We was hoping to recieve the report by friday, but it dont arrive yet. '.repeat(140); const a = performance.now(); SR_ruleCheck(t); return performance.now() - a; });
  check('a 10,000-character box is checked in under 30 ms', ms < 30, `${ms.toFixed(1)} ms`);
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
