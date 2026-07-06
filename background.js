// Shared tone metadata + Groq call (SR_TONES, SR_rewrite, SR_getToneName, …)
importScripts('constants.js');

class APIKeyManager {
  static async getAPIKey() {
    const result = await chrome.storage.sync.get(['groqAPIKey']);
    return result.groqAPIKey || null;
  }

  static async hasAPIKey() {
    const apiKey = await this.getAPIKey();
    return apiKey && apiKey.trim().length > 0;
  }
}

async function getSettings() {
  const r = await chrome.storage.sync.get(['srEngine', 'srTargetLang']);
  return { engine: r.srEngine || 'auto', targetLang: r.srTargetLang || 'en' };
}

class StatsManager {
  static async getStats() {
    const result = await chrome.storage.local.get(['rewriteStats']);
    return result.rewriteStats || { totalRewrites: 0, styleUsage: {}, lastUsed: null };
  }

  static async updateStats(style) {
    const stats = await this.getStats();
    stats.totalRewrites++;
    stats.styleUsage[style] = (stats.styleUsage[style] || 0) + 1;
    stats.lastUsed = Date.now();
    await chrome.storage.local.set({ rewriteStats: stats });
    return stats;
  }
}

// === Context menu ===
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'smartRewrite',
    title: 'Proofr',
    contexts: ['selection'],
  });

  SR_TONES.forEach(tone => {
    chrome.contextMenus.create({
      id: `sr:${tone.id}`,
      parentId: 'smartRewrite',
      title: tone.name,
      contexts: ['selection'],
    });
  });

  chrome.contextMenus.create({
    id: 'separator1',
    parentId: 'smartRewrite',
    type: 'separator',
    contexts: ['selection'],
  });

  chrome.contextMenus.create({
    id: 'openSettings',
    parentId: 'smartRewrite',
    title: 'Settings…',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'openSettings') {
    Promise.resolve(chrome.action.openPopup?.()).catch(() => {
      inject(tab.id, showErrorMessage, ['Click the Proofr toolbar icon to open settings.']);
    });
    return;
  }

  if (typeof info.menuItemId === 'string' && info.menuItemId.startsWith('sr:')) {
    const tone = info.menuItemId.slice(3);
    await handleRewrite(tab.id, info.selectionText, tone, { ensure: true });
  }
});

// === Messages from content script (keyboard shortcut, "try another tone") ===
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.action === 'quickRewrite' || message.action === 'rewriteWithTone') {
    handleRewrite(sender.tab.id, message.text, message.tone, { targetLang: message.targetLang });
  }
});

// === Core flow: validate → loading modal → rewrite → show result ===
async function handleRewrite(tabId, text, tone, { ensure = false, targetLang } = {}) {
  try {
    if (!text || text.trim().length === 0) {
      inject(tabId, showErrorMessage, ['Select some text first, then choose a tone.']);
      return;
    }

    // On tabs opened before the extension loaded/reloaded, the content script
    // (which draws the modal) isn't present yet. Inject it before we show anything,
    // otherwise showRewriteResult falls back to a raw alert().
    if (ensure) await ensureContentAssets(tabId);

    const settings = await getSettings();
    const engine = settings.engine;
    // Prefer the language the caller passed (avoids racing storage), else the saved default.
    const lang = targetLang || settings.targetLang;
    const deviceReady = await SR_deviceReady();
    const hasKey = await APIKeyManager.hasAPIKey();

    if (engine === 'device' && !deviceReady) {
      inject(tabId, showErrorMessage, [
        'The engine is set to "On-device only", but Chrome’s built-in AI isn’t available here. Switch it to Auto or Groq in the Proofr popup.',
      ]);
      return;
    }
    if (engine === 'groq' && !hasKey) {
      inject(tabId, showErrorMessage, [
        'The engine is set to "Groq only", but no key is saved. Add a Groq API key in the Proofr popup, or switch the engine to Auto.',
      ]);
      return;
    }
    if (!deviceReady && !hasKey) {
      inject(tabId, showErrorMessage, [
        'No AI is set up yet. Open the Proofr popup to use Chrome’s built-in AI, or add a Groq API key.',
      ]);
      return;
    }

    inject(tabId, showLoadingModal, [text, tone, lang]);

    const apiKey = await APIKeyManager.getAPIKey();
    const { text: rewritten, provider } = await SR_rewriteAuto(text, tone, { apiKey, engine, targetLang: lang });
    await StatsManager.updateStats(tone);

    inject(tabId, showRewriteResult, [text, rewritten, tone, provider, lang]);
  } catch (error) {
    console.error('Rewrite failed:', error);
    // If we reached the rewrite with no key, on-device was the engine used — the
    // most common failure is an unsupported language. Point at the real fix.
    const hasKey = await APIKeyManager.hasAPIKey();
    if (!hasKey) {
      inject(tabId, showErrorMessage, [
        'On-device AI couldn’t rewrite this — it only supports EN, ES, FR, DE, JA. Open the Proofr popup and add a Groq key to handle other languages.',
      ]);
      return;
    }
    inject(tabId, showErrorMessage, [error.message]);
  }
}

