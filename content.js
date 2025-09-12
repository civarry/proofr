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
                <div class="sr-logo">SR</div>
                <h3>Smart Rewrite</h3>
                <span class="sr-tone-badge" id="sr-tone-badge"></span>
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

    showLoading(originalText, tone) {
      this.currentText = originalText;
      this.currentTone = tone;
      
      if (!this.modal) this.createModal();
      
      const toneName = this.getToneName(tone);
      const truncatedText = originalText.length > 100 ? originalText.substring(0, 100) + '...' : originalText;
      
      document.getElementById('sr-tone-badge').textContent = toneName;
      
      document.getElementById('sr-modal-content').innerHTML = `
        <div class="sr-loading-content">
          <div class="sr-loading-spinner"></div>
          <h4>Rewriting your text...</h4>
          <p>Converting to <strong>${toneName}</strong> style</p>
          <div class="sr-original-preview">
            <strong>Original:</strong>
            <p>"${truncatedText}"</p>
          </div>
        </div>
      `;
      
      document.getElementById('sr-modal-footer').innerHTML = `
        <div class="sr-loading-footer">
          <p>Powered by Groq AI • Please wait...</p>
        </div>
      `;
      
      this.show();
    }

    showResult(originalText, rewrittenText, tone) {
      this.currentText = originalText;
      this.currentRewrite = rewrittenText;
      this.currentTone = tone;
      
      if (!this.modal) this.createModal();
      
      const toneName = this.getToneName(tone);
      
      document.getElementById('sr-tone-badge').textContent = toneName;
      
      document.getElementById('sr-modal-content').innerHTML = `
        <div class="sr-result-content">
          <div class="sr-text-comparison">
            <div class="sr-text-section">
              <h4>Original Text</h4>
              <div class="sr-text-box sr-original sr-scrollable">${this.escapeHtml(originalText)}</div>
            </div>
            <div class="sr-arrow">→</div>
            <div class="sr-text-section">
              <h4>Rewritten (${toneName})</h4>
              <div class="sr-text-box sr-rewritten sr-scrollable" id="sr-rewritten-text">${this.escapeHtml(rewrittenText)}</div>
            </div>
          </div>
        </div>
      `;
      
      document.getElementById('sr-modal-footer').innerHTML = `
        <div class="sr-action-buttons">
          <button class="sr-btn sr-btn-primary" id="sr-copy-btn">
            📋 Copy to Clipboard
          </button>
          <button class="sr-btn sr-btn-secondary" id="sr-select-text-btn">
            🔍 Select Text
          </button>
          <button class="sr-btn sr-btn-secondary" id="sr-rewrite-again-btn">
            🔄 Try Different Tone
          </button>
        </div>
        <div class="sr-footer-info">
          <p>💡 Tip: Press Ctrl+C to copy • ESC to close</p>
        </div>
      `;
      
      document.getElementById('sr-copy-btn').addEventListener('click', () => {
        this.copyToClipboard(rewrittenText);
      });
      
      document.getElementById('sr-select-text-btn').addEventListener('click', () => {
        this.selectText('sr-rewritten-text');
      });
      
      document.getElementById('sr-rewrite-again-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        this.showToneSelector();
      });
      
      this.show();
    }

    showError(message) {
      if (!this.modal) this.createModal();
      
      document.getElementById('sr-tone-badge').textContent = 'Error';
      
      document.getElementById('sr-modal-content').innerHTML = `
        <div class="sr-error-content">
          <div class="sr-error-icon">⚠️</div>
          <h4>Something went wrong</h4>
          <p class="sr-error-message">${this.escapeHtml(message)}</p>
          <div class="sr-error-tips">
            <h5>Common solutions:</h5>
            <ul>
              <li>Check your internet connection</li>
              <li>Verify your API key is correct</li>
              <li>Try selecting less text</li>
              <li>Wait a moment and try again</li>
            </ul>
          </div>
        </div>
      `;
      
      document.getElementById('sr-modal-footer').innerHTML = `
        <div class="sr-action-buttons">
          <button class="sr-btn sr-btn-secondary" onclick="window.SmartRewriteModal.hide()">
            Close
          </button>
        </div>
      `;
      
      this.show();
    }

    showSuccess(message) {
      const notification = document.createElement('div');
      notification.className = 'sr-success-notification';
      notification.innerHTML = `
        <div class="sr-success-content">
          <span class="sr-success-icon">✅</span>
          <span class="sr-success-text">${this.escapeHtml(message)}</span>
        </div>
      `;
      
      document.body.appendChild(notification);
      
      setTimeout(() => notification.classList.add('sr-show'), 100);
      
      setTimeout(() => {
        notification.classList.remove('sr-show');
        setTimeout(() => notification.remove(), 300);
      }, 3000);
    }

    showToneSelector() {
      const tones = [
        { id: 'friendly', name: 'Friendly Tone', desc: 'Warm and approachable', icon: '🤝' },
        { id: 'professional', name: 'Professional Tone', desc: 'Formal and business-appropriate', icon: '👔' },
        { id: 'short', name: 'Concise Rewrite', desc: 'Brief and to the point', icon: '⚡' },
        { id: 'linkedin', name: 'LinkedIn Ready', desc: 'Perfect for professional networking', icon: '💼' },
        { id: 'academic', name: 'Academic Style', desc: 'Scholarly and formal', icon: '🎓' },
        { id: 'marketing', name: 'Marketing Copy', desc: 'Persuasive and compelling', icon: '📢' },
        { id: 'simple', name: 'Plain English', desc: 'Easy to understand', icon: '📖' },
        { id: 'executive', name: 'Executive Brief', desc: 'Strategic and concise', icon: '📊' },
        { id: 'translate', name: 'Translate', desc: 'Convert text into english', icon: '🔠' }
      ];
      
      document.getElementById('sr-modal-content').innerHTML = `
        <div class="sr-tone-selector">
          <h4>Choose a different tone:</h4>
          <div class="sr-tone-grid">
            ${tones.map(tone => `
              <button class="sr-tone-option ${tone.id === this.currentTone ? 'sr-active' : ''}" data-tone="${tone.id}">
                <span class="sr-tone-icon">${tone.icon}</span>
                <span class="sr-tone-name">${tone.name}</span>
                <span class="sr-tone-desc">${tone.desc}</span>
              </button>
            `).join('')}
          </div>
        </div>
      `;
      
      document.getElementById('sr-modal-footer').innerHTML = `
        <div class="sr-action-buttons">
          <button class="sr-btn sr-btn-secondary" onclick="window.SmartRewriteModal.hide()">
            Cancel
          </button>
        </div>
      `;
      
      document.querySelectorAll('.sr-tone-option').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const selectedTone = e.currentTarget.dataset.tone;
          this.rewriteWithTone(selectedTone);
        });
      });
    }

    show() {
      if (this.modal) {
        this.modal.style.display = 'block';
        document.body.style.overflow = 'hidden';
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
          document.body.style.overflow = '';
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
        copyBtn.textContent = '✅ Copied!';
        copyBtn.classList.add('sr-success');
        
        setTimeout(() => {
          copyBtn.textContent = originalText;
          copyBtn.classList.remove('sr-success');
        }, 2000);
      }
    }

    selectText(elementId) {
      const element = document.getElementById(elementId);
      if (element) {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }

    getToneName(tone) {
      const names = {
        friendly: 'Friendly',
        professional: 'Professional',
        short: 'Concise',
        linkedin: 'LinkedIn',
        academic: 'Academic',
        marketing: 'Marketing',
        simple: 'Plain English',
        executive: 'Executive'
      };
      return names[tone] || tone.charAt(0).toUpperCase() + tone.slice(1);
    }

    escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    rewriteWithTone(tone) {
      this.showLoading(this.currentText, tone);
      
      chrome.runtime.sendMessage({
        action: 'rewriteWithTone',
        text: this.currentText,
        tone: tone
      });
    }
  }

  window.SmartRewriteModal = new SmartRewriteModal();

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'R') {
      const selection = window.getSelection();
      const selectedText = selection.toString().trim();
      
      if (selectedText) {
        e.preventDefault();
        chrome.runtime.sendMessage({
          action: 'quickRewrite',
          text: selectedText,
          tone: 'professional'
        });
      }
    }
  });

  function getSelectionContext() {
    const selection = window.getSelection();
    const activeElement = document.activeElement;
    
    return {
      hasSelection: selection.toString().trim().length > 0,
      selectedText: selection.toString().trim(),
      isEditable: activeElement && (
        activeElement.tagName === 'TEXTAREA' ||
        activeElement.tagName === 'INPUT' ||
        activeElement.contentEditable === 'true'
      ),
      canReplace: selection.rangeCount > 0 && !selection.isCollapsed,
      elementType: activeElement ? activeElement.tagName.toLowerCase() : null
    };
  }

  chrome.runtime.onMessage?.addListener((message, sender, sendResponse) => {
    if (message.action === 'showLoading') {
      window.SmartRewriteModal.showLoading(message.text, message.tone);
    } else if (message.action === 'showResult') {
      window.SmartRewriteModal.showResult(message.originalText, message.rewrittenText, message.tone);
    } else if (message.action === 'showError') {
      window.SmartRewriteModal.showError(message.error);
    }
    
    sendResponse({ success: true });
  });

  function enhanceTextAreas() {
    const textAreas = document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]');
    
    textAreas.forEach(element => {
      if (!element.hasAttribute('data-sr-enhanced')) {
        element.setAttribute('data-sr-enhanced', 'true');
        
        element.addEventListener('contextmenu', (e) => {
          const selectedText = element.value ? 
            element.value.substring(element.selectionStart, element.selectionEnd) :
            window.getSelection().toString();
            
          if (selectedText.trim()) {
            window._srActiveElement = element;
          }
        });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', enhanceTextAreas);
  } else {
    enhanceTextAreas();
  }

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.matches('textarea, input[type="text"], [contenteditable="true"]')) {
            enhanceTextAreas();
          }
          if (node.querySelector && node.querySelector('textarea, input[type="text"], [contenteditable="true"]')) {
            enhanceTextAreas();
          }
        }
      });
    });
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

})();