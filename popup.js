// === API Key Manager Class ===
class APIKeyManager {
  static async getAPIKey() {
    try {
      const result = await chrome.storage.sync.get(['groqAPIKey']);
      return result.groqAPIKey || null;
    } catch (error) {
      console.error('Error getting API key:', error);
      return null;
    }
  }

  static async setAPIKey(apiKey) {
    try {
      await chrome.storage.sync.set({ groqAPIKey: apiKey });
      return true;
    } catch (error) {
      console.error('Error setting API key:', error);
      return false;
    }
  }

  static async hasAPIKey() {
    try {
      const apiKey = await this.getAPIKey();
      return apiKey && apiKey.trim().length > 0;
    } catch (error) {
      console.error('Error checking API key:', error);
      return false;
    }
  }

  static async clearAPIKey() {
    try {
      await chrome.storage.sync.remove(['groqAPIKey']);
      return true;
    } catch (error) {
      console.error('Error clearing API key:', error);
      return false;
    }
  }
}

// === Statistics Manager ===
class StatsManager {
  static async getStats() {
    try {
      const result = await chrome.storage.local.get(['rewriteStats']);
      return result.rewriteStats || {
        totalRewrites: 0,
        styleUsage: {},
        lastUsed: null
      };
    } catch (error) {
      console.error('Error getting stats:', error);
      return {
        totalRewrites: 0,
        styleUsage: {},
        lastUsed: null
      };
    }
  }

  static async updateStats(style) {
    try {
      const stats = await this.getStats();
      stats.totalRewrites++;
      stats.styleUsage[style] = (stats.styleUsage[style] || 0) + 1;
      stats.lastUsed = Date.now();
      
      await chrome.storage.local.set({ rewriteStats: stats });
      return stats;
    } catch (error) {
      console.error('Error updating stats:', error);
      return null;
    }
  }

  static async getFavoriteStyle() {
    try {
      const stats = await this.getStats();
      let maxCount = 0;
      let favoriteStyle = '-';
      
      for (const [style, count] of Object.entries(stats.styleUsage)) {
        if (count > maxCount) {
          maxCount = count;
          favoriteStyle = this.getStyleName(style);
        }
      }
      
      return favoriteStyle;
    } catch (error) {
      console.error('Error getting favorite style:', error);
      return '-';
    }
  }

  static getStyleName(style) {
    const names = {
      friendly: 'Friendly',
      professional: 'Professional',
      short: 'Concise',
      linkedin: 'LinkedIn',
      academic: 'Academic',
      marketing: 'Marketing',
      simple: 'Plain English',
      executive: 'Executive',
      translate: 'Translate'
    };
    return names[style] || style;
  }
}

// === UI Helper Functions ===
class UIHelper {
  static showStatus(message, type, icon = '') {
    const statusDiv = document.getElementById("apiStatus");
    if (!statusDiv) return;
    
    statusDiv.className = `status status-${type}`;
    statusDiv.innerHTML = `
      <span class="status-icon">${icon}</span>
      <span>${message}</span>
    `;
    statusDiv.classList.remove('hidden');
    
    if (type === 'success') {
      setTimeout(() => {
        statusDiv.classList.add('hidden');
      }, 5000);
    }
  }

  static clearStatus() {
    const statusDiv = document.getElementById("apiStatus");
    if (statusDiv) {
      statusDiv.className = 'status hidden';
      statusDiv.innerHTML = '';
    }
  }

  static setButtonLoading(buttonId, loading, originalText = '') {
    const button = document.getElementById(buttonId);
    if (!button) return;
    
    if (loading) {
      button.disabled = true;
      button.classList.add('loading');
      button.textContent = 'Loading...';
    } else {
      button.disabled = false;
      button.classList.remove('loading');
      button.textContent = originalText || 'Save Key';
    }
  }

  static createModal(content) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content">
        ${content}
      </div>
    `;
    
    // Close on backdrop click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.remove();
      }
    });
    
    // Close on ESC key
    const handleEsc = (e) => {
      if (e.key === 'Escape') {
        modal.remove();
        document.removeEventListener('keydown', handleEsc);
      }
    };
    document.addEventListener('keydown', handleEsc);
    
    document.body.appendChild(modal);
    return modal;
  }

  static async downloadFile(filename, content, contentType = 'text/plain') {
    try {
      const blob = new Blob([content], { type: contentType });
      const url = URL.createObjectURL(blob);
      
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      
      URL.revokeObjectURL(url);
      return true;
    } catch (error) {
      console.error('Error downloading file:', error);
      return false;
    }
  }
}

// === Enhanced API Key Validation ===
function isValidGroqAPIKey(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') return false;
  return apiKey.startsWith("gsk_") && apiKey.length >= 40;
}

// === API Key Validation Test ===
async function validateAPIKey(apiKey) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    
    const response = await fetch("https://api.groq.com/openai/v1/models", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    return response.ok;
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error("API validation timeout");
    } else {
      console.error("API key validation error:", error);
    }
    return false;
  }
}

// === Update API Key Status ===
async function updateAPIKeyStatus() {
  try {
    const hasKey = await APIKeyManager.hasAPIKey();
    
    if (hasKey) {
      UIHelper.showStatus("✅ API Key configured and ready", "success");
    } else {
      UIHelper.showStatus("⚠️ No API Key - Extension won't work", "error");
    }
  } catch (error) {
    console.error('Error updating API key status:', error);
    UIHelper.showStatus("❌ Error checking API key", "error");
  }
}

// === Update Statistics Display ===
async function updateStatsDisplay() {
  try {
    const stats = await StatsManager.getStats();
    const favoriteStyle = await StatsManager.getFavoriteStyle();
    
    const totalElement = document.getElementById('totalRewrites');
    const favoriteElement = document.getElementById('favoriteStyle');
    
    if (totalElement) totalElement.textContent = stats.totalRewrites.toString();
    if (favoriteElement) favoriteElement.textContent = favoriteStyle;
  } catch (error) {
    console.error('Error updating stats display:', error);
  }
}

// === Save API Key Function ===
async function saveAPIKey() {
  const apiKeyInput = document.getElementById("apiKeyInput");
  const apiKey = apiKeyInput ? apiKeyInput.value.trim() : '';
  
  if (!apiKey) {
    UIHelper.showStatus("Please enter an API key", "error", "⚠️");
    return;
  }
  
  if (!isValidGroqAPIKey(apiKey)) {
    UIHelper.showStatus("Invalid API key format. Should start with 'gsk_' and be 40+ characters", "error", "❌");
    return;
  }
  
  UIHelper.setButtonLoading('btnSaveKey', true);
  
  try {
    const isValid = await validateAPIKey(apiKey);
    
    if (isValid) {
      const saved = await APIKeyManager.setAPIKey(apiKey);
      
      if (saved) {
        apiKeyInput.value = "";
        await updateAPIKeyStatus();
        UIHelper.showStatus("API key saved and validated successfully!", "success", "🎉");
      } else {
        UIHelper.showStatus("Failed to save API key. Please try again.", "error", "❌");
      }
    } else {
      UIHelper.showStatus("API key validation failed. Please check your key.", "error", "❌");
    }
  } catch (error) {
    console.error('Error saving API key:', error);
    UIHelper.showStatus("Error validating API key: " + error.message, "error", "⚠️");
  } finally {
    UIHelper.setButtonLoading('btnSaveKey', false, 'Save Key');
  }
}

// === Clear API Key Function ===
async function clearAPIKey() {
  try {
    UIHelper.setButtonLoading('btnClearKey', true);
    
    const cleared = await APIKeyManager.clearAPIKey();
    
    if (cleared) {
      await updateAPIKeyStatus();
      UIHelper.showStatus("API key cleared successfully", "success", "✅");
    } else {
      UIHelper.showStatus("Failed to clear API key", "error", "❌");
    }
  } catch (error) {
    console.error('Error clearing API key:', error);
    UIHelper.showStatus("Error clearing API key: " + error.message, "error", "❌");
  } finally {
    UIHelper.setButtonLoading('btnClearKey', false, 'Clear Key');
  }
}

// === Action Handlers ===
const ActionHandlers = {
  async getApiKey() {
    try {
      window.open('https://console.groq.com/keys', '_blank', 'noopener,noreferrer');
    } catch (error) {
      console.error('Error opening API key page:', error);
      UIHelper.showStatus("Please manually visit: https://console.groq.com/keys", "error", "🌐");
    }
  },

  async testExtension() {
    try {
      const hasKey = await APIKeyManager.hasAPIKey();
      
      if (!hasKey) {
        UIHelper.showStatus("Please set up your API key first", "error", "⚠️");
        return;
      }
      
      UIHelper.showStatus("Extension is working! Try selecting text on any webpage.", "success", "✅");
    } catch (error) {
      console.error('Error testing extension:', error);
      UIHelper.showStatus("Error testing extension", "error", "❌");
    }
  },

  async viewHistory() {
    try {
      const stats = await StatsManager.getStats();
      
      if (stats.totalRewrites === 0) {
        UIHelper.showStatus("No rewrite history yet. Start using the extension!", "error", "📝");
        return;
      }
      
      const historyItems = Object.entries(stats.styleUsage)
        .sort(([,a], [,b]) => b - a)
        .map(([style, count]) => 
          `<div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.1);">
            <span>${StatsManager.getStyleName(style)}</span>
            <span style="color: var(--primary); font-weight: 600;">${count} uses</span>
          </div>`
        ).join('');
        
      const lastUsedDate = stats.lastUsed ? new Date(stats.lastUsed).toLocaleDateString() : 'Never';
      
      const modalContent = `
        <div class="modal-header">
          <h3>Usage History</h3>
        </div>
        <div class="modal-body">
          <div style="margin-bottom: 20px;">
            <strong>Total Rewrites:</strong> ${stats.totalRewrites}<br>
            <strong>Last Used:</strong> ${lastUsedDate}
          </div>
          <div style="margin-bottom: 16px;">
            <strong>Style Usage:</strong>
          </div>
          <div>
            ${historyItems}
          </div>
        </div>
        <div class="modal-footer">
          <button onclick="this.closest('.modal-overlay').remove()" class="btn btn-primary">Close</button>
        </div>
      `;
      
      UIHelper.createModal(modalContent);
    } catch (error) {
      console.error('Error viewing history:', error);
      UIHelper.showStatus("Error loading history", "error", "❌");
    }
  },

  async exportSettings() {
    try {
      const hasKey = await APIKeyManager.hasAPIKey();
      const stats = await StatsManager.getStats();
      
      const settings = {
        hasApiKey: hasKey,
        stats: stats,
        exportDate: new Date().toISOString(),
        version: '1.0.0'
      };
      
      const success = await UIHelper.downloadFile(
        'smart-rewrite-settings.json', 
        JSON.stringify(settings, null, 2),
        'application/json'
      );
      
      if (success) {
        UIHelper.showStatus("Settings exported successfully!", "success", "📤");
      } else {
        UIHelper.showStatus("Failed to export settings", "error", "❌");
      }
    } catch (error) {
      console.error('Error exporting settings:', error);
      UIHelper.showStatus("Error exporting settings", "error", "❌");
    }
  },

  showPrivacyPolicy() {
    const modalContent = `
      <div class="modal-header">
        <h3>Privacy Policy</h3>
      </div>
      <div class="modal-body">
        <p><strong>Data Collection:</strong></p>
        <ul>
          <li>Your API key is stored locally in your browser</li>
          <li>Usage statistics are stored locally on your device</li>
          <li>No personal data is sent to our servers</li>
        </ul>
        
        <p><strong>Third-Party Services:</strong></p>
        <ul>
          <li>Text processing is done via Groq AI API</li>
          <li>Your text is sent to Groq for processing</li>
          <li>Groq's privacy policy applies to their service</li>
        </ul>
        
        <p><strong>Data Security:</strong></p>
        <ul>
          <li>All communications use HTTPS encryption</li>
          <li>API keys are stored securely in Chrome's sync storage</li>
          <li>No logs or copies of your text are kept by this extension</li>
        </ul>
        
        <p style="margin-top: 16px;">
          <strong>Contact:</strong> For privacy concerns, contact us at privacy@smartrewrite.com
        </p>
      </div>
      <div class="modal-footer">
        <button onclick="this.closest('.modal-overlay').remove()" class="btn btn-primary">Close</button>
      </div>
    `;
    
    UIHelper.createModal(modalContent);
  },

  showSupport() {
    const modalContent = `
      <div class="modal-header">
        <h3>Need Help?</h3>
      </div>
      <div class="modal-body">
        <p><strong>Common Issues:</strong></p>
        <ul>
          <li>Make sure your API key starts with "gsk_"</li>
          <li>Check your internet connection</li>
          <li>Try refreshing the webpage</li>
          <li>Ensure you've selected text before right-clicking</li>
          <li>Some websites may block the extension - try a different site</li>
        </ul>
        
        <p><strong>Keyboard Shortcuts:</strong></p>
        <ul>
          <li><code>Ctrl+Shift+R</code> - Quick professional rewrite</li>
          <li><code>F1</code> - Open this help dialog</li>
        </ul>
        
        <p><strong>Still need help?</strong></p>
        <p>
          Email: support@smartrewrite.com<br>
          GitHub: github.com/yourusername/smart-rewrite<br>
          Version: 1.0.0
        </p>
        
        <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid rgba(255,255,255,0.1);">
          <p><strong>Troubleshooting Steps:</strong></p>
          <ol>
            <li>Verify your API key is correct</li>
            <li>Check browser console for errors (F12)</li>
            <li>Try disabling other extensions temporarily</li>
            <li>Restart your browser</li>
            <li>Contact support if issue persists</li>
          </ol>
        </div>
      </div>
      <div class="modal-footer">
        <button onclick="this.closest('.modal-overlay').remove()" class="btn btn-primary">Close</button>
      </div>
    `;
    
    UIHelper.createModal(modalContent);
  }
};

// === Event Handlers ===
function initializeEventHandlers() {
  // API Key input handlers
  const apiKeyInput = document.getElementById('apiKeyInput');
  const saveBtn = document.getElementById('btnSaveKey');
  const clearBtn = document.getElementById('btnClearKey');
  
  if (saveBtn) {
    saveBtn.addEventListener('click', saveAPIKey);
  }
  
  if (clearBtn) {
    clearBtn.addEventListener('click', clearAPIKey);
  }
  
  if (apiKeyInput) {
    apiKeyInput.addEventListener('keypress', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveAPIKey();
      }
    });
    
    // Clear status when user starts typing
    apiKeyInput.addEventListener('input', function() {
      UIHelper.clearStatus();
    });
  }
  
  // Quick action handlers
  const quickActions = document.querySelectorAll('.quick-action');
  quickActions.forEach(action => {
    action.addEventListener('click', function(e) {
      e.preventDefault();
      const actionName = this.dataset.action;
      if (ActionHandlers[actionName]) {
        ActionHandlers[actionName]();
      }
    });
  });
  
  // Version info link handlers
  const versionLinks = document.querySelectorAll('.version-info a');
  versionLinks.forEach(link => {
    link.addEventListener('click', function(e) {
      e.preventDefault();
      const actionName = this.dataset.action;
      if (ActionHandlers[actionName]) {
        ActionHandlers[actionName]();
      }
    });
  });
  
  // Global keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F1') {
      e.preventDefault();
      ActionHandlers.showSupport();
    }
    
    // Escape key to close any modal
    if (e.key === 'Escape') {
      const modal = document.querySelector('.modal-overlay');
      if (modal) {
        modal.remove();
      }
    }
  });
}

// === Animation and UI Enhancement ===
function initializeAnimations() {
  // Animate cards in sequence
  const cards = document.querySelectorAll('.card');
  cards.forEach((card, index) => {
    card.style.animationDelay = `${index * 0.1}s`;
  });
  
  // Add hover effects to interactive elements
  const interactiveElements = document.querySelectorAll('.quick-action, .feature-item, .btn');
  interactiveElements.forEach(element => {
    element.addEventListener('mouseenter', function() {
      this.style.transform = 'translateY(-2px)';
    });
    
    element.addEventListener('mouseleave', function() {
      this.style.transform = 'translateY(0)';
    });
  });
}

// === Background Script Communication ===
function initializeMessaging() {
  // Listen for messages from background script
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      try {
        if (message.action === 'statsUpdated') {
          updateStatsDisplay();
          sendResponse({ success: true });
        } else if (message.action === 'keyValidationFailed') {
          UIHelper.showStatus("API key validation failed. Please check your key.", "error", "❌");
          sendResponse({ success: true });
        }
      } catch (error) {
        console.error('Error handling message:', error);
        sendResponse({ success: false, error: error.message });
      }
    });
  }
}

// === Error Handling ===
window.addEventListener('error', function(e) {
  console.error('Global error in popup:', e.error);
});

window.addEventListener('unhandledrejection', function(e) {
  console.error('Unhandled promise rejection in popup:', e.reason);
});

// === DOM Content Loaded Event Listener ===
document.addEventListener('DOMContentLoaded', async function() {
  try {
    // Initialize all components
    await updateAPIKeyStatus();
    await updateStatsDisplay();
    initializeEventHandlers();
    initializeAnimations();
    initializeMessaging();
    
    // Auto-focus API key input if no key is set
    const hasKey = await APIKeyManager.hasAPIKey();
    if (!hasKey) {
      const apiKeyInput = document.getElementById('apiKeyInput');
      if (apiKeyInput) {
        setTimeout(() => apiKeyInput.focus(), 300);
      }
    }
    
    console.log('Smart Rewrite popup initialized successfully');
  } catch (error) {
    console.error('Error initializing popup:', error);
    UIHelper.showStatus("Error initializing extension popup", "error", "❌");
  }
});