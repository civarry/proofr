// Check as you type: underlines the mistakes Proofr's rules find in the text
// box you're typing in, and a card on hover fixes one with a click. Only the
// rules run here (constants.js, on this computer); nothing is sent anywhere.
// Registered on every page only while the "Check as I type" setting is on.
(() => {
  if (self.SR_LIVE) return;

  const WAIT_MS = 350; // after the last keystroke
  const MAX_CHARS = 20000;
  const FIX_INK = '#D2453B';
  const HINT_INK = '#1D64D8';

  let on = true;
  let school = false;
  let el = null; // the box being checked
  let marks = []; // { hit, rects: [DOMRect-like], kind }
  let timer = 0;
  let cardFor = null;
  let hideTimer = 0;
  let hasText = false;
  const dismissed = new WeakMap(); // el -> Set of "from→to"

  // --- What counts as a text box worth checking ---
  const deepActive = () => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  };
  const isField = (n) => !!n && (n.tagName === 'TEXTAREA' || (n.tagName === 'INPUT' && /^(text|search|)$/i.test(n.type)));
  const isRich = (n) => !!n && n.isContentEditable;
  // spellcheck="false" marks code editors, usernames and the like: left alone.
  const checkable = (n) => (isField(n) || isRich(n)) && n.spellcheck !== false && !n.closest('#sr-live-host, #smart-rewrite-modal, #sr-toast')
    && !n.readOnly && !n.disabled;
  const editorRoot = (n) => {
    let r = n;
    while (r.parentElement && r.parentElement.isContentEditable) r = r.parentElement;
    return r;
  };

  // --- Our own layer, in a shadow root so the page's CSS can't reach it ---
  const host = document.createElement('div');
  host.id = 'sr-live-host';
  host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483646;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host { --card: #FFFFFF; --ink: #23221E; --soft: #5E5B53; --line: #E6E3DC; --accent: #1D64D8; --accent-fg: #FFFFFF; --fix: ${FIX_INK}; --hint: ${HINT_INK}; --ok: #2E9A5B; --idle: #A8A49B; --few: #E3AE0B; --some: #EC7A1C; }
    :host([data-theme="dark"]) { --card: #24231F; --ink: #EDEBE5; --soft: #C2BEB3; --line: #34322C; --accent: #7EA8F8; --accent-fg: #0F1B33; --fix: #F08A7E; --hint: #7EA8F8; --ok: #5CC08A; --idle: #6E6A61; --few: #F2CC4D; --some: #F59E52; }
    .u { position: fixed; height: 2px; border-radius: 999px; pointer-events: none; }
    .u.fix { background: var(--fix); }
    .u.hint { background: var(--hint); }
    .mirror { position: fixed; visibility: hidden; overflow: hidden; pointer-events: none; }
    .card { position: fixed; pointer-events: auto; width: max-content; max-width: 320px; box-sizing: border-box;
      padding: 12px 14px; background: var(--card); color: var(--ink); border: 1px solid var(--line); border-radius: 12px;
      box-shadow: 0 8px 24px rgba(0,0,0,.16); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
    .card[hidden] { display: none; }
    .head { font-size: 12px; font-weight: 600; color: var(--soft); margin-bottom: 4px; }
    .change { font-size: 15px; margin-bottom: 4px; word-break: break-word; }
    .from { color: var(--fix); text-decoration: line-through; }
    .to { font-weight: 650; }
    .why { font-size: 13px; color: var(--soft); margin-bottom: 10px; }
    .row { display: flex; gap: 8px; }
    button { font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; padding: 7px 12px; border-radius: 8px; cursor: pointer; }
    .use { background: var(--accent); color: var(--accent-fg); border: 1px solid transparent; }
    .skip { background: transparent; color: var(--ink); border: 1px solid var(--line); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    /* Beside the box: one dot by the first line, and its color is the news.
       Mistakes to fix: yellow for 1, orange for 2 or 3, red for 4 or more.
       Blue: only School suggestions. Green: nothing found.
       Grey: an empty box. It pulses while a click proofreads the whole box.
       The button is 22px to be easy to hit; the dot inside is 12px. */
    .handle { position: fixed; width: 22px; height: 22px; padding: 0; border: none; border-radius: 50%;
      background: transparent; pointer-events: auto; cursor: pointer; }
    .handle[hidden] { display: none; }
    .handle::after { content: ""; position: absolute; left: 5px; top: 5px; width: 12px; height: 12px; border-radius: 50%;
      background: var(--dot, var(--ok)); box-shadow: 0 1px 2px rgba(0,0,0,.22);
      transition: background-color 200ms ease, transform 120ms cubic-bezier(0, 0, 0, 1), box-shadow 120ms ease; }
    /* Pointed at: it grows a little and gets a ring in its own color, so it reads as a button. */
    .handle:hover::after { transform: scale(1.2); box-shadow: 0 0 0 4px color-mix(in srgb, var(--dot, var(--ok)) 22%, transparent), 0 1px 2px rgba(0,0,0,.22); }
    .handle[data-state="fix"] { --dot: var(--fix); }
    .handle[data-state="fix"][data-level="1"] { --dot: var(--few); }
    .handle[data-state="fix"][data-level="2"] { --dot: var(--some); }
    .handle[data-state="hint"] { --dot: var(--hint); }
    .handle[data-state="clean"] { --dot: var(--ok); }
    .handle[data-state="empty"] { --dot: var(--idle); }
    .handle.working::after { animation: pulse 900ms ease-in-out infinite; }
    /* What the dot means, the moment you point at it (a title shows only after a second). */
    .tip { position: fixed; pointer-events: none; white-space: nowrap; padding: 6px 10px; border-radius: 8px;
      background: var(--ink); color: var(--card); font: 600 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      box-shadow: 0 4px 12px rgba(0,0,0,.18); }
    .tip[hidden] { display: none; }
    .tip.enter { animation: card-in 120ms cubic-bezier(0, 0, 0, 1) both; }

    /* Motion: each one says what just happened, and none under reduced motion.
       Enter 180ms / exit 120ms with the same curves as Proofr's dialog and notes. */
    .u { transform-origin: left center; }
    .u.new { animation: draw-in 180ms cubic-bezier(0, 0, 0, 1) both; }          /* a mistake was found */
    .u.done { background: #2E9A5B; animation: shrink-away 240ms cubic-bezier(0.3, 0, 1, 1) both; transform-origin: center; } /* fixed */
    .u.gone { animation: fade-out 140ms cubic-bezier(0.3, 0, 1, 1) both; }      /* dismissed */
    .wash { position: fixed; border-radius: 4px; background: rgba(46, 154, 91, .28); pointer-events: none; animation: wash 700ms cubic-bezier(0.3, 0, 1, 1) both; }
    .card.enter { animation: card-in 140ms cubic-bezier(0, 0, 0, 1) both; }
    .card.leave { animation: fade-out 120ms cubic-bezier(0.3, 0, 1, 1) both; }
    @keyframes pulse { 50% { opacity: .35; } }
    @keyframes draw-in { from { transform: scaleX(0); } to { transform: scaleX(1); } }
    @keyframes shrink-away { from { transform: scaleX(1); opacity: 1; } to { transform: scaleX(0); opacity: 0; } }
    @keyframes fade-out { to { opacity: 0; } }
    @keyframes wash { 0% { opacity: 0; } 20% { opacity: 1; } 100% { opacity: 0; } }
    @keyframes card-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
    @media (prefers-reduced-motion: reduce) { .handle.working::after { opacity: .45; } } /* no pulse: still shows it's working */
  </style><div class="layer"></div><div class="fx"></div><button type="button" class="handle" hidden data-state="clean"></button><div class="tip" hidden role="tooltip"></div><div class="card" hidden role="dialog" aria-label="Proofr suggestion">
    <div class="head"></div><div class="change"><span class="from"></span> → <span class="to"></span></div>
    <div class="why"></div><div class="row"><button type="button" class="use">Fix it</button><button type="button" class="skip">Dismiss</button></div></div>`;
  const layer = root.querySelector('.layer');
  const handle = root.querySelector('.handle');

  // --- Proofreading the whole box, from a click on the dot ---
  // The dot pulses until the result lands (the text changes or Proofr's note
  // appears), and for at least 700ms so the click is seen to be taken.
  let working = false, workingText = null, workTimer = 0, workStart = 0, empty = false;
  const noteWatch = new MutationObserver(() => { if (document.getElementById('sr-toast')) doneWorking(); });
  function startWorking() {
    working = true;
    workStart = Date.now();
    workingText = lastText;
    clearTimeout(workTimer);
    workTimer = setTimeout(doneWorking, 10000);
    noteWatch.observe(document.documentElement, { childList: true, subtree: true });
    handle.classList.add('working');
  }
  function doneWorking() {
    if (!working) return;
    const wait = 700 - (Date.now() - workStart);
    if (wait > 0) { clearTimeout(workTimer); workTimer = setTimeout(doneWorking, wait); return; }
    working = false;
    clearTimeout(workTimer);
    noteWatch.disconnect();
    handle.classList.remove('working');
  }

  const fx = root.querySelector('.fx');
  const tip = root.querySelector('.tip'); // short-lived motion that outlives a redraw
  let shown = new Set(); // underlines already drawn in this box: only new ones animate
  const restart = (node, cls) => { node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls); };
  const keyOf = (m, nth) => `${m.kind}|${m.hit.from}→${m.hit.to}#${nth}`;
  const card = root.querySelector('.card');
  const attach = () => { if (!host.isConnected) (document.body || document.documentElement).appendChild(host); };
  if (typeof SR_watchTheme === 'function') SR_watchTheme(host, 'data-theme');

  // --- Text, and where each character is on screen ---
  // A rich box's text is its text nodes, with a line break at each block, and
  // a map from text position back to [node, offset].
  const BLOCK = /^(DIV|P|LI|UL|OL|H[1-6]|BLOCKQUOTE|PRE|TR|TABLE|SECTION|ARTICLE)$/;
  function richText(box) {
    let text = '';
    const map = [];
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 1) {
        if ((n.tagName === 'BR' || BLOCK.test(n.tagName)) && text && !text.endsWith('\n')) { text += '\n'; map.push(null); }
        continue;
      }
      for (let i = 0; i < n.data.length; i++) { text += n.data[i]; map.push([n, i]); }
    }
    return { text, map };
  }
  const readText = (box) => (isField(box) ? { text: box.value, map: null } : richText(box));

  function richRange(map, start, end) {
    let a = start, b = end - 1;
    while (a <= b && !map[a]) a++;
    while (b >= a && !map[b]) b--;
    if (a > b) return null;
    const range = document.createRange();
    range.setStart(map[a][0], map[a][1]);
    range.setEnd(map[b][0], map[b][1] + 1);
    return range;
  }

  // A text field draws its own text, so a hidden copy with the same styles is
  // laid out at the same place, and the copy's spans give the rectangles.
  const COPY = ['boxSizing', 'width', 'height', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'borderStyle', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontStyle', 'fontVariant', 'fontWeight',
    'fontStretch', 'fontSize', 'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent', 'letterSpacing',
    'wordSpacing', 'tabSize', 'direction'];
  function fieldRects(box, hits) {
    const cs = getComputedStyle(box);
    const r = box.getBoundingClientRect();
    const mirror = document.createElement('div');
    mirror.className = 'mirror';
    for (const p of COPY) mirror.style[p] = cs[p];
    mirror.style.left = `${r.left}px`;
    mirror.style.top = `${r.top}px`;
    const area = box.tagName === 'TEXTAREA';
    mirror.style.whiteSpace = area ? 'pre-wrap' : 'pre';
    mirror.style.overflowWrap = area ? 'break-word' : 'normal';
    const inner = document.createElement('div'); // scrolled like the field
    inner.style.cssText = `position: relative; top: ${-box.scrollTop}px; left: ${-box.scrollLeft}px;`;
    if (!area) { inner.style.height = '100%'; inner.style.display = 'flex'; inner.style.alignItems = 'center'; }
    const line = document.createElement('span');
    let at = 0;
    const spans = [];
    for (const h of hits) {
      line.append(box.value.slice(at, h.start));
      const s = document.createElement('span');
      s.textContent = box.value.slice(h.start, h.end);
      line.append(s);
      spans.push(s);
      at = h.end;
    }
    line.append(box.value.slice(at) || '​');
    inner.append(line);
    mirror.append(inner);
    root.append(mirror);
    const out = spans.map((s) => [...s.getClientRects()]);
    mirror.remove();
    return out;
  }

  // The part of the box you can see: the box cut down by every container that
  // clips it (an editor often grows inside a smaller scrolling frame) and by
  // the window.
  function viewRect(box) {
    const b = box.getBoundingClientRect();
    let top = Math.max(b.top, 0), bottom = Math.min(b.bottom, innerHeight);
    let left = Math.max(b.left, 0), right = Math.min(b.right, innerWidth);
    for (let n = box.parentElement || box.getRootNode().host; n && n !== document.documentElement; n = n.parentElement || (n.getRootNode() && n.getRootNode().host)) {
      const cs = getComputedStyle(n);
      if (cs.overflowY !== 'visible' || cs.overflowX !== 'visible') {
        const c = n.getBoundingClientRect();
        if (cs.overflowY !== 'visible') { top = Math.max(top, c.top); bottom = Math.min(bottom, c.bottom); }
        if (cs.overflowX !== 'visible') { left = Math.max(left, c.left); right = Math.min(right, c.right); }
      }
      if (cs.position === 'fixed') break;
    }
    return { top, bottom, left, right };
  }
  // A scrolled-away word gets no line.
  const visibleIn = (box) => {
    const b = viewRect(box);
    return (q) => q.right > b.left && q.left < b.right && q.bottom > b.top + 1 && q.top < b.bottom - 1;
  };

  // --- Checking ---
  // Where the cursor is, as a text position (null when unknown).
  function caretAt(map) {
    if (isField(el)) return el.selectionEnd;
    const sel = (el.getRootNode().getSelection ? el.getRootNode() : window).getSelection();
    if (!sel || !sel.rangeCount || sel.focusNode.nodeType !== 3) return null;
    for (let i = 0; i < map.length; i++) {
      if (!map[i] || map[i][0] !== sel.focusNode) continue;
      if (map[i][1] === sel.focusOffset) return i;
      if (map[i][1] === sel.focusOffset - 1) return i + 1;
    }
    return null;
  }

  // typing: checked as each key lands, so the lines stay under their words
  // instead of blinking off; the word being typed waits until you pause.
  function check(typing) {
    if (!typing) clearTimeout(timer);
    if (!on || !el || !el.isConnected) { clear(); return; }
    const { text, map } = readText(el);
    lastText = text;
    if (working && text !== workingText) doneWorking();
    if (!text.trim() && el.tagName !== 'INPUT') { doze(); return; }
    if (!text.trim() || text.length > MAX_CHARS) { clear(); return; }
    hasText = true;
    empty = false;
    const skip = dismissed.get(el) || new Set();
    const fixes = SR_ruleCheck(text, { atStart: true }).filter((h) => !skip.has(`${h.from}→${h.to}`));
    const taken = (h) => fixes.some((f) => h.start < f.end && h.end > f.start);
    const hints = school ? SR_ruleCheck(text, { kind: 'hint' }).filter((h) => !taken(h) && !skip.has(`${h.from}→${h.to}`)) : [];
    let all = [...fixes, ...hints].sort((a, b) => a.start - b.start);
    if (typing) {
      const caret = caretAt(map);
      if (caret != null) all = all.filter((h) => !(h.start <= caret && h.end >= caret));
    }
    const seen = {};
    marks = all.map((hit) => {
      const m = { hit, text, kind: hit.kind === 'hint' ? 'hint' : 'fix', range: map ? richRange(map, hit.start, hit.end) : null };
      const pair = `${m.kind}${hit.from}→${hit.to}`;
      m.key = keyOf(m, seen[pair] = (seen[pair] || 0) + 1);
      return m;
    });
    draw();
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => check(false), WAIT_MS); };
  // An empty box you're in: the face dozes beside its first line until you type.
  function doze() {
    marks = [];
    layer.textContent = '';
    hasText = true;
    empty = true;
    draw();
  }

  function placeHandle() {
    if (!el || !el.isConnected || !hasText) { handle.hidden = true; return; }
    attach();
    const r = el.getBoundingClientRect();
    const { top, bottom } = viewRect(el);
    if (bottom - top < 16 || r.right < 0 || r.left > innerWidth) { handle.hidden = true; return; }
    handle.hidden = false;
    const n = marks.filter((m) => m.kind === 'fix').length;
    const hints = marks.length - n;
    handle.dataset.state = empty ? 'empty' : n ? 'fix' : hints ? 'hint' : 'clean';
    handle.dataset.level = n >= 4 ? '3' : n >= 2 ? '2' : n ? '1' : '0'; // yellow, orange, red
    const what = n ? `${n} mistake${n === 1 ? '' : 's'}` : hints ? `${hints} suggestion${hints === 1 ? '' : 's'}` : '';
    handle.setAttribute('aria-label', empty ? 'Proofr: start typing and mistakes are underlined as you go' : what ? `Proofread this text box: ${what} underlined` : 'Proofread this text box: no mistakes underlined');
    handle.dataset.tip = empty ? 'Start typing. I\'ll check as you go.' : what ? `${what}. Click to fix the whole box.` : 'No mistakes found. Click to proofread the whole box.';
    if (!tip.hidden) showTip();
    // Beside the first line of text (the top of the box when it's empty), kept
    // inside the part of the box you can see. It never grows.
    const cs = getComputedStyle(el);
    const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    const mid = (!empty && firstLineMid()) || r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop) + lineH / 2;
    const y = Math.max(top + 11, Math.min(bottom - 11, mid));
    // Just outside the box's left edge; inside its right edge when there's no room.
    const left = r.left >= 30 ? r.left - 28 : Math.min(r.right + 6, innerWidth - 26);
    handle.style.left = `${left}px`;
    handle.style.top = `${y - 11}px`;
  }
  // The middle of the first line of text on screen. A rich box's own block
  // boxes come back too, so of the rectangles at the top, the shortest is the line.
  function firstLineMid() {
    let rects;
    if (isField(el)) {
      if (!el.value) return null;
      rects = fieldRects(el, [{ start: 0, end: el.value.length }])[0];
    } else {
      const range = document.createRange();
      range.selectNodeContents(el);
      rects = [...range.getClientRects()];
    }
    rects = rects.filter((q) => q.height > 0);
    if (!rects.length) return null;
    const minTop = Math.min(...rects.map((q) => q.top));
    const q = rects.filter((x) => x.top - minTop < 2).reduce((a, b) => (b.height < a.height ? b : a));
    return (q.top + q.bottom) / 2;
  }

  function draw() {
    layer.textContent = '';
    placeHandle();
    if (!el || !marks.length) return;
    attach();
    const shows = visibleIn(el);
    const rects = isField(el) ? fieldRects(el, marks.map((m) => m.hit)) : marks.map((m) => (m.range ? [...m.range.getClientRects()] : []));
    marks.forEach((m, i) => {
      m.rects = rects[i].filter((q) => q.width > 0 && shows(q));
      for (const q of m.rects) {
        const u = document.createElement('div');
        u.className = `u ${m.kind}${shown.has(m.key) ? '' : ' new'}`;
        u.dataset.key = m.key;
        u.style.left = `${q.left}px`;
        u.style.top = `${q.bottom - 1}px`;
        u.style.width = `${q.width}px`;
        layer.append(u);
      }
    });
    shown = new Set(marks.filter((m) => m.rects.length).map((m) => m.key));
  }
  // Lift a mark's lines out of the layer so their exit plays through the redraw.
  function retire(m, cls) {
    for (const u of layer.querySelectorAll('.u')) {
      if (u.dataset.key !== m.key) continue;
      u.classList.remove('new');
      u.classList.add(cls);
      fx.append(u);
      setTimeout(() => u.remove(), 300);
    }
    shown.delete(m.key);
  }
  // A soft green wash over the words just fixed, fading as you look.
  function wash(start, end) {
    if (!el) return;
    const rects = isField(el) ? fieldRects(el, [{ start, end }])[0]
      : (() => { const r = richRange(readText(el).map, start, end); return r ? [...r.getClientRects()] : []; })();
    for (const q of rects) {
      if (!q.width) continue;
      const w = document.createElement('div');
      w.className = 'wash';
      Object.assign(w.style, { left: `${q.left - 2}px`, top: `${q.top}px`, width: `${q.width + 4}px`, height: `${q.height}px` });
      fx.append(w);
      setTimeout(() => w.remove(), 760);
    }
  }

  function clear() {
    marks = [];
    hasText = false;
    layer.textContent = '';
    handle.hidden = true;
    empty = false;
    working = false; // leaving the box: stop at once
    handle.classList.remove('working');
    clearTimeout(workTimer);
    noteWatch.disconnect();
    tip.hidden = true;
    hideCard(true);
  }


  // --- The card ---
  function showCard(m) {
    clearTimeout(hideTimer);
    if (cardFor === m) return;
    cardFor = m;
    const q = m.rects[0];
    card.querySelector('.head').textContent = m.kind === 'hint' ? 'For formal writing' : 'Proofr';
    card.querySelector('.from').textContent = m.hit.from;
    card.querySelector('.to').textContent = m.hit.to;
    card.querySelector('.why').textContent = m.hit.why;
    card.querySelector('.use').textContent = m.kind === 'hint' ? 'Use it' : 'Fix it';
    card.classList.remove('leave');
    const wasHidden = card.hidden;
    card.hidden = false;
    if (wasHidden) restart(card, 'enter');
    const cw = card.offsetWidth, ch = card.offsetHeight;
    const left = Math.max(8, Math.min(q.left, innerWidth - cw - 8));
    const below = q.bottom + 6;
    card.style.left = `${left}px`;
    card.style.top = `${below + ch > innerHeight - 8 ? Math.max(8, q.top - ch - 6) : below}px`;
  }
  function hideCard(now) {
    clearTimeout(hideTimer);
    const go = () => { card.hidden = true; card.classList.remove('leave', 'enter'); cardFor = null; };
    if (now || card.hidden) { go(); return; }
    hideTimer = setTimeout(() => { restart(card, 'leave'); hideTimer = setTimeout(go, 120); }, 250);
  }
  // The pointer is over a word when it's inside the word's box (a little taller
  // than the text, so the line under it counts too).
  const markAt = (x, y) => marks.find((m) => (m.rects || []).some((q) => x >= q.left && x <= q.right && y >= q.top - 2 && y <= q.bottom + 4));
  document.addEventListener('mousemove', (e) => {
    if (!marks.length) return;
    if (e.composedPath().includes(card)) { clearTimeout(hideTimer); return; }
    const m = markAt(e.clientX, e.clientY);
    if (m) showCard(m); else if (cardFor) hideCard(false);
  }, { passive: true, capture: true });

  // Clicking the card must not take focus from the box being edited.
  card.addEventListener('mousedown', (e) => e.preventDefault());
  card.querySelector('.skip').addEventListener('click', () => {
    if (!cardFor || !el) return;
    if (!dismissed.has(el)) dismissed.set(el, new Set());
    dismissed.get(el).add(`${cardFor.hit.from}→${cardFor.hit.to}`);
    retire(cardFor, 'gone');
    hideCard(true);
    check();
  });
  card.querySelector('.use').addEventListener('click', () => { if (cardFor) apply(cardFor); });
  function showTip() {
    tip.textContent = handle.dataset.tip || '';
    const wasHidden = tip.hidden;
    tip.hidden = false;
    const h = handle.getBoundingClientRect();
    const above = h.top - tip.offsetHeight - 6;
    tip.style.left = `${Math.max(8, Math.min(h.left, innerWidth - tip.offsetWidth - 8))}px`;
    tip.style.top = `${above >= 8 ? above : h.bottom + 6}px`;
    if (wasHidden) restart(tip, 'enter');
  }
  handle.addEventListener('mouseenter', showTip);
  handle.addEventListener('mouseleave', () => { tip.hidden = true; });
  handle.addEventListener('mousedown', (e) => e.preventDefault()); // keep the cursor in the box
  handle.addEventListener('click', () => {
    tip.hidden = true;
    if (!el) return;
    el.focus();
    hideCard(true);
    if (empty) return; // nothing to proofread yet
    startWorking();
    try { chrome.runtime.sendMessage({ action: 'liveProofreadBox' }); } catch (_) { doneWorking(); /* extension reloaded */ }
  });

  // Put the fix in through the same path as Proofread (write-back.js), which
  // knows each editor's way in, and only if the text is still what was checked.
  async function apply(m) {
    const box = el;
    hideCard(true);
    if (!box || readText(box).text !== m.text) { check(); return; }
    retire(m, 'done');
    box.focus();
    if (isField(box)) {
      box.setSelectionRange(m.hit.start, m.hit.end);
    } else {
      if (!m.range) return;
      const sel = (box.getRootNode().getSelection ? box.getRootNode() : window).getSelection();
      sel.removeAllRanges();
      sel.addRange(m.range);
    }
    const id = `live-${Date.now()}`;
    const went = self.SR_WB && self.SR_WB.capture(id, m.hit.from) ? await self.SR_WB.insert(id, m.hit.to) : null;
    check();
    if (went && el === box) wash(m.hit.start, m.hit.start + m.hit.to.length);
  }

  // --- Following the box you're in ---
  // A change can arrive without an "input" event: an editor with its own model
  // (Lexical, Slate, Draft) puts pasted text in itself, a site sets a field's
  // value from code, and Proofread's own result goes in as a paste. So a rich
  // box is watched for any change to its text, and a field's value is compared
  // once a second while you're in it. Without this the count beside the box
  // went stale after the box was fixed.
  let lastText = null;
  const watcher = new MutationObserver(() => { if (el && readText(el).text !== lastText) changed(); });
  let poll = 0;
  function changed() {
    hideCard(true);
    if (readLength(el) <= 5000) { cancelAnimationFrame(typingFrame); typingFrame = requestAnimationFrame(() => check(true)); } else { layer.textContent = ''; placeHandle(); }
    schedule();
  }
  function follow(target) {
    const box = target && checkable(target) ? (isRich(target) ? editorRoot(target) : target) : null;
    if (box === el) return;
    el = box;
    clear();
    shown = new Set();
    lastText = null;
    watcher.disconnect();
    clearInterval(poll);
    if (!el) return;
    if (isRich(el)) watcher.observe(el, { childList: true, characterData: true, subtree: true });
    else poll = setInterval(() => { if (el && el.isConnected && el.value !== lastText) changed(); }, 1000);
    schedule();
  }
  document.addEventListener('focusin', () => follow(deepActive()), true);
  document.addEventListener('focusout', () => setTimeout(() => {
    const now = deepActive();
    if (!now || !el || (now !== el && !el.contains(now))) follow(now);
  }, 0), true);
  document.addEventListener('input', (e) => {
    const t = e.composedPath()[0];
    if (!el || !(t === el || (el.contains && el.contains(t)))) return;
    // Each key: the lines follow the text at once (a long box waits for the pause).
    changed();
  }, true);
  let typingFrame = 0;
  function readLength(box) { return isField(box) ? box.value.length : (box.textContent || '').length; }
  // Moving the page or the box moves the words: redraw where they are now.
  let frame = 0;
  const redraw = () => {
    if (!el || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      hideCard(true);
      draw();
    });
  };
  addEventListener('scroll', redraw, { capture: true, passive: true });
  addEventListener('resize', redraw, { passive: true });

  // --- Settings ---
  const settings = (s) => {
    if ('srLiveCheck' in s) on = s.srLiveCheck !== false;
    if ('srSchool' in s) school = s.srSchool === true;
  };
  try {
    chrome.storage.sync.get(['srLiveCheck', 'srSchool']).then((s) => { settings(s); follow(deepActive()); });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      const s = {};
      for (const k of ['srLiveCheck', 'srSchool']) if (changes[k]) s[k] = changes[k].newValue;
      if (Object.keys(s).length) { settings(s); if (on) check(); else clear(); }
    });
  } catch (_) { /* extension reloaded: this copy stays quiet */ }

  // For tests: what's underlined now, and where.
  self.SR_LIVE = {
    marks: () => marks.map((m) => ({ from: m.hit.from, to: m.hit.to, kind: m.kind, id: m.hit.id, rects: (m.rects || []).map((q) => ({ left: Math.round(q.left), top: Math.round(q.top), right: Math.round(q.right), bottom: Math.round(q.bottom) })) })),
    card: () => (card.hidden ? null : { from: card.querySelector('.from').textContent, to: card.querySelector('.to').textContent, why: card.querySelector('.why').textContent, head: card.querySelector('.head').textContent }),
    root,
    checkNow: check,
  };
})();