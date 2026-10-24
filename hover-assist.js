// hover-assist.js — hover any block of text on a page to get a one-click
// Proofr reading action (summarize, simplify, translate), without selecting
// it first. Off by default: nothing is bound until the user turns on
// "Hover actions" in the side panel (srHoverAssist). Results open in the
// modal; the page's own DOM is never rewritten, since dom-scan.js only ever
// resolves read-only text (editable fields are skipped).
(function () {
  if (window.__srHoverAssistLoaded) return;
  window.__srHoverAssistLoaded = true;

  // How long the pointer stays on an element before its icon shows. Counted
  // from entering the element, not from the last mouse move, so the icon
  // appears while the pointer is still moving; long enough that a fast sweep
  // across a page doesn't flash an icon on every line it crosses.
  const DWELL_MS = 70;
  // Built for text that isn't yours (someone else's comment, an article
  // paragraph). Writing tones live in the right-click menu and side panel.
  // Quotes too, so a label can never close an attribute.
  function escapeHtml(s) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(s ?? '').replace(/[&<>"']/g, (c) => map[c]);
  }

  const READING_TONES = ['tldr', 'simple', 'translate'];
  const ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 14-7-7 14-2-5-5-2Z"/></svg>';

  const REMOVE_GRACE_MS = 400;

  // After Proofr is reloaded or updated, a tab that was already open keeps
  // this old copy, which can no longer reach the extension (Chrome throws
  // "Extension context invalidated"). It then stops offering the icon and,
  // if clicked, says to reload the page, where the new copy runs.
  const STALE_MESSAGE = 'Proofr was updated or reloaded. Reload this page to use it here.';
  function contextAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }
  function syncGet(keys) {
    return new Promise((resolve) => {
      try { chrome.storage.sync.get(keys, (r) => resolve((!chrome.runtime.lastError && r) || {})); } catch (_) { resolve({}); }
    });
  }

  let dwellTimer = null;
  let dwellTarget = null; // the element the running timer is for
  let removeTimer = null;
  let icon = null;
  let popover = null;
  let activeBlock = null; // { el, text, simple }
  let capturedSelection = null; // { text } — a manual selection made before clicking the icon
  let region = null; // the larger text the hovered paragraph belongs to (SR_DOM.regionFor), when there is one
  let useRegion = false; // the menu's scope: this paragraph, or all of the region
  let preferRegion = false; // the last scope picked, used again next time
  let busy = false;
  let enabled = false;
  let paused = false; // the pause shortcut (srHoverPaused), on every tab at once

  // A brief grace period before actually tearing the icon down when the
  // mouse briefly crosses a gap (margin/padding with no text under it) on
  // its way toward the icon — the icon sits just outside the block's own
  // edge, so that path often passes through a pixel or two of "nothing."
  function scheduleRemove() {
    if (removeTimer) return;
    removeTimer = setTimeout(() => {
      removeTimer = null;
      removeIcon();
    }, REMOVE_GRACE_MS);
  }
  function cancelScheduledRemove() {
    if (removeTimer) { clearTimeout(removeTimer); removeTimer = null; }
  }

  // A manual selection, if one exists when the icon is clicked, takes
  // priority over the auto-detected block — it's a deliberate, precise
  // signal ("act on exactly this") that should win over the passive
  // hover-detected block, which is only a best guess.
  function captureSelection() {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      const text = sel.toString().trim();
      if (text.length > 0) return { text };
    }
    return null;
  }

  function clearDwell() {
    if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; }
  }

  // The outline marks exactly the text an action will use.
  function markScope() {
    document.querySelectorAll('.sr-hover-target').forEach((n) => n.classList.remove('sr-hover-target'));
    const el = useRegion && region ? region.el : activeBlock && activeBlock.el;
    if (el) el.classList.add('sr-hover-target');
  }
  function scopeText(block) {
    if (capturedSelection) return capturedSelection.text;
    return useRegion && region ? region.text : block.text;
  }

  function removeIcon() {
    cancelScheduledRemove();
    document.querySelectorAll('.sr-hover-target').forEach((n) => n.classList.remove('sr-hover-target'));
    region = null;
    useRegion = false;
    if (icon) { icon.remove(); icon = null; }
    activeBlock = null;
    capturedSelection = null;
  }

  function removePopover() {
    if (popover) { popover.remove(); popover = null; }
    // Closing the menu without acting puts the outline back on the paragraph.
    if (!busy && useRegion) { useRegion = false; markScope(); }
  }

  function standDown() { enabled = false; clearDwell(); removePopover(); removeIcon(); }
  function staleClick() { standDown(); showFeedback('error', STALE_MESSAGE, { title: 'Reload this page' }); }

  function positionNear(node, rect, opts) {
    opts = opts || {};
    const top = opts.below ? rect.bottom + 6 : rect.top - 6;
    const left = opts.below ? rect.left : rect.right - 6;
    node.style.top = `${window.scrollY + top}px`;
    node.style.left = `${window.scrollX + left}px`;
  }

  function showIcon(block) {
    cancelScheduledRemove();
    if (activeBlock && activeBlock.el === block.el && icon) return;
    removePopover();
    removeIcon();
    activeBlock = block;
    block.el.classList.add('sr-hover-target');
    icon = document.createElement('button');
    icon.type = 'button';
    icon.className = 'sr-hover-icon';
    icon.setAttribute('aria-label', 'Proofr actions');
    icon.innerHTML = (typeof SR_LOGO_SVG !== 'undefined') ? SR_LOGO_SVG : '✎';
    positionNear(icon, block.el.getBoundingClientRect());
    // preventDefault (not just stopPropagation) — a mousedown on a button
    // normally collapses any active text selection before the click even
    // fires. Without this, selecting text then clicking the icon always
    // cleared the selection before we ever got to read it.
    icon.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    icon.addEventListener('click', (e) => { e.stopPropagation(); togglePopover(); });
    document.body.appendChild(icon);
  }

  async function togglePopover() {
    if (popover) { removePopover(); return; }
    if (!activeBlock || !icon) return;
    if (!contextAlive()) { staleClick(); return; }

    // Capture now, before building/opening the popover — a real selection
    // made before clicking the icon is the strongest signal of intent.
    capturedSelection = captureSelection();

    const { srTargetLang } = await syncGet(['srTargetLang']);
    const targetLang = srTargetLang || 'en';
    const targetLangName = (typeof SR_fullLangName === 'function') ? SR_fullLangName(targetLang) : targetLang;
    // "Translate → English" on a page that's already English is a no-op.
    const pageLang = (document.documentElement.lang || '').toLowerCase().split('-')[0];
    const tones = READING_TONES.filter((id) => !(id === 'translate' && pageLang && pageLang === targetLang.split('-')[0]));
    // The Ask box appears whenever some AI can answer: on-device or a provider.
    const { ready: canAsk } = await sendMessageWithTimeout({ action: 'askReady' }, 3000);
    if (!activeBlock || !icon) return;

    // A selection is exact; otherwise offer the whole post or article too.
    region = !capturedSelection && typeof SR_DOM !== 'undefined' && SR_DOM.regionFor ? SR_DOM.regionFor(activeBlock) : null;
    useRegion = !!region && preferRegion;
    markScope();

    popover = document.createElement('div');
    popover.className = 'sr-hover-popover';
    const scopeRow = region ? `<div class="sr-hover-scope" role="group" aria-label="Use">
        <button type="button" class="sr-hover-scope-btn" data-scope="block" aria-pressed="${!useRegion}">This paragraph</button>
        <button type="button" class="sr-hover-scope-btn" data-scope="region" aria-pressed="${useRegion}">All ${region.paragraphs} paragraphs</button>
      </div>` : '';
    popover.innerHTML = scopeRow + tones.map((id) => {
      const tone = (typeof SR_getTone === 'function') ? SR_getTone(id) : { name: id };
      const label = id === 'translate' ? `Translate → ${targetLangName}` : tone.name;
      return `<button type="button" class="sr-hover-action" data-tone="${escapeHtml(id)}">${escapeHtml(label)}</button>`;
    }).join('')
      + (canAsk ? `<div class="sr-hover-divider"></div>
        <form class="sr-hover-ask" id="srHoverAskForm">
          <input type="text" class="sr-hover-ask-input" id="srHoverAskInput" placeholder="Ask about this…" aria-label="Ask about this text" />
          <button type="submit" class="sr-hover-ask-send" aria-label="Ask" title="Ask">${ICON_SEND}</button>
        </form>` : '');
    positionNear(popover, icon.getBoundingClientRect(), { below: true });

    popover.querySelectorAll('.sr-hover-scope-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        useRegion = btn.dataset.scope === 'region';
        preferRegion = useRegion;
        try { chrome.storage.local.set({ srHoverScope: useRegion ? 'region' : 'block' }); } catch (_) { /* Proofr was reloaded */ }
        popover.querySelectorAll('.sr-hover-scope-btn').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
        markScope();
      });
    });

    popover.querySelectorAll('.sr-hover-action').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tone = btn.dataset.tone;
        runHoverAction(tone);
      });
    });

    const askForm = popover.querySelector('#srHoverAskForm');
    if (askForm) {
      askForm.addEventListener('submit', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const instruction = popover.querySelector('#srHoverAskInput').value.trim();
        if (instruction) runHoverAsk(instruction);
      });
    }

    document.body.appendChild(popover);
  }

  // Never fail silently: if the page-injected modal genuinely isn't available
  // (rare, but not impossible on a heavily-scripted page like Gmail), fall
  // back to something the user can still see, mirroring the fallback the
  // context-menu flow already has in background.js's showErrorMessage.
  function showFeedback(kind, ...args) {
    if (window.SmartRewriteModal) {
      if (kind === 'error') window.SmartRewriteModal.showError(...args);
      else if (kind === 'result') window.SmartRewriteModal.showResult(...args);
      return;
    }
    if (kind === 'error') {
      alert('Proofr: ' + args[0]);
    } else if (kind === 'result') {
      const text = args[1];
      navigator.clipboard.writeText(text).then(
        () => alert('Proofr result (copied to clipboard):\n\n' + text),
        () => alert('Proofr result:\n\n' + text)
      );
    }
  }

  // chrome.runtime.sendMessage's callback can simply never fire if the
  // background service worker dies or goes idle mid-request (a known MV3
  // gotcha) — with no error and no response, the UI would otherwise sit in
  // the "busy" pulse state forever with zero feedback. This wraps it in a
  // hard timeout so that failure mode always resolves to a visible error.
  // Longer than the worst legitimate background path (on-device attempt up to
  // 45s, then cloud fallback up to ~32s), so the background's specific error
  // always arrives before this generic one.
  const HOVER_TIMEOUT_MS = 90000;
  function sendMessageWithTimeout(message, timeoutMs) {
    timeoutMs = timeoutMs || HOVER_TIMEOUT_MS;
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ error: 'timeout', message: 'Timed out waiting for a response. Try again.' });
      }, timeoutMs);

      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            resolve({ error: 'runtime', message: chrome.runtime.lastError.message || 'Something went wrong.' });
          } else {
            resolve(response || { error: 'empty', message: 'Something went wrong.' });
          }
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ error: 'exception', message: (err && err.message) || 'Something went wrong.' });
        }
      }
    });
  }

  async function runHoverAsk(instruction) {
    if (busy || !activeBlock) return;
    if (!contextAlive()) { staleClick(); return; }
    const block = activeBlock;
    const sourceText = scopeText(block);
    busy = true;
    removePopover();
    if (icon) icon.classList.add('sr-hover-busy');

    const response = await sendMessageWithTimeout({ action: 'hoverAskAI', text: sourceText, instruction });
    busy = false;
    if (icon) icon.classList.remove('sr-hover-busy');

    if (!response || response.error) {
      const message = (response && (response.message || response.error)) || 'Something went wrong.';
      console.warn('Proofr hoverAskAI failed:', message);
      showFeedback('error', message, response && response.title ? { title: response.title } : undefined);
      removeIcon();
      return;
    }

    showFeedback('result', sourceText, response.text, 'ask', response.provider, null, { where: response.where });
    removeIcon();
  }

  async function runHoverAction(tone) {
    if (busy || !activeBlock) return;
    if (!contextAlive()) { staleClick(); return; }
    const block = activeBlock;
    const sourceText = scopeText(block);
    busy = true;
    removePopover();
    if (icon) icon.classList.add('sr-hover-busy');

    const { srTargetLang } = await syncGet(['srTargetLang']);
    const targetLang = srTargetLang || 'en';
    const response = await sendMessageWithTimeout({ action: 'hoverRewrite', text: sourceText, tone, targetLang });

    busy = false;
    if (icon) icon.classList.remove('sr-hover-busy');

    if (!response || response.error) {
      const message = (response && (response.message || response.error)) || 'Something went wrong.';
      console.warn('Proofr hoverRewrite failed:', message);
      showFeedback('error', message, response && response.title ? { title: response.title } : undefined);
      removeIcon();
      return;
    }

    showFeedback('result', sourceText, response.text, tone, response.provider, targetLang, { where: response.where });
    removeIcon();
  }

  document.addEventListener('mousemove', (e) => {
    if (!enabled || paused || popover || busy) return; // don't fight an open popover or an in-flight action
    const target = e.target;
    if (!target || target === document.body || target === document.documentElement) return;
    // Settling onto the icon itself (the natural pause right before clicking
    // it) is our own UI, not page content — resolveBlock correctly returns
    // null for it, but that used to be read as "nothing here, remove the
    // icon," destroying it a moment before the click could land and leaving
    // the click to fall through to the page underneath (which is what was
    // actually clearing the selection). Leave the current icon alone here.
    if (target.closest && target.closest('.sr-hover-icon')) { clearDwell(); return; }
    // Still inside the block that has the icon: nothing to work out.
    if (icon && activeBlock && activeBlock.el.contains(target)) { clearDwell(); cancelScheduledRemove(); return; }
    // Still settling on the same element: keep its timer running.
    if (dwellTimer && target === dwellTarget) return;
    clearDwell();
    dwellTarget = target;
    dwellTimer = setTimeout(() => {
      dwellTimer = null;
      dwellTarget = null;
      if (!contextAlive()) { standDown(); return; }
      if (typeof SR_DOM === 'undefined') return;
      const block = SR_DOM.resolveBlock(target);
      if (block) { cancelScheduledRemove(); showIcon(block); }
      else scheduleRemove();
    }, DWELL_MS);
  }, { passive: true });

  document.addEventListener('scroll', () => {
    if (icon && activeBlock) positionNear(icon, activeBlock.el.getBoundingClientRect());
    if (popover && icon) positionNear(popover, icon.getBoundingClientRect(), { below: true });
  }, { passive: true, capture: true });

  document.addEventListener('click', (e) => {
    if (popover && !popover.contains(e.target) && e.target !== icon) removePopover();
  });

  // Off by default. Watched live so toggling it in the side panel applies to
  // already-open tabs without a reload.
  syncGet(['srHoverAssist', 'srHoverPaused']).then((r) => { enabled = !!r.srHoverAssist; paused = !!r.srHoverPaused; });
  try { chrome.storage.local.get(['srHoverScope'], (r) => { preferRegion = !!(r && r.srHoverScope === 'region'); }); } catch (_) { /* Proofr was reloaded */ }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !(changes.srHoverAssist || changes.srHoverPaused)) return;
    if (changes.srHoverAssist) enabled = !!changes.srHoverAssist.newValue;
    if (changes.srHoverPaused) paused = !!changes.srHoverPaused.newValue;
    if (!enabled || paused) { clearDwell(); removePopover(); removeIcon(); }
  });
})();
