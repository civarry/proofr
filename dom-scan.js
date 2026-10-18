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

  // Given a hovered node, resolve the nearest eligible block ancestor.
  function resolveBlock(node) {
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
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

  self.SR_DOM = { resolveBlock, isSimpleBlock, isVisible, textToFragment };
})();
