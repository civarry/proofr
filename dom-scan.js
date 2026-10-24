// dom-scan.js — shared "find a sensible text block" logic.
// Used by hover-assist.js to find the block under the cursor. Loaded only on
// pages where hover actions are on (registered by background.js), before
// hover-assist.js.
(function () {
  if (typeof self === 'undefined' || self.SR_DOM) return;

  const BLOCK_TAGS = new Set([
    'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'BLOCKQUOTE', 'TD', 'TH', 'DD', 'DT', 'FIGCAPTION', 'SUMMARY',
  ]);
  const LEAF_CANDIDATE_TAGS = new Set(['DIV', 'SPAN', 'ARTICLE', 'SECTION']);
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'BUTTON',
    'SVG', 'CANVAS', 'IFRAME', 'VIDEO', 'AUDIO', 'CODE', 'PRE',
  ]);
  const UNSAFE_TO_REPLACE_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'IMG', 'SVG', 'IFRAME', 'VIDEO', 'AUDIO']);
  const OWN_UI_SELECTOR = '#smart-rewrite-modal, .sr-hover-icon, .sr-hover-popover, .sr-loading-toast, .sr-success-notification';
  const MIN_TEXT_LENGTH = 12; // skip nav crumbs, single words, icon labels

  function isOwnUI(el) {
    return !!(el.closest && el.closest(OWN_UI_SELECTOR));
  }

  // What an element's subtree looks like (its own text, whether it holds a
  // block, whether it's safe to overwrite) only changes when the page does,
  // so each is worked out once per element and kept until the next change.
  // A MutationObserver bumps `gen` on any change to the page's structure or
  // text, except Proofr's own icon, popover and dialog coming and going.
  let gen = 0;
  let observer = null;
  const memo = new WeakMap(); // el -> { gen, ...values }
  function cached(el, key, compute) {
    let entry = memo.get(el);
    if (!entry || entry.gen !== gen) { entry = { gen }; memo.set(el, entry); }
    if (!(key in entry)) entry[key] = compute();
    return entry[key];
  }
  const ownNode = (n) => n.nodeType === Node.ELEMENT_NODE && isOwnUI(n);
  function watchPage() {
    if (observer || typeof MutationObserver === 'undefined' || !document.documentElement) return;
    observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'childList' && (ownNode(r.target) || ([...r.addedNodes, ...r.removedNodes].length && [...r.addedNodes, ...r.removedNodes].every(ownNode)))) continue;
        if (r.type === 'characterData' && r.target.parentElement && isOwnUI(r.target.parentElement)) continue;
        gen++;
        return;
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  function isEditableContext(el) {
    return !!(el.closest && el.closest('input, textarea, [contenteditable="true"], [contenteditable=""]'));
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function hasBlockDescendant(el) {
    return cached(el, 'hbd', () => scanForBlock(el));
  }
  function scanForBlock(el) {
    for (const child of el.children) {
      if (BLOCK_TAGS.has(child.tagName) || LEAF_CANDIDATE_TAGS.has(child.tagName)) {
        // A candidate child only "counts" as a block descendant if it itself has
        // meaningful direct text or further block descendants — otherwise keep
        // looking past pure layout wrappers.
        if (directText(child).trim().length >= MIN_TEXT_LENGTH || hasBlockDescendant(child)) return true;
      } else if (hasBlockDescendant(child)) {
        return true;
      }
    }
    return false;
  }

  // Text that belongs directly to this element — its own text nodes plus inline
  // formatting children (b/i/a/span-without-block-content) — not text pulled up
  // from nested block-level children (those get their own entry). <br> becomes
  // "\n": many email templates put a whole message in one container and use
  // <br><br> for paragraph spacing instead of separate block elements, so
  // without this the extracted text silently loses all paragraph structure
  // before the AI ever sees it.
  function directText(el) {
    return cached(el, 'direct', () => readDirectText(el));
  }
  function readDirectText(el) {
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName === 'BR') { text += '\n'; continue; }
        if (!BLOCK_TAGS.has(node.tagName) && !SKIP_TAGS.has(node.tagName)) {
          text += node.textContent;
        }
      }
    }
    return text;
  }

  // The inverse of the <br> handling above: turns "\n"-separated text back
  // into a DOM fragment with real <br> elements, so writing an AI response
  // back into the page actually renders line breaks — plain text with "\n"
  // in it is collapsed to a single line by normal HTML whitespace rules.
  function textToFragment(text) {
    const frag = document.createDocumentFragment();
    const lines = String(text ?? '').split('\n');
    lines.forEach((line, i) => {
      if (i > 0) frag.appendChild(document.createElement('br'));
      frag.appendChild(document.createTextNode(line));
    });
    return frag;
  }

  // True when el's subtree is text + inline formatting only — no interactive or
  // media elements — so it's safe to overwrite wholesale via textContent.
  function isSimpleBlock(el) {
    return cached(el, 'simple', () => scanSimple(el));
  }
  function scanSimple(el) {
    const descendants = el.querySelectorAll('*');
    for (const child of descendants) {
      if (UNSAFE_TO_REPLACE_TAGS.has(child.tagName)) return false;
    }
    return true;
  }

  function toBlock(el) {
    const text = directText(el).trim();
    if (text.length < MIN_TEXT_LENGTH) return null;
    if (!isVisible(el)) return null;
    return { el, text, simple: isSimpleBlock(el) };
  }

  function isEligibleContainer(el) {
    return !!el && el.nodeType === Node.ELEMENT_NODE
      && (BLOCK_TAGS.has(el.tagName) || LEAF_CANDIDATE_TAGS.has(el.tagName))
      && !SKIP_TAGS.has(el.tagName)
      && !isOwnUI(el)
      && !isEditableContext(el)
      && !hasBlockDescendant(el);
  }

  const MAX_MERGE_SIBLINGS = 40;
  const MAX_MERGE_CHARS = 6000;

  // Email clients (Gmail especially) commonly wrap each LINE of a message in
  // its own sibling <div> rather than one block with wrapped lines — so the
  // nearest eligible container is just one line, and an instruction like
  // "summarize this" only ever sees a sentence fragment. If every sibling
  // under the parent is itself a simple, short leaf (the "flat list of
  // lines" shape), treat the whole parent as one logical block instead.
  // Bailing out on anything else (an image, a button, too many/too much
  // text) keeps this from over-merging a genuinely mixed container.
  function expandToParentIfFlatList(block) {
    const parent = block.el.parentElement;
    if (!parent || parent === document.body) return block;

    const children = Array.from(parent.children);
    if (children.length < 2 || children.length > MAX_MERGE_SIBLINGS) return block;

    const allSimpleLeaves = children.every((c) =>
      !SKIP_TAGS.has(c.tagName) && !hasBlockDescendant(c) && isSimpleBlock(c)
    );
    if (!allSimpleLeaves) return block;

    const combinedText = children.map((c) => directText(c).trim()).filter(Boolean).join('\n');
    if (!combinedText || combinedText.length <= block.text.length || combinedText.length > MAX_MERGE_CHARS) return block;

    // Merged blocks span multiple original elements, so a plain textContent
    // write to el isn't safe (el is the shared parent, which may hold more
    // than just these children). rangeEls carries exactly which elements
    // were merged — already confirmed simple above — so a caller that wants
    // to write a result back in place can replace them individually instead
    // of guessing at el's own safety.
    return { el: parent, text: combinedText, simple: false, rangeEls: children };
  }

  // Given a hovered node, resolve the nearest eligible block ancestor. The
  // answer for a start element is kept until the page changes; visibility is
  // checked again each time (a class change can hide a block without a
  // structural change).
  function resolveBlock(node) {
    watchPage();
    const start = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!start) return null;
    const block = cached(start, 'block', () => findBlock(start));
    return block && isVisible(block.el) ? block : (block ? findBlock(start) : null);
  }
  function findBlock(start) {
    let el = start;
    while (el && el !== document.documentElement) {
      if (SKIP_TAGS.has(el.tagName) || isOwnUI(el) || isEditableContext(el)) return null;
      if (isEligibleContainer(el)) {
        const block = toBlock(el);
        if (block) return expandToParentIfFlatList(block);
      }
      el = el.parentElement;
    }
    return null;
  }

  // The larger run of text a paragraph belongs to: a post's whole message, a
  // comment, an article body. Sites split these into one element per
  // paragraph (Facebook nests each in its own <div>), so a hovered paragraph
  // is often a title or one line of a longer piece. Climbs from the block
  // and keeps the highest ancestor that is still only text: it stops before
  // anything that isn't (a photo or avatar, a field, a real button, an
  // embed), at an article/main boundary, or past MAX_REGION_CHARS. Inline
  // links, emoji images and a short "See more" are text-sized and allowed.
  // Runs on a click, not on hover, so reading layout here is fine.
  const MAX_REGION_CHARS = 12000;
  const MAX_REGION_DEPTH = 12;
  // Returns true when el holds something that isn't text. Collects the text
  // of allowed controls ("See more") into `skip`, so it isn't sent or counted.
  function blocksText(el, skip) {
    for (const node of el.querySelectorAll('img, video, canvas, svg, iframe, embed, object, input, textarea, select, button, [role="button"], [role="img"], [contenteditable="true"], [contenteditable=""]')) {
      if (isOwnUI(node)) continue;
      const tag = node.tagName;
      if (tag === 'IMG' || tag === 'SVG' || node.getAttribute('role') === 'img') {
        const r = node.getBoundingClientRect();
        if (r.width <= 32 && r.height <= 32) continue; // an emoji or an inline icon
        return true;
      }
      if (tag === 'BUTTON' || node.getAttribute('role') === 'button') {
        // "See more" inside a post's text; a real control has more to it.
        if ((node.innerText || '').trim().length <= 20 && !node.querySelector('img, svg, video')) {
          const label = (node.innerText || '').trim();
          if (!label || /^(see|show|read) (more|less)|^…|^\.\.\./i.test(label)) { if (label) skip.add(label); continue; }
        }
        return true;
      }
      return true;
    }
    return false;
  }
  const paragraphsIn = (text) => text.split(/\n+/).filter((l) => l.trim().length > 0).length;
  function regionFor(block) {
    if (!block || !block.el) return null;
    let best = null;
    let el = block.el.parentElement;
    for (let depth = 0; el && depth < MAX_REGION_DEPTH; depth++, el = el.parentElement) {
      if (el === document.body || el === document.documentElement) break;
      if (isOwnUI(el) || isEditableContext(el) || SKIP_TAGS.has(el.tagName)) break;
      const skip = new Set();
      if (blocksText(el, skip)) break;
      const text = (el.innerText || '').split('\n').filter((line) => !skip.has(line.trim())).join('\n').trim();
      if (text.length > MAX_REGION_CHARS) break;
      const paragraphs = paragraphsIn(text);
      if (paragraphs >= 2 && text.length > block.text.length * 1.2) best = { el, text, paragraphs, simple: false };
      if (el.matches('article, [role="article"], main, [role="main"]')) break;
    }
    return best;
  }

  // invalidate(): forget everything, as after a page change (for tests).
  self.SR_DOM = { resolveBlock, regionFor, isSimpleBlock, isVisible, textToFragment, invalidate: () => { gen++; } };
})();
