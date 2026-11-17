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
  await sw.evaluate(() => chrome.storage.sync.set({ srSchool: false, srTheme: 'light' }));

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

  // 4b. The dot beside the box: one circle by the first line, its color the
  // news (red: mistakes, green: none). It never grows; a click proofreads the
  // whole box and shows the usual note.
  const RED = 'rgb(210, 69, 59)', YELLOW = 'rgb(227, 174, 11)', ORANGE = 'rgb(236, 122, 28)', GREEN = 'rgb(46, 154, 91)', BLUE = 'rgb(29, 100, 216)', GREY = 'rgb(168, 164, 155)';
  const dotOn = (pg) => pg.evaluate(() => {
    const h = document.getElementById('sr-live-host').shadowRoot.querySelector('.handle');
    const r = h.getBoundingClientRect(), a = getComputedStyle(h, '::after');
    return { shown: !h.hidden, state: h.dataset.state, color: a.backgroundColor, dot: a.width, radius: a.borderRadius, text: h.textContent, label: h.getAttribute('aria-label'), working: h.classList.contains('working'), left: r.left, right: r.right, top: r.top, height: r.height, width: r.width };
  });
  const hd = { ...(await dotOn(page)), ...(await page.evaluate(() => { const b = document.getElementById('ta').getBoundingClientRect(); return { boxLeft: b.left, boxTop: b.top, boxHeight: b.height }; })) };
  // One line of text: a circle centered on that line (line 1 is 24px tall, 9px into the box).
  const lineMid = hd.boxTop + 9 + 12;
  check('dot: one mistake gives a yellow circle beside the first line, with no number on it (the count is in its label)', hd.shown && hd.state === 'fix' && hd.color === YELLOW && hd.dot === '12px' && hd.radius === '50%' && !/\d/.test(hd.text) && /1 mistake underlined/.test(hd.label) && hd.right <= hd.boxLeft && hd.height === 22 && hd.width === 22 && Math.abs(hd.top + 11 - lineMid) < 3, JSON.stringify(hd));
  // More lines: it stays a 22px circle by the first line.
  await page.keyboard.press('End');
  await page.keyboard.type('\nsecond line dont\nthird line');
  await sleep(700);
  const hd2 = await dotOn(page);
  check('dot: three mistakes turn it orange', hd2.color === ORANGE && /3 mistakes/.test(hd2.label), JSON.stringify(hd2));
  check('dot: more lines of text never make it grow; it stays by the first line', hd2.height === 22 && hd2.width === 22 && Math.abs(hd2.top + 11 - lineMid) < 3, JSON.stringify(hd2));
  await page.keyboard.down('Shift'); for (let i = 0; i < 28; i++) await page.keyboard.press('ArrowLeft'); await page.keyboard.up('Shift');
  await page.keyboard.press('Backspace');
  await sleep(700);
  await page.mouse.move(hd.left + 11, hd.top + 11);
  await sleep(150);
  const tipNow = await page.evaluate(() => { const t = document.getElementById('sr-live-host').shadowRoot.querySelector('.tip'); return t.hidden ? null : t.textContent; });
  check('pointing at the dot says what its color means, at once', tipNow === '1 mistake. Click to fix the whole box.', String(tipNow));
  const hov = await page.evaluate(() => { const a = getComputedStyle(document.getElementById('sr-live-host').shadowRoot.querySelector('.handle'), '::after'); return { t: a.transform, s: a.boxShadow }; });
  check('pointing at the dot makes it grow with a ring, so it reads as a button', /matrix\(1\.2, 0, 0, 1\.2/.test(hov.t) && /4px/.test(hov.s), JSON.stringify(hov));
  await page.evaluate(() => document.getElementById('sr-live-host').shadowRoot.querySelector('.handle').click());
  await sleep(60);
  const busy = await dotOn(page);
  check('dot: a click makes it pulse while the box is proofread', busy.working && await page.evaluate(() => getComputedStyle(document.getElementById('sr-live-host').shadowRoot.querySelector('.handle'), '::after').animationName) === 'pulse', JSON.stringify(busy));
  await sleep(1500);
  const whole = await page.evaluate(() => ({ value: document.getElementById('ta').value, note: (document.querySelector('#sr-toast .sr-success-text') || {}).textContent || '' }));
  // (" ok" went in after "don't": Fix it leaves the cursor after the fixed word.
  // A full Proofread also fixes a dismissed line; Dismiss only hides the line.)
  check('dot: a click proofreads the whole box and shows the note', whole.value === "I don't ok think they're going to win today." && whole.note === '2 fixes', JSON.stringify(whole));
  await sleep(700);
  const clean = await dotOn(page);
  check('dot: with nothing left to fix it turns green and stops pulsing, still with no number', clean.state === 'clean' && clean.color === GREEN && !clean.working && !/\d/.test(clean.text) && /no mistakes/.test(clean.label), JSON.stringify(clean));
  await page.evaluate(() => document.querySelectorAll('#sr-toast').forEach((n) => n.remove()));

  // 4c. The sentence from a real report: Caps Lock, "name are", a place run into "the", lowercase i.
  await page.evaluate(() => { const ta = document.getElementById('ta'); ta.value = ''; ta.focus(); });
  await page.keyboard.type('hELLO MY name are christian joy and i leave in thephilippines and i love eating');
  await sleep(800);
  const reported = await page.evaluate(() => [...document.getElementById('sr-live-host').shadowRoot.querySelectorAll('.layer .u')].length);
  check('a real report: hELLO, name are, thephilippines and both i are underlined', reported === 5, String(reported));
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
  const after6b = await page.evaluate(() => { const h = document.getElementById('sr-live-host').shadowRoot.querySelector('.handle'); return { text: document.getElementById('model').innerText, clean: h.dataset.state === 'clean', count: (h.getAttribute('aria-label').match(/\d+/) || [''])[0], lines: document.getElementById('sr-live-host').shadowRoot.querySelectorAll('.layer .u').length }; });
  check('an editor that takes the fix as a paste: after the dot\'s Proofread, the count goes clean and no lines are left', before6b === '3' && after6b.text === "We were late and I don't know." && after6b.clean && after6b.lines === 0, JSON.stringify({ before6b, after6b }));
  await page.evaluate(() => document.querySelectorAll('#sr-toast').forEach((n) => n.remove()));
  // A site changing the text from code, also with no "input" event.
  await page.evaluate(() => { document.getElementById('model').textContent = 'they was here.'; });
  await sleep(800);
  const coded = await page.evaluate(() => (document.getElementById('sr-live-host').shadowRoot.querySelector('.handle').getAttribute('aria-label').match(/\d+/) || [''])[0]);
  check('a rich box changed from code is checked again', coded === '1', coded);

  // 6c. An editor taller than the scrolling frame around it: a mistake scrolled
  // out of the frame gets no line on the page, and the dot stays within the frame.
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
  check('a scrolling frame around the editor: the dot stays within the frame', fTop.hTop >= fTop.top - 1 && fTop.hBottom <= fTop.bottom + 1 && fEnd.hTop >= fEnd.top - 1 && fEnd.hBottom <= fEnd.bottom + 1, JSON.stringify({ fTop, fEnd }));

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
  const dotWith = await dotOn(page);
  check('School: a suggestion gets a blue line beside the mistakes\' red ones', kinds.join() === 'fix,hint', JSON.stringify(kinds));
  check('School: with a mistake and a suggestion the dot shows the mistake (yellow for one)', dotWith.state === 'fix' && dotWith.color === YELLOW, JSON.stringify(dotWith));
  await page.evaluate(() => { const ta = document.getElementById('ta'); ta.value = "I don't know."; ta.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(700);
  const dotHint = await dotOn(page);
  check('School: with only suggestions left the dot is blue', dotHint.state === 'hint' && dotHint.color === BLUE && /1 suggestion/.test(dotHint.label), JSON.stringify(dotHint));

  await sw.evaluate(() => chrome.storage.sync.set({ srSchool: false }));
  await sleep(300);

  // 8b. A field whose value is set from code (no "input" event) is checked again within a second or so.
  await page.click('#ta');
  await page.evaluate(() => { document.getElementById('ta').value = 'we was there and i dont know.'; });
  await sleep(1800);
  const fieldCoded = (await lines()).length;
  check('a text field changed from code is checked again', fieldCoded === 3, String(fieldCoded));
  await page.evaluate(() => { const ta = document.getElementById('ta'); ta.value = 'i dont know if they was there, i seen it alot.'; ta.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(800);
  const many = await dotOn(page);
  check('dot: four or more mistakes turn it red', many.color === RED && Number((many.label.match(/\d+/) || [0])[0]) >= 4, JSON.stringify(many));

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
  await rp.close();

  // 11. An empty box, on a fresh page: a grey dot by a textarea, nothing by a one-line field.
  const np = await browser.newPage();
  await np.setViewport({ width: 1000, height: 800 });
  await np.goto(url);
  await np.bringToFront();
  await sleep(500);
  await np.click('#ta');
  await sleep(500);
  const idle = await dotOn(np);
  check('empty box: a grey dot that says to start typing', idle.shown && idle.state === 'empty' && idle.color === GREY && /Start typing/.test(await np.evaluate(() => document.getElementById('sr-live-host').shadowRoot.querySelector('.handle').dataset.tip)), JSON.stringify(idle));
  await np.keyboard.type('All good here.');
  await sleep(800);
  const typed = await dotOn(np);
  check('empty box: typing clean text turns it green', typed.state === 'clean' && typed.color === GREEN, JSON.stringify(typed));
  check('empty box: the dot already sits where the first line goes, so typing doesn\'t move it', Math.abs(typed.top - idle.top) < 2, JSON.stringify({ idle: idle.top, typed: typed.top }));
  await np.evaluate(() => document.getElementById('inp').focus());
  await sleep(500);
  check('empty box: never on a one-line field (search boxes and the like)', (await dotOn(np)).shown === false);
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