function inject(tabId, func, args) {
  chrome.scripting.executeScript({ target: { tabId }, func, args });
}

// Make sure the modal's content assets are on the page. content.js self-guards
// against double-init, so calling this repeatedly is safe. Silently ignores pages
// that block injection (e.g. chrome:// pages, the Web Store).
async function ensureContentAssets(tabId) {
  try {
    const [{ result: alreadyLoaded } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!window.SmartRewriteModal,
    });
    if (alreadyLoaded) return;

    await chrome.scripting.insertCSS({ target: { tabId }, files: ['modal.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['constants.js', 'content.js'] });
  } catch (error) {
    console.warn('Could not inject Proofr into this page:', error?.message || error);
  }
}

// === Functions injected into the page (talk to window.SmartRewriteModal) ===
function showErrorMessage(message) {
  if (window.SmartRewriteModal) {
    window.SmartRewriteModal.showError(message);
  } else {
    alert('Proofr: ' + message);
  }
}

function showLoadingModal(originalText, tone, targetLang) {
  if (window.SmartRewriteModal) {
    window.SmartRewriteModal.showLoading(originalText, tone, targetLang);
  }
}

function showRewriteResult(originalText, rewrittenText, tone, provider, targetLang) {
  const selection = window.getSelection();
  const activeElement = document.activeElement;

  const canReplace = activeElement &&
    (activeElement.tagName === 'TEXTAREA' ||
     activeElement.tagName === 'INPUT' ||
     activeElement.contentEditable === 'true') &&
    selection.rangeCount > 0;

  if (canReplace) {
    if (activeElement.tagName === 'TEXTAREA' || activeElement.tagName === 'INPUT') {
      const start = activeElement.selectionStart;
      const end = activeElement.selectionEnd;
      const value = activeElement.value;
      activeElement.value = value.substring(0, start) + rewrittenText + value.substring(end);
      activeElement.setSelectionRange(start, start + rewrittenText.length);
      activeElement.focus();
    } else if (activeElement.contentEditable === 'true') {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(rewrittenText));
    }

    if (window.SmartRewriteModal) {
      window.SmartRewriteModal.showSuccess('Text replaced.');
      setTimeout(() => window.SmartRewriteModal.hide(), 750);
    }
  } else {
    if (window.SmartRewriteModal) {
      window.SmartRewriteModal.showResult(originalText, rewrittenText, tone, provider, targetLang);
    } else {
      navigator.clipboard.writeText(rewrittenText)
        .then(() => alert('Rewritten text copied to clipboard:\n\n' + rewrittenText))
        .catch(() => alert('Rewritten text:\n\n' + rewrittenText));
    }
  }
}
