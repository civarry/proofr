// Puts a result back into the text box it came from. Runs in the frame that
// holds the box (injected on demand), with no UI of its own: Proofr's dialog
// and notes stay in the top page, because a rich editor's frame often has an
// editable <body> that would save them as part of the document.
(() => {
  if (self.SR_WB) return;

  // Whitespace is ignored when comparing text: a selection crossing paragraphs
  // reads with line breaks, with spaces, or (Range.toString) with nothing.
  const squash = (s) => String(s || '').replace(/\s+/g, '');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const isField = (el) => !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');
  const isRich = (el) => !!el && (el.isContentEditable || el.ownerDocument.designMode === 'on');

  // document.activeElement stops at a web component; the box may be inside it.
  const deepActive = () => {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  };
  // In Chrome only the shadow root's own getSelection sees inside a web component.
  const selectionFor = (el) => {
    const root = el.getRootNode();
    return root.getSelection ? root.getSelection() : window.getSelection();
  };

  const targets = new Map();
  const remember = (id, target) => {
    targets.set(id, target);
    if (targets.size > 8) targets.delete(targets.keys().next().value); // a dialog's Replace can outlive its request
  };

  // A framework may have redrawn the box while the answer was on its way, or the
  // user typed above the selection. If the text is still there exactly once,
  // that's the place. Twice is ambiguous: never guess.
  const refindInField = (t) => {
    const words = t.original.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const found = [...t.el.value.matchAll(new RegExp(words.join('\\s+'), 'g'))];
    if (found.length !== 1) return false;
    t.start = found[0].index;
    t.end = t.start + found[0][0].length;
    return true;
  };
  const refindInEditor = (t) => {
    const map = []; // one entry per non-space character: where it lives
    const walker = document.createTreeWalker(t.el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      for (let i = 0; i < n.data.length; i++) if (!/\s/.test(n.data[i])) map.push([n, i]);
    }
    const haystack = map.map(([n, i]) => n.data[i]).join('');
    const needle = squash(t.original);
    const at = needle ? haystack.indexOf(needle) : -1;
    if (at < 0 || haystack.indexOf(needle, at + 1) >= 0) return false;
    const range = document.createRange();
    range.setStart(map[at][0], map[at][1]);
    const last = map[at + needle.length - 1];
    range.setEnd(last[0], last[1] + 1);
    t.range = range;
    return true;
  };
  const locate = (t) => {
    if (!t.el.isConnected) return false;
    if (t.kind === 'field') {
      return squash(t.el.value.slice(t.start, t.end)) === squash(t.original) || refindInField(t);
    }
    const intact = t.range.startContainer.isConnected && t.el.contains(t.range.commonAncestorContainer)
      && squash(t.range.toString()) === squash(t.original);
    return intact || refindInEditor(t);
  };
  const selectTarget = (t) => {
    t.el.focus();
    if (t.kind === 'field') { t.el.setSelectionRange(t.start, t.end); return; }
    const sel = selectionFor(t.el);
    sel.removeAllRanges();
    sel.addRange(t.range);
  };
  // Did the box take it? Judged from the page after the editor had time to act,
  // since an editor with its own model may redraw late, or undo a change it
  // didn't make. Counted, not just looked for: the old text may also appear
  // elsewhere in the box, and text pasted in the wrong place must not pass.
  const count = (haystack, needle) => (needle ? haystack.split(needle).length - 1 : 0);
  const changed = (el, before, from, to) => {
    const now = squash(el.innerText);
    const [was, will] = [squash(from), squash(to)];
    return will.includes(was)
      ? count(now, will) > count(before, will)
      : count(now, was) < count(before, was);
  };
  // Editors with their own model (Lexical, Slate, ProseMirror, Quill, TinyMCE,
  // CKEditor) ignore or mangle insertText: Slate shows it but sends the old text,
  // Lexical loses the line breaks. All of them take a paste, and cancel the event
  // to say so. A plain contenteditable cancels nothing, and a dispatched paste
  // has no effect of its own there, so insertText comes last.
  const pasteEvent = (type, Kind, init) => (t) => {
    const anchor = selectionFor(t.el).anchorNode;
    const node = anchor && anchor.nodeType === 1 ? anchor : (anchor && anchor.parentElement) || t.el;
    const event = new Kind(type, { bubbles: true, cancelable: true, composed: true, ...init });
    node.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const withData = (text) => { const d = new DataTransfer(); d.setData('text/plain', text); return d; };
  const WAYS_IN = [
    (t, text) => pasteEvent('paste', ClipboardEvent, { clipboardData: withData(text) })(t),
    (t, text) => pasteEvent('beforeinput', InputEvent, { inputType: 'insertFromPaste', dataTransfer: withData(text) })(t),
    (t, text) => document.execCommand('insertText', false, text),
  ];
  // Text box with no selection: only plain lines may be overwritten. A link, a
  // list or a quoted email in it would come back as plain text.
  const PLAIN_TAGS = new Set(['DIV', 'P', 'BR', 'SPAN']);

  const insertField = (t, text) => {
    selectTarget(t);
    if (document.execCommand('insertText', false, text) && t.el.value.slice(t.start, t.start + text.length) === text) return 'undoable';
    t.el.setRangeText(text, t.start, t.end, 'end');
    t.el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'replaced';
  };
  const insertEditor = async (t, text) => {
    const before = squash(t.el.innerText);
    // A fix of spacing alone has the same letters, so the count can't tell.
    const sameLetters = squash(text) === squash(t.original);
    const took = () => sameLetters || changed(t.el, before, t.original, text);
    for (const [i, way] of WAYS_IN.entries()) {
      if (!locate(t)) return null;
      selectTarget(t);
      await wait(60); // an editor with its own model reads the new selection a moment later
      const accepted = way(t, text);
      await wait(accepted ? 80 : 30);
      // An editor may cancel an event and do nothing with it: on to the next way.
      if (accepted ? took() : (!sameLetters && took())) {
        t.how = i === WAYS_IN.length - 1 ? 'undoable' : 'pasted';
        return t.how;
      }
    }
    return null;
  };
  // Back to the original. The browser's undo only knows what insertText did, and
  // can leave an editor with its own history half undone, so the result decides.
  const undoEditor = async (t, rewritten) => {
    const raw = t.el.innerText;
    const before = squash(raw);
    const sameLetters = squash(rewritten) === squash(t.original);
    if (t.how === 'undoable') {
      t.el.focus();
      document.execCommand('undo');
      if (sameLetters ? t.el.innerText !== raw : changed(t.el, before, rewritten, t.original)) return true;
    }
    const back = { kind: 'editable', el: t.el, range: t.range, original: rewritten };
    if (!locate(back)) return false;
    return !!(await insertEditor(back, t.original));
  };

  self.SR_WB = {
    // Remember exactly where the selection is now, not when the result arrives:
    // the user may click elsewhere during a slow rewrite. Null means page text.
    capture(id, original) {
      const el = deepActive();
      if (isField(el) && typeof el.selectionStart === 'number' && el.selectionStart !== el.selectionEnd) {
        remember(id, { kind: 'field', el, start: el.selectionStart, end: el.selectionEnd, original });
        return 'field';
      }
      if (!isRich(el)) return null;
      const sel = selectionFor(el);
      if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
      remember(id, { kind: 'editable', el, range: sel.getRangeAt(0).cloneRange(), original });
      return 'editable';
    },

    // "Proofread this text box": selects it whole when overwriting it is safe.
    selectWhole() {
      const el = deepActive();
      if (isField(el)) {
        el.select();
        return { text: el.value, plain: true };
      }
      if (!isRich(el)) return { text: '', plain: false };
      const text = el.innerText;
      if (![...el.querySelectorAll('*')].every((n) => PLAIN_TAGS.has(n.tagName))) return { text, plain: false };
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = selectionFor(el);
      sel.removeAllRanges();
      sel.addRange(range);
      return { text, plain: true };
    },

    // Only if the captured text is still there. How it went in, or null.
    async insert(id, text) {
      const t = targets.get(id);
      if (!t || !locate(t)) return null;
      return t.kind === 'field' ? insertField(t, text) : insertEditor(t, text);
    },

    // The user went to another box in this frame while the rewrite ran.
    movedOn(id) {
      const t = targets.get(id);
      if (!t) return false;
      const active = deepActive();
      return !!active && active !== document.body && active !== t.el && !t.el.contains(active)
        && !(active.closest && active.closest('#smart-rewrite-modal, #sr-toast'));
    },

    // Put the original back.
    async undo(id, rewritten) {
      const t = targets.get(id);
      if (!t || !t.el.isConnected) return false;
      if (t.kind === 'field') {
        if (t.el.value.slice(t.start, t.start + rewritten.length) !== rewritten) return false;
        t.el.focus();
        t.el.setSelectionRange(t.start, t.start + rewritten.length);
        if (!document.execCommand('insertText', false, t.original)) {
          t.el.setRangeText(t.original, t.start, t.start + rewritten.length, 'end');
          t.el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
      }
      return undoEditor(t, rewritten);
    },

    // Review after an in-place fix: the changes the user kept replace the result.
    async applyAccepted(id, rewritten, accepted) {
      const t = targets.get(id);
      if (!t || !t.el.isConnected) return false;
      if (t.kind === 'field') {
        if (t.el.value.slice(t.start, t.start + rewritten.length) !== rewritten) return false;
        t.el.focus();
        t.el.setSelectionRange(t.start, t.start + rewritten.length);
        if (!document.execCommand('insertText', false, accepted)) {
          t.el.setRangeText(accepted, t.start, t.start + rewritten.length, 'end');
          t.el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
      }
      return (await self.SR_WB.undo(id, rewritten)) && !!(await self.SR_WB.insert(id, accepted));
    },
  };
})();
