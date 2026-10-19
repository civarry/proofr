(function() {
  'use strict';

  if (window.SmartRewriteModal) return;

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
          <div class="sr-modal-container">
            <div class="sr-modal-header">
              <div class="sr-modal-title">
                <div class="sr-logo">${(typeof SR_LOGO_SVG !== 'undefined') ? SR_LOGO_SVG : 'SR'}</div>
                <h3>Proofr</h3>
              </div>
              <button class="sr-close-btn" id="sr-close-btn">✕</button>
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
          } else if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
            if (this.currentRewrite) {
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

    // A small corner indicator for inline replacements — no full modal.
    showLoadingToast(tone) {
      this.hideLoadingToast();
      const toneName = this.getToneName(tone);
      const label = tone === 'translate' ? 'Translating' : `Rewriting to ${toneName}`;
      const toast = document.createElement('div');
      toast.className = 'sr-loading-toast';
      toast.id = 'sr-loading-toast';
      toast.innerHTML = `<span class="sr-toast-spin"></span><span>${label}…</span>`;
      document.body.appendChild(toast);
      requestAnimationFrame(() => toast.classList.add('sr-show'));
    }

    hideLoadingToast() {
      const toast = document.getElementById('sr-loading-toast');
      if (toast) {
        toast.classList.remove('sr-show');
        setTimeout(() => toast.remove(), 200);
      }
    }

    showLoading(originalText, tone, targetLang) {
      this.currentText = originalText;
      this.currentTone = tone;
      this.currentRewrite = '';
      if (targetLang) this.currentLang = targetLang;
      this.busy = true;

      // Editable target → the result gets replaced in place, so skip the big modal
      // and show a light corner indicator instead.
      if (this.isEditableTarget()) { this.showLoadingToast(tone); return; }

      if (!this.modal) this.createModal();

      const toneName = this.getToneName(tone);
      const working = tone === 'translate' ? 'Translating' : `Rewriting to ${toneName}`;

      document.getElementById('sr-modal-content').innerHTML = `
        ${notice ? `<p class="sr-notice" role="alert">${this.escapeHtml(notice)}</p>` : ''}
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
    showResult(originalText, rewrittenText, tone, provider, targetLang, { notice, where, action } = {}) {
      this.currentText = originalText;
      this.currentRewrite = rewrittenText;
      this.currentTone = tone;
      this.busy = false;
      this.hideLoadingToast();
      if (targetLang) this.currentLang = targetLang;

      if (!this.modal) this.createModal();

      // Proofread shows what changed; null (too long) or no changes → plain text.
      const ops = tone === 'grammar' && typeof SR_wordDiff === 'function' ? SR_wordDiff(originalText, rewrittenText) : null;
      const diffHtml = ops && SR_diffCount(ops) ? this.diffHtml(ops) : '';
      const plainHtml = this.escapeHtml(rewrittenText);

      document.getElementById('sr-modal-content').innerHTML = `
        ${notice ? `<p class="sr-notice" role="alert">${this.escapeHtml(notice)}</p>` : ''}
        ${this.toneChipsHtml(tone)}
        ${this.langRowHtml(tone, targetLang)}
        <div class="sr-result-box sr-scrollable" id="sr-rewritten-text">${diffHtml || plainHtml}</div>
        ${diffHtml ? '<button type="button" class="sr-diff-toggle" id="sr-diff-toggle" aria-pressed="false">Show plain text</button>' : ''}
        <details class="sr-original">
          <summary>Show original</summary>
          <div class="sr-original-text">${this.escapeHtml(originalText)}</div>
        </details>
      `;

      // Say where the text went, in plain words.
      const engineName = this.providerLabel(provider);
      where = where || (provider === 'device' ? 'On this computer' : engineName ? `Sent to ${engineName}` : '');
      const engineTag = where ? `<span class="sr-engine">${this.escapeHtml(where)}</span>` : '';
      document.getElementById('sr-modal-footer').innerHTML = `
        ${action ? `<button class="sr-btn sr-btn-primary" id="sr-action-btn">${this.escapeHtml(action.label)}</button>` : ''}
        <button class="sr-btn ${action ? 'sr-btn-secondary' : 'sr-btn-primary'}" id="sr-copy-btn">Copy</button>
        <span class="sr-hint">Tap a tone to rewrite again · Esc to close</span>
        ${engineTag}
      `;

      document.getElementById('sr-copy-btn').addEventListener('click', () => {
        this.copyToClipboard(rewrittenText);
      });
      if (action) {
        document.getElementById('sr-action-btn').addEventListener('click', async () => {
          if (await action.run()) this.hide();
        });
      }

      const toggle = document.getElementById('sr-diff-toggle');
      if (toggle) {
        toggle.addEventListener('click', () => {
          const plain = toggle.getAttribute('aria-pressed') !== 'true';
          document.getElementById('sr-rewritten-text').innerHTML = plain ? plainHtml : diffHtml;
          toggle.setAttribute('aria-pressed', String(plain));
          toggle.textContent = plain ? 'Show changes' : 'Show plain text';
        });
      }

      this.bindChips();
      this.bindLangRow();
      this.show();
      this.maybeShowRatePrompt();
    }

    // One-time, neutral ask after a few successful results. Same for everyone,
    // no reward, never on errors (CWS spam policy: no incentives, no gating).
    async maybeShowRatePrompt() {
      try {
        const { rewriteStats, srRateAsked } = await chrome.storage.local.get(['rewriteStats', 'srRateAsked']);
        if (srRateAsked || !rewriteStats || rewriteStats.totalRewrites < 5) return;
        const footer = document.getElementById('sr-modal-footer');
        if (!footer || footer.querySelector('.sr-rate')) return;
        const line = document.createElement('div');
        line.className = 'sr-rate';
        line.innerHTML = `Finding Proofr useful? A rating helps other people find it. <a href="${SR_REVIEWS_URL}" target="_blank" rel="noopener" id="sr-rate-link">Rate it</a> <button type="button" class="sr-rate-dismiss" id="sr-rate-dismiss">Not now</button>`;
        footer.appendChild(line);
        const done = () => { chrome.storage.local.set({ srRateAsked: true }); line.remove(); };
        line.querySelector('#sr-rate-link').addEventListener('click', done);
        line.querySelector('#sr-rate-dismiss').addEventListener('click', done);
      } catch (_) {
        // Storage unavailable (extension reloaded under the page): skip the ask.
      }
    }

    showError(message, { title } = {}) {
      this.busy = false;
      this.hideLoadingToast();
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
          <button class="sr-btn sr-btn-secondary" id="sr-error-close">Close</button>
        </div>
      `;
      // Not an inline onclick: that runs in the page's world, where SmartRewriteModal doesn't exist.
      document.getElementById('sr-error-close').addEventListener('click', () => this.hide());

      this.show();
    }

    // opts.review: { original, rewritten, tone, provider, where? } adds a Review link that
    // opens the result dialog (with the Proofread diff) for a replace already done.
    showSuccess(message, { review } = {}) {
      this.busy = false;
      this.hideLoadingToast();
      const notification = document.createElement('div');
      notification.className = 'sr-success-notification';
      notification.setAttribute('role', 'status');
      notification.setAttribute('aria-live', 'polite');
      notification.innerHTML = `
        <div class="sr-success-content">
          <span class="sr-success-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg></span>
          <span class="sr-success-text">${this.escapeHtml(message)}</span>
          ${review ? '<button type="button" class="sr-success-review">Review</button>' : ''}
        </div>
      `;
      if (review) {
        notification.querySelector('.sr-success-review').addEventListener('click', () => {
          notification.remove();
          this.showResult(review.original, review.rewritten, review.tone, review.provider, null, { where: review.where });
        });
      }
      
      document.body.appendChild(notification);
      
      setTimeout(() => notification.classList.add('sr-show'), 100);
      
      // An undo hint needs time to read and act on.
      setTimeout(() => {
        notification.classList.remove('sr-show');
        setTimeout(() => notification.remove(), 300);
      }, /undo/i.test(message) || review ? 6000 : 3000);
    }

    show() {
      if (this.modal) {
        this.modal.style.display = 'block';
        this.isVisible = true;

        setTimeout(() => {
          this.modal.classList.add('sr-visible');
        }, 10);
      }
    }

    hide() {
      if (this.modal) {
        this.modal.classList.remove('sr-visible');
        setTimeout(() => {
          this.modal.style.display = 'none';
          this.isVisible = false;
        }, 300);
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

    escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    diffHtml(ops) {
      return ops.map((op) => {
        const text = this.escapeHtml(op.text);
        if (op.type === 'del') return `<del class="sr-diff-del">${text}</del>`;
        if (op.type === 'ins') return `<ins class="sr-diff-ins">${text}</ins>`;
        return text;
      }).join('');
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