(function() {
  'use strict';

  if (window.SmartRewriteModal) return;

  // Settings → Appearance for the dialog and notes (theme.js, injected first).
  if (typeof SR_watchTheme === 'function') SR_watchTheme(document.documentElement, 'data-sr-theme', false);

  class SmartRewriteModal {
    constructor() {
      this.modal = null;
      this.isVisible = false;
      this.currentText = '';
      this.currentRewrite = '';
      this.currentTone = '';
    }

    createModal() {
      const modal = document.createElement('div');
      modal.id = 'smart-rewrite-modal';
      modal.innerHTML = `
        <div class="sr-modal-overlay">
          <div class="sr-modal-container" role="dialog" aria-modal="true" aria-labelledby="sr-modal-heading">
            <div class="sr-modal-header">
              <div class="sr-modal-title">
                <div class="sr-logo">${(typeof SR_LOGO_SVG !== 'undefined') ? SR_LOGO_SVG : 'SR'}</div>
                <h3 id="sr-modal-heading">Proofr</h3>
              </div>
              <button class="sr-close-btn" id="sr-close-btn" aria-label="Close">✕</button>
            </div>
            
            <div class="sr-modal-content" id="sr-modal-content">
            </div>
            
            <div class="sr-modal-footer" id="sr-modal-footer">
            </div>
          </div>
        </div>
      `;
      
      document.body.appendChild(modal);
      this.modal = modal;
      
      modal.querySelector('#sr-close-btn').addEventListener('click', () => this.hide());
      modal.querySelector('.sr-modal-overlay').addEventListener('click', (e) => {
        if (e.target.classList.contains('sr-modal-overlay')) {
          this.hide();
        }
      });
      
      document.addEventListener('keydown', (e) => {
        if (this.isVisible) {
          if (e.key === 'Escape') {
            this.hide();
          } else if (e.key === 'Tab') {
            this.trapTab(e);
          } else if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
            // Only when nothing is selected, so copying from "Show original" still works.
            if (this.currentRewrite && !String(window.getSelection() || '')) {
              this.copyToClipboard(this.currentRewrite);
              e.preventDefault();
            }
          }
        }
      });
    }

    toneChipsHtml(activeTone) {
      const tones = (typeof SR_TONES !== 'undefined') ? SR_TONES : [];
      const icon = (id) => (typeof SR_iconFor === 'function') ? SR_iconFor(id) : '';
      return `<div class="sr-chips">${tones.map(t => `
        <button class="sr-chip ${t.id === activeTone ? 'sr-chip-active' : ''}" data-tone="${t.id}" title="${t.desc}">
          <span class="sr-chip-ic">${icon(t.id)}</span><span class="sr-chip-label">${t.name}</span>
        </button>`).join('')}</div>`;
    }

    bindChips() {
      this.modal.querySelectorAll('.sr-chip').forEach(chip => {
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.busy) return;
          const selected = e.currentTarget.dataset.tone;
          if (selected !== this.currentTone) this.rewriteWithTone(selected);
        });
      });
    }

    // Shown only for the Translate tone: pick the target language.
    langRowHtml(tone, targetLang) {
      if (tone !== 'translate' || typeof SR_LANGUAGES === 'undefined') return '';
      const current = targetLang || this.currentLang || 'en';
      const opts = SR_LANGUAGES
        .map(l => `<option value="${l.code}" ${l.code === current ? 'selected' : ''}>${l.name}</option>`)
        .join('');
      return `<div class="sr-lang-row">
        <span>Translate to</span>
        <select class="sr-lang-select" id="sr-lang-select">${opts}</select>
      </div>`;
    }

    bindLangRow() {
      const select = this.modal.querySelector('#sr-lang-select');
      if (!select) return;
      select.addEventListener('change', (e) => {
        e.stopPropagation();
        if (this.busy) return;
        const code = e.target.value;
        this.currentLang = code;
        try { chrome.storage.sync.set({ srTargetLang: code }); } catch (_) {}
        this.rewriteWithTone('translate', code);
      });
    }

    providerLabel(provider) {
      if (!provider) return '';
      return (typeof SR_providerDisplayLabel === 'function') ? SR_providerDisplayLabel(provider) : provider;
    }

    // True when the focused element is a field we can replace text in.
    isEditableTarget() {
      const el = document.activeElement;
      return !!(el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable));
    }

    // Keeps Tab inside the dialog (it's appended at the end of body).
    trapTab(e) {
      const box = this.modal.querySelector('.sr-modal-container');
      const items = [...box.querySelectorAll('button:not([disabled]), select, summary, a[href], [tabindex="0"]')]
        .filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      const inside = box.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (!inside || document.activeElement === last)) { e.preventDefault(); first.focus(); }
    }

    workingLabel(tone) {
      if (tone === 'grammar') return 'Proofreading…';
      if (tone === 'translate') return 'Translating…';
      return `Making it ${this.getToneName(tone).toLowerCase()}…`;
    }

    // One toast per action. Loading, then success, "ready", or a light error,
    // all in the same element: it enters once and changes state in place.
    toastEl() {
      let t = document.getElementById('sr-toast');
      if (t) return t;
      t = document.createElement('div');
      t.id = 'sr-toast';
      t.setAttribute('role', 'status');
      t.setAttribute('aria-live', 'polite');
      // Never vanish under the pointer or keyboard focus.
      t.addEventListener('mouseenter', () => { this.toastHeld = true; clearTimeout(this.toastTimer); });
      t.addEventListener('focusin', () => { this.toastHeld = true; clearTimeout(this.toastTimer); });
      const release = () => {
        if (t.matches(':hover') || t.contains(document.activeElement)) return;
        this.toastHeld = false;
        if (this.toastMs) this.dismissToast(this.toastMs);
      };
      t.addEventListener('mouseleave', release);
      t.addEventListener('focusout', () => setTimeout(release, 0));
      document.body.appendChild(t);
      return t;
    }

    // Just below the field (above it near the bottom edge), clamped to the
    // viewport; the top-right corner when there's no visible field.
    placeToast(t) {
      const el = this.toastAnchor;
      const r = el && el.isConnected ? el.getBoundingClientRect() : null;
      const w = t.offsetWidth, h = t.offsetHeight, gap = 8, vw = window.innerWidth, vh = window.innerHeight;
      if (!r || r.bottom < 0 || r.top > vh || (r.width === 0 && r.height === 0)) {
        t.style.top = t.style.left = t.style.right = '';
        return;
      }
      let top = r.bottom + gap;
      if (top + h > vh - gap) top = r.top - h - gap;
      if (top < gap) top = Math.min(Math.max(gap, r.bottom - h - gap), vh - h - gap);
      t.style.top = `${Math.round(top)}px`;
      t.style.left = `${Math.round(Math.min(Math.max(gap, r.left), vw - w - gap))}px`;
      t.style.right = 'auto';
    }

    // kind: 'loading' | 'success' | 'error'. Returns the element, already placed.
    renderToast(kind, html) {
      this.stopToastClock();
      clearTimeout(this.toastTimer);
      this.toastMs = 0;
      this.toastGen = (this.toastGen || 0) + 1;
      const t = this.toastEl();
      const fresh = !t.classList.contains('sr-show');
      t.className = `${kind === 'loading' ? 'sr-loading-toast' : 'sr-success-notification'}${fresh ? '' : ' sr-show'}`;
      t.setAttribute('aria-busy', String(kind === 'loading'));
      t.innerHTML = html;
      this.placeToast(t);
      if (fresh) requestAnimationFrame(() => t.classList.add('sr-show'));
      return t;
    }

    // ms: how long it stays once nobody is pointing at or focused in it.
    dismissToast(ms) {
      this.toastMs = ms;
      clearTimeout(this.toastTimer);
      if (this.toastHeld) return;
      this.toastTimer = setTimeout(() => this.removeToast(), ms);
    }

    removeToast() {
      this.stopToastClock();
      clearTimeout(this.toastTimer);
      this.toastHeld = false;
      const t = document.getElementById('sr-toast');
      if (!t) return;
      t.removeAttribute('id'); // the next action gets a new toast, not this leaving one
      t.classList.remove('sr-show');
      setTimeout(() => t.remove(), 120); // the exit transition's length
    }

    stopToastClock() {
      clearInterval(this.toastClock);
      clearTimeout(this.spinTimer);
      this.toastClock = null;
      this.loadingRequestId = null;
    }

    // In-place loading: the label at once, the spinner only after 1s (a fast
    // fix never shows a looping animation), seconds after 2s, Stop and Esc.
    showLoadingToast(tone, { requestId, onDevice } = {}) {
      this.toastAnchor = document.activeElement;
      const t = this.renderToast('loading', `<span class="sr-toast-text">${this.workingLabel(tone)}</span><span class="sr-toast-meta" aria-hidden="true"></span><button type="button" class="sr-toast-stop">Stop</button><span class="sr-toast-hint" aria-hidden="true"></span>`);
      this.loadingRequestId = requestId || null;
      this.toastPct = null;
      const started = Date.now();
      this.spinTimer = setTimeout(() => {
        const spin = document.createElement('span');
        spin.className = 'sr-toast-spin';
        t.prepend(spin);
      }, 1000);
      this.toastClock = setInterval(() => {
        const secs = Math.floor((Date.now() - started) / 1000);
        const meta = t.querySelector('.sr-toast-meta');
        if (meta && this.toastPct == null && secs >= 2) meta.textContent = `${secs}s`;
        const hint = t.querySelector('.sr-toast-hint');
        if (hint && onDevice && secs >= 4 && !hint.textContent) { hint.textContent = 'On-device AI can take a while on the first run.'; this.placeToast(t); }
      }, 250);
      t.querySelector('.sr-toast-stop').addEventListener('click', () => this.stopRewrite());
      this.bindToastKeys();
    }

    // Esc stops the in-place rewrite while its toast is loading, but only with
    // focus still in that field, the toast, or nowhere: elsewhere Esc is the page's.
    bindToastKeys() {
      if (this.toastKeysBound) return;
      this.toastKeysBound = true;
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !this.toastClock || this.isVisible) return;
        const a = document.activeElement, t = document.getElementById('sr-toast');
        if (a && a !== document.body && a !== this.toastAnchor && !(t && t.contains(a))) return;
        e.preventDefault();
        e.stopPropagation();
        this.stopRewrite();
      }, true);
    }

    stopRewrite() {
      const requestId = this.loadingRequestId;
      this.busy = false;
      try { chrome.runtime.sendMessage({ action: 'stopRewrite', requestId }); } catch (_) {}
      this.renderToast('success', '<span class="sr-success-text">Stopped.</span>');
      this.dismissToast(1500);
    }

    hideLoadingToast() {
      const t = document.getElementById('sr-toast');
      if (t && t.classList.contains('sr-loading-toast')) this.removeToast();
    }

    // opts.requestId: sent back with Stop. opts.onDevice: show the first-run line.
    showLoading(originalText, tone, targetLang, opts = {}) {
      this.currentText = originalText;
      this.currentTone = tone;
      this.currentRewrite = '';
      if (targetLang) this.currentLang = targetLang;
      this.busy = true;

      // Editable target → the result gets replaced in place, so skip the big modal
      // and show a light corner indicator instead.
      if (this.isEditableTarget()) { this.showLoadingToast(tone, opts); return; }

      if (!this.modal) this.createModal();

      const toneName = this.getToneName(tone);
      const working = tone === 'translate' ? 'Translating' : `Rewriting to ${toneName}`;

      document.getElementById('sr-modal-content').innerHTML = `
        ${this.toneChipsHtml(tone)}
        ${this.langRowHtml(tone, this.currentLang)}
        <div class="sr-skeleton" role="status" aria-label="${working}">
          <div class="sr-skeleton-line"></div>
          <div class="sr-skeleton-line"></div>
          <div class="sr-skeleton-line"></div>
          <div class="sr-skeleton-line"></div>
        </div>
      `;

      document.getElementById('sr-modal-footer').innerHTML = `
        <button class="sr-btn sr-btn-primary" disabled>Copy</button>
        <span class="sr-hint">${working}…</span>
      `;

      this.bindChips();
      this.bindLangRow();
      this.show();
    }

    // opts.notice: one line shown above the result (e.g. the Proofread change guard).
    // opts.where: a ready-made "where the text went" label. opts.action: { label, run }
    // adds a primary button; run() returning true closes the dialog.

    // Partial answer while a rewrite streams (on-device): replaces the skeleton
    // with the text so far. In place, Proofread shows a percent in the toast
    // instead (its output is about as long as its input, so cap below 100).
    streamText(text) {
      if (!this.busy) return;
      if (!this.isVisible) {
        const meta = this.toastClock && document.querySelector('#sr-toast .sr-toast-meta');
        if (!meta || this.currentTone !== 'grammar' || !this.currentText) return;
        this.toastPct = Math.min(95, Math.round((String(text).length / this.currentText.length) * 100));
        meta.textContent = `${this.toastPct}%`;
        return;
      }
      if (!this.modal) return;
      let box = document.getElementById('sr-rewritten-text');
      if (!box) {
        const skeleton = document.querySelector('#sr-modal-content .sr-skeleton');
        if (!skeleton) return;
        box = document.createElement('div');
        box.className = 'sr-result-box sr-scrollable sr-streaming';
        box.id = 'sr-rewritten-text';
        box.setAttribute('aria-busy', 'true');
        skeleton.replaceWith(box);
      }
      box.textContent = text;
    }

    showResult(originalText, rewrittenText, tone, provider, targetLang, { notice, where, action } = {}) {
      this.currentText = originalText;
      this.currentRewrite = rewrittenText;
      this.currentTone = tone;
      this.busy = false;
      this.hideLoadingToast();
      if (targetLang) this.currentLang = targetLang;

      if (!this.modal) this.createModal();

      // Proofread shows what changed; null (too long) or no changes → plain text.
      // Clicking a change puts the original words back; Copy and the action button
      // use the text with only the accepted changes.
      const ops = tone === 'grammar' && typeof SR_wordDiffForDisplay === 'function'
        ? SR_wordDiffForDisplay(originalText, rewrittenText, tone) : null;
      const hasDiff = !!(ops && SR_diffCount(ops));
      const rejected = new Set();
      let plain = false;
      const accepted = () => (hasDiff ? SR_applyDiff(ops, rejected) : rewrittenText);
      const boxHtml = () => (hasDiff && !plain ? this.diffHtml(ops, rejected) : this.escapeHtml(accepted()));

      document.getElementById('sr-modal-content').innerHTML = `
        ${notice ? `<p class="sr-notice" role="alert">${this.escapeHtml(notice)}</p>` : ''}
        ${this.toneChipsHtml(tone)}
        ${this.langRowHtml(tone, targetLang)}
        <div class="sr-result-box sr-scrollable${hasDiff ? ' sr-diff-anim' : ''}" id="sr-rewritten-text">${boxHtml()}</div>
        ${hasDiff ? '<div class="sr-diff-bar"><button type="button" class="sr-diff-toggle" id="sr-diff-toggle" aria-pressed="false">Show plain text</button><span class="sr-diff-tip">Click a change to undo just that one.</span></div>' : ''}
        <details class="sr-original">
          <summary>Show original</summary>
          <div class="sr-original-text">${this.escapeHtml(originalText)}</div>
        </details>
      `;

      // Say where the text went, in plain words.
      const engineName = this.providerLabel(provider);
      where = where || (provider === 'device' ? 'On this computer' : engineName ? `Sent to ${engineName}` : '');
      const engineTag = where ? `<span class="sr-engine" title="${this.escapeHtml(where)}">${this.escapeHtml(where)}</span>` : '';
      document.getElementById('sr-modal-footer').innerHTML = `
        ${action ? `<button class="sr-btn sr-btn-primary" id="sr-action-btn">${this.escapeHtml(action.label)}</button>` : ''}
        <button class="sr-btn ${action ? 'sr-btn-secondary' : 'sr-btn-primary'}" id="sr-copy-btn">Copy</button>
        <span class="sr-hint">Click a tone to rewrite again · Esc to close</span>
        ${engineTag}
      `;

      document.getElementById('sr-copy-btn').addEventListener('click', () => {
        this.copyToClipboard(accepted());
      });
      if (action) {
        document.getElementById('sr-action-btn').addEventListener('click', async () => {
          if (await action.run(accepted())) this.hide();
        });
      }

      const box = document.getElementById('sr-rewritten-text');
      const toggle = document.getElementById('sr-diff-toggle');
      if (toggle) {
        toggle.addEventListener('click', () => {
          plain = !plain;
          box.classList.remove('sr-diff-anim'); // the reveal runs once per result
          box.innerHTML = boxHtml();
          toggle.setAttribute('aria-pressed', String(plain));
          toggle.textContent = plain ? 'Show changes' : 'Show plain text';
        });
        const flip = (el) => {
          const g = Number(el.dataset.g);
          if (rejected.has(g)) rejected.delete(g); else rejected.add(g);
          this.currentRewrite = accepted();
          box.classList.remove('sr-diff-anim');
          box.innerHTML = boxHtml();
          const again = box.querySelector(`.sr-change[data-g="${g}"]`);
          if (again) again.focus();
        };
        box.addEventListener('click', (e) => { const el = e.target.closest('.sr-change'); if (el) flip(el); });
        box.addEventListener('keydown', (e) => {
          const el = e.target.closest('.sr-change');
          if (el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); flip(el); }
        });
      }

      this.bindChips();
      this.bindLangRow();
      this.show();
      this.maybeShowRatePrompt();
    }

    // Neutral rating ask after real use (SR_rateDue, the same as the side panel).
    // Same for everyone, no reward, never on errors (CWS spam policy: no incentives, no gating).
    async maybeShowRatePrompt() {
      try {
        const { rewriteStats, srRateAsked } = await chrome.storage.local.get(['rewriteStats', 'srRateAsked']);
        if (!SR_rateDue(rewriteStats, srRateAsked)) return;
        const footer = document.getElementById('sr-modal-footer');
        if (!footer || footer.querySelector('.sr-rate')) return;
        const line = document.createElement('div');
        line.className = 'sr-rate';
        line.innerHTML = `Finding Proofr useful? A rating helps other people find it. <a href="${SR_REVIEWS_URL}" target="_blank" rel="noopener" id="sr-rate-link">Rate it</a> <button type="button" class="sr-rate-dismiss" id="sr-rate-dismiss">${SR_rateDecline(srRateAsked)}</button>`;
        footer.appendChild(line);
        const done = (choice) => { chrome.storage.local.set({ srRateAsked: SR_rateAfter(choice, rewriteStats, srRateAsked) }); line.remove(); };
        line.querySelector('#sr-rate-link').addEventListener('click', () => done('rate'));
        line.querySelector('#sr-rate-dismiss').addEventListener('click', () => done('later'));
      } catch (_) {
        // Storage unavailable (extension reloaded under the page): skip the ask.
      }
    }

    // retry / alternative: { label, run } run here in the page; run() is called
    // after the error closes. light: a short toast instead of the overlay, for
    // errors that need no reading ("Select some text first").
    showError(message, { title, retry, alternative, light } = {}) {
      this.busy = false;
      const actions = [alternative, retry].filter(Boolean);
      if (light) {
        const t = this.renderToast('error', `<span class="sr-success-text">${this.escapeHtml(message)}</span>${actions.map((a, i) => `<button type="button" class="sr-success-review" data-i="${i}">${this.escapeHtml(a.label)}</button>`).join('')}`);
        t.querySelectorAll('button[data-i]').forEach((btn) => btn.addEventListener('click', () => {
          this.removeToast();
          actions[Number(btn.dataset.i)].run();
        }));
        this.dismissToast(actions.length ? 8000 : 4000);
        return;
      }
      this.removeToast();
      if (!this.modal) this.createModal();

      document.getElementById('sr-modal-content').innerHTML = `
        <div class="sr-error-content">
          <div class="sr-error-icon"><svg viewBox="0 0 24 24" width="38" height="38" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><line x1="12" y1="7.5" x2="12" y2="13"/><line x1="12" y1="16.5" x2="12.01" y2="16.5"/></svg></div>
          <h4>${this.escapeHtml(title || 'Something went wrong')}</h4>
          <p class="sr-error-message">${this.escapeHtml(message)}</p>
        </div>
      `;

      document.getElementById('sr-modal-footer').innerHTML = `
        <div class="sr-action-buttons">
          ${retry ? `<button class="sr-btn sr-btn-primary" id="sr-error-retry">${this.escapeHtml(retry.label)}</button>` : ''}
          ${alternative ? `<button class="sr-btn sr-btn-secondary" id="sr-error-alt">${this.escapeHtml(alternative.label)}</button>` : ''}
          <button class="sr-btn sr-btn-secondary" id="sr-error-close">Close</button>
        </div>
      `;
      // Not an inline onclick: that runs in the page's world, where SmartRewriteModal doesn't exist.
      document.getElementById('sr-error-close').addEventListener('click', () => this.hide());
      // Close first, so focus is back in the text box the retry should land in.
      const bind = (id, a) => a && document.getElementById(id).addEventListener('click', () => { this.hide(); a.run(); });
      bind('sr-error-retry', retry);
      bind('sr-error-alt', alternative);

      this.show();
    }

    // opts.review: { original, rewritten, tone, provider, where?, action? } adds a Review
    // button that opens the result dialog (with the Proofread diff) for a replace already
    // done. opts.undo: a function that undoes the replace (Ctrl/Cmd+Z fails in some rich
    // editors); truthy return → "Undone". opts.apply: { label, run } for a result that
    // wasn't inserted (the user moved to another box); truthy run() → "Applied."
    // A Proofread with nothing changed gets no Review or Undo; one that only fixed
    // spacing keeps Undo (Review would mark nothing). opts.mastered: [word]
    // that this Proofread made mastered, shown as one extra line.
    showSuccess(message, { review, undo, apply, mastered } = {}) {
      this.busy = false;
      const unmarked = !!(review && review.tone === 'grammar' && typeof SR_wordDiffForDisplay === 'function'
        && SR_diffCount(SR_wordDiffForDisplay(review.original, review.rewritten, 'grammar')) === 0);
      if (unmarked && review.original === review.rewritten) undo = null;
      if (unmarked) review = null;
      const t = this.renderToast('success', `
        <div class="sr-success-content">
          <span class="sr-success-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg></span>
          <span class="sr-success-text">${this.escapeHtml(message)}</span>
          ${this.masteredLine(mastered)}
          ${apply ? `<button type="button" class="sr-success-review sr-success-apply">${this.escapeHtml(apply.label)}</button>` : ''}
          ${review ? '<button type="button" class="sr-success-review">Review</button>' : ''}
          ${undo ? '<button type="button" class="sr-success-undo">Undo</button>' : ''}
        </div>
      `);
      const gen = this.toastGen;
      // Replaces the buttons with a one-line outcome, unless run() already showed a new toast.
      const settle = (text, ms) => {
        if (this.toastGen !== gen) return;
        t.querySelectorAll('button, .sr-success-mastered').forEach((b) => b.remove());
        t.querySelector('.sr-success-text').textContent = text;
        this.toastHeld = false;
        this.dismissToast(ms);
      };
      if (review) {
        t.querySelector('.sr-success-review:not(.sr-success-apply)').addEventListener('click', () => this.showReview(review));
      }
      if (apply) {
        t.querySelector('.sr-success-apply').addEventListener('click', async () => {
          let ok = false;
          try { ok = await apply.run(); } catch (_) { ok = false; }
          settle(ok ? 'Applied.' : "Couldn't apply: that text box changed.", ok ? 1500 : 4000);
        });
      }
      if (undo) {
        t.querySelector('.sr-success-undo').addEventListener('click', async () => {
          let ok = false;
          try { ok = await undo(); } catch (_) { ok = false; }
          settle(ok ? 'Undone.' : "Couldn't undo here. Try Ctrl/Cmd+Z.", ok ? 1500 : 4000);
        });
      }
      // Buttons and the mastered line need time to read and reach.
      this.dismissToast(/undo/i.test(message) || review || undo || apply || t.querySelector('.sr-success-mastered') ? 8000 : 3000);
    }

    // "<b>receive</b>: 3 right in a row. Mastered." or "<b>a</b> and <b>b</b>: mastered."
    masteredLine(words) {
      const w = (Array.isArray(words) ? words : []).filter((x) => typeof x === 'string' && x).map((x) => `<b>${this.escapeHtml(x)}</b>`);
      if (!w.length) return '';
      const text = w.length === 1 ? `${w[0]}: 3 right in a row. Mastered.` : `${w.slice(0, -1).join(', ')} and ${w[w.length - 1]}: mastered.`;
      return `<span class="sr-success-mastered"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg><span>${text}</span></span>`;
    }

    // The result dialog for a replace already done (toast Review, or the
    // "review last change" shortcut after the toast has gone).
    showReview(review) {
      this.removeToast();
      this.showResult(review.original, review.rewritten, review.tone, review.provider, null, { where: review.where, action: review.action, notice: review.notice });
    }

    // Coach mode: the original text with each spot Proofread would change marked,
    // without the fix. "Show fixes" calls onReveal (the usual diff); "I'll fix them"
    // closes and puts focus back in the text box.
    showCoach(original, rewritten, { where, onReveal } = {}) {
      this.currentText = original;
      this.currentTone = 'grammar';
      this.currentRewrite = ''; // Ctrl/Cmd+C must not copy the hidden fix
      this.busy = false;
      this.hideLoadingToast();
      if (!this.modal) this.createModal();

      const ops = typeof SR_wordDiffForDisplay === 'function' ? SR_wordDiffForDisplay(original, rewritten, 'grammar') : null;
      const groups = ops ? SR_diffGroups(ops) : [];
      let html = '', spots = 0;
      for (let k = 0; k < (ops || []).length; k++) {
        if (groups[k] < 0) { html += this.escapeHtml(ops[k].text); continue; }
        let del = '';
        const g = groups[k];
        for (; k < ops.length && groups[k] === g; k++) if (ops[k].type === 'del') del += ops[k].text;
        k--;
        spots++;
        html += del
          ? `<mark class="sr-spot">${this.escapeHtml(del)}</mark>`
          : '<mark class="sr-spot sr-spot-gap" aria-label="something missing here"></mark>';
      }
      if (!ops) html = this.escapeHtml(original);
      const count = !ops ? 'Too long to mark the spots. Show fixes to see them.'
        : spots === 0 ? 'Nothing to fix.'
        : `${spots} spot${spots === 1 ? '' : 's'} to check. Fix ${spots === 1 ? 'it' : 'them'} in your text box, or show the fixes.`;

      document.getElementById('sr-modal-content').innerHTML = `
        ${this.toneChipsHtml('grammar')}
        <div class="sr-result-box sr-scrollable" id="sr-coach-text">${html}</div>
        <p class="sr-coach-count" id="sr-coach-count">${count}</p>
      `;
      const engineTag = where ? `<span class="sr-engine" title="${this.escapeHtml(where)}">${this.escapeHtml(where)}</span>` : '';
      document.getElementById('sr-modal-footer').innerHTML = spots || !ops
        ? `<button class="sr-btn sr-btn-primary" id="sr-coach-self">I'll fix them</button>
           <button class="sr-btn sr-btn-secondary" id="sr-coach-reveal">Show fixes</button>${engineTag}`
        : `<button class="sr-btn sr-btn-primary" id="sr-coach-self">Close</button>${engineTag}`;
      document.getElementById('sr-coach-self').addEventListener('click', () => this.hide());
      const reveal = document.getElementById('sr-coach-reveal');
      if (reveal) reveal.addEventListener('click', () => { if (onReveal) onReveal(); });

      this.bindChips();
      this.show();
    }

    // Focus moves into the dialog (primary button) and comes back on hide.
    show() {
      if (this.modal) {
        if (!this.isVisible) this.returnFocus = document.activeElement;
        this.modal.style.display = 'block';
        this.isVisible = true;
        const primary = ['#sr-action-btn', '#sr-error-retry', '.sr-modal-footer .sr-btn-primary:not([disabled])', '#sr-error-close', '#sr-close-btn']
          .map((q) => this.modal.querySelector(q)).find(Boolean);
        // Not while the user is typing in some other box (a late result must not steal focus).
        const a = document.activeElement;
        const typingElsewhere = a && a !== this.toastAnchor && !this.modal.contains(a)
          && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
        if (primary && !typingElsewhere) primary.focus({ preventScroll: true });

        setTimeout(() => {
          this.modal.classList.add('sr-visible');
        }, 10);
      }
    }

    hide() {
      if (this.modal) {
        this.modal.classList.remove('sr-visible');
        this.isVisible = false;
        const back = this.returnFocus;
        this.returnFocus = null;
        if (back && back.isConnected && back !== document.body) back.focus({ preventScroll: true });
        setTimeout(() => {
          if (!this.isVisible) this.modal.style.display = 'none';
        }, 120); // the exit transition's length
      }
    }

    async copyToClipboard(text) {
      try {
        await navigator.clipboard.writeText(text);
        this.showCopySuccess();
      } catch (err) {
        this.fallbackCopyToClipboard(text);
      }
    }

    fallbackCopyToClipboard(text) {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      
      try {
        document.execCommand('copy');
        this.showCopySuccess();
      } catch (err) {
        console.error('Fallback copy failed:', err);
        alert('Copy failed. Please select the text manually.');
      } finally {
        document.body.removeChild(textArea);
      }
    }

    showCopySuccess() {
      const copyBtn = document.getElementById('sr-copy-btn');
      if (copyBtn) {
        const originalText = copyBtn.textContent;
        copyBtn.textContent = 'Copied';
        copyBtn.classList.add('sr-success');
        
        setTimeout(() => {
          copyBtn.textContent = originalText;
          copyBtn.classList.remove('sr-success');
        }, 2000);
      }
    }

    getToneName(tone) {
      if (typeof SR_getToneName === 'function') return SR_getToneName(tone);
      return tone.charAt(0).toUpperCase() + tone.slice(1);
    }

    // Safe in text and in quoted attributes (innerHTML alone leaves quotes as they are).
    escapeHtml(text) {
      const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
      return String(text ?? '').replace(/[&<>"']/g, (c) => map[c]);
    }

    // Each change (a del/ins run) is one toggle; a rejected one shows the original words.
    diffHtml(ops, rejected = new Set()) {
      const groups = SR_diffGroups(ops);
      let html = '';
      for (let k = 0; k < ops.length; k++) {
        const g = groups[k];
        if (g < 0) { html += this.escapeHtml(ops[k].text); continue; }
        let del = '', ins = '';
        for (; k < ops.length && groups[k] === g; k++) {
          if (ops[k].type === 'del') del += ops[k].text; else ins += ops[k].text;
        }
        k--;
        const off = rejected.has(g);
        const inner = off
          // The rejected suggestion stays visible (struck, faint) so it can be clicked back on.
          ? `${del ? `<span class="sr-diff-kept">${this.escapeHtml(del)}</span>` : ''}${ins ? `<s class="sr-diff-off">${this.escapeHtml(ins)}</s>` : ''}`
          : `${del ? `<del class="sr-diff-del">${this.escapeHtml(del)}</del>` : ''}${ins ? `<ins class="sr-diff-ins">${this.escapeHtml(ins)}</ins>` : ''}`;
        const label = off ? 'Change undone. Activate to apply it again.' : 'Activate to undo this change.';
        html += `<span class="sr-change${off ? ' sr-change-rejected' : ''}" data-g="${g}" role="button" tabindex="0" aria-pressed="${off}" title="${label}" aria-label="${this.escapeHtml(`${del.trim() || '(nothing)'} to ${ins.trim() || '(removed)'}`)}. ${label}">${inner}</span>`;
      }
      return html;
    }

    rewriteWithTone(tone, targetLang) {
      const lang = targetLang || this.currentLang;
      this.showLoading(this.currentText, tone, lang);

      chrome.runtime.sendMessage({
        action: 'rewriteWithTone',
        text: this.currentText,
        tone: tone,
        targetLang: lang
      });
    }
  }

  window.SmartRewriteModal = new SmartRewriteModal();
})();
