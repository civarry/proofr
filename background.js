// Shared tone metadata + cloud provider calls (SR_TONES, SR_rewrite, SR_getToneName, …)
importScripts('constants.js');

// Resolves the active cloud provider's full config (Groq/OpenAI/OpenRouter/
// Custom — any OpenAI-compatible endpoint). Read-only here; saving keys/model
// is a settings-panel concern, handled in sidepanel.js.
class CloudProvider {
  static async getActiveService() {
    const r = await chrome.storage.sync.get(['srCloudService']);
    return r.srCloudService || 'groq';
  }

  static async getConfig(serviceId) {
    const id = serviceId || await this.getActiveService();
    const meta = SR_cloudServiceMeta(id);
    const keyField = `srCloudKey_${id}`;
    const modelField = `srCloudModel_${id}`;
    const r = await chrome.storage.sync.get([keyField, modelField, 'srCloudCustomBaseURL', 'groqAPIKey']);
    // Legacy single-key storage (pre-multi-provider) — carries an already-saved Groq key forward.
    const apiKey = r[keyField] || (id === 'groq' ? (r.groqAPIKey || '') : '');
    const baseURL = id === 'custom' ? (r.srCloudCustomBaseURL || '') : meta.baseURL;
    const model = r[modelField] || meta.defaultModel;
    return { id, displayName: meta.name, baseURL, model, apiKey };
  }

  static async hasKey(serviceId) {
    const cfg = await this.getConfig(serviceId);
    return !!(cfg.apiKey && cfg.apiKey.trim().length > 0);
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

// Clicking the toolbar icon opens the side panel directly (replaces the old popup).
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
    console.warn('Could not set side panel behavior:', error?.message || error);
  });
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

  chrome.contextMenus.create({
    id: 'translatePage',
    title: 'Translate this page (Proofr)',
    contexts: ['page'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'openSettings') {
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch (error) {
      inject(tab.id, showErrorMessage, ['Click the Proofr toolbar icon to open settings.']);
    }
    return;
  }

  if (info.menuItemId === 'translatePage') {
    await ensurePageTranslateAssets(tab.id);
    return;
  }

  if (typeof info.menuItemId === 'string' && info.menuItemId.startsWith('sr:')) {
    const tone = info.menuItemId.slice(3);
    await handleRewrite(tab.id, info.selectionText, tone, { ensure: true });
  }
});

// === Messages from content scripts ===
// Two shapes here: the original fire-and-forget flow (keyboard shortcut, "try
// another tone", hover icon's "More…") which drives the on-page modal
// directly via handleRewrite, and the newer request/response flow (hover
// quick-actions, page-translate batches) which needs a result handed back to
// the content script itself because it — not background.js — holds the
// reference to which DOM node to update.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'quickRewrite' || message.action === 'rewriteWithTone') {
    handleRewrite(sender.tab.id, message.text, message.tone, { targetLang: message.targetLang });
    return false;
  }
  if (message.action === 'hoverRewrite') {
    handleHoverRewrite(message, sendResponse);
    return true; // async sendResponse
  }
  if (message.action === 'translatePageBatch') {
    handleTranslateBatch(message, sendResponse);
    return true; // async sendResponse
  }
  if (message.action === 'hoverAskAI') {
    handleHoverAskAI(message, sendResponse);
    return true; // async sendResponse
  }
  return false;
});

// === Hover-to-act: rewrite/proofread a single hovered block ===
async function handleHoverRewrite(message, sendResponse) {
  try {
    const settings = await getSettings();
    const provider = await CloudProvider.getConfig();
    const deviceReady = await SR_deviceReady();
    if (settings.engine === 'cloud' && !provider.apiKey) {
      sendResponse({ error: 'no_key', message: `The engine is set to "Cloud only", but no ${provider.displayName} key is saved. Add one in the Proofr side panel, or switch the engine to Auto.` });
      return;
    }
    if (!provider.apiKey && !deviceReady) {
      sendResponse({ error: 'no_ai', message: 'No AI is set up yet. Open the Proofr side panel to connect a free Groq key, since Chrome’s built-in AI isn’t available here.' });
      return;
    }
    const { text, provider: providerId } = await SR_rewriteAuto(message.text, message.tone, {
      provider,
      engine: settings.engine,
      targetLang: message.targetLang,
    });
    await StatsManager.updateStats(message.tone);
    sendResponse({ text, provider: providerId });
  } catch (error) {
    sendResponse({ error: error.message || 'Something went wrong.' });
  }
}

// === Hover Ask AI: freeform instruction on a hovered block (cloud key) ===
async function handleHoverAskAI(message, sendResponse) {
  try {
    const provider = await CloudProvider.getConfig();
    if (!provider.apiKey) {
      sendResponse({ error: 'no_key', message: `Add a ${provider.displayName} API key in Proofr settings to use custom instructions.` });
      return;
    }
    const text = await SR_askCloud(provider, message.text, message.instruction);
    await StatsManager.updateStats('ask');
    sendResponse({ text, provider: provider.id });
  } catch (error) {
    sendResponse({ error: error.message || 'Something went wrong.' });
  }
}

// === Full-page translate: one batch of numbered blocks at a time ===
// On-device languages (SR_isOnDeviceLanguage) run locally when available;
// anything else goes to the user's own cloud provider key.
async function handleTranslateBatch(message, sendResponse) {
  try {
    const onDeviceLang = SR_isOnDeviceLanguage(message.targetLang);

    const settings = await getSettings();
    const provider = await CloudProvider.getConfig();
    const deviceReady = onDeviceLang && settings.engine !== 'cloud' && await SR_deviceReady();

    if (deviceReady) {
      const results = await SR_translateBatchDevice(message.items, message.targetLang);
      sendResponse({ results, provider: 'device' });
      return;
    }

    if (!provider.apiKey) {
      sendResponse({ error: 'no_key', message: `Add a ${provider.displayName} API key in the Proofr side panel to translate into this language.` });
      return;
    }
    const targetLangName = SR_fullLangName(message.targetLang);
    const results = await SR_translateBatchCloud(provider, message.items, targetLangName);
    sendResponse({ results, provider: provider.id });
  } catch (error) {
    sendResponse({ error: error.message || 'Translation failed.' });
  }
}

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
    const provider = await CloudProvider.getConfig();
    const hasKey = !!provider.apiKey;

    if (engine === 'device' && !deviceReady) {
      inject(tabId, showErrorMessage, [
        'The engine is set to "On-device only", but Chrome’s built-in AI isn’t available here. Switch it to Auto or Cloud in the Proofr side panel.',
      ]);
      return;
    }
    if (engine === 'cloud' && !hasKey) {
      inject(tabId, showErrorMessage, [
        `The engine is set to "Cloud only", but no ${provider.displayName} key is saved. Add one in the Proofr side panel, or switch the engine to Auto.`,
      ]);
      return;
    }
    if (!deviceReady && !hasKey) {
      inject(tabId, showErrorMessage, [
        'No AI is set up yet. Open the Proofr side panel to use Chrome’s built-in AI, or add a cloud provider API key.',
      ]);
      return;
    }

    inject(tabId, showLoadingModal, [text, tone, lang]);

    const { text: rewritten, provider: providerId } = await SR_rewriteAuto(text, tone, { provider, engine, targetLang: lang });
    await StatsManager.updateStats(tone);

    inject(tabId, showRewriteResult, [text, rewritten, tone, providerId, lang]);
  } catch (error) {
    console.error('Rewrite failed:', error);
    // If we reached the rewrite with no key, on-device was the engine used — the
    // most common failure is an unsupported language. Point at the real fix.
    const hasKey = await CloudProvider.hasKey();
    if (!hasKey) {
      inject(tabId, showErrorMessage, [
        'On-device AI couldn’t rewrite this. It only supports EN, ES, FR, DE, JA. Open the Proofr side panel and add a cloud provider key to handle other languages.',
      ]);
      return;
    }
    inject(tabId, showErrorMessage, [error.message]);
  }
}

function inject(tabId, func, args) {
  chrome.scripting.executeScript({ target: { tabId }, func, args });
}

// Make sure the modal + hover-assist assets are on the page. Each content
// script self-guards against double-init, so calling this repeatedly is safe.
// Silently ignores pages that block injection (e.g. chrome:// pages, the Web
// Store) — only matters for tabs opened before install/reload; on a normal
// page load the manifest's content_scripts already cover this.
async function ensureContentAssets(tabId) {
  try {
    const [{ result: alreadyLoaded } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!window.SmartRewriteModal && !!window.__srHoverAssistLoaded,
    });
    if (alreadyLoaded) return;

    await chrome.scripting.insertCSS({ target: { tabId }, files: ['modal.css'] });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['constants.js', 'dom-scan.js', 'hover-assist.js', 'content.js'],
    });
  } catch (error) {
    console.warn('Could not inject Proofr into this page:', error?.message || error);
  }
}

// Full-page translate is heavier (walks the whole DOM) and rarely used, so it's
// never in the always-on content_scripts bundle — only injected when the user
// explicitly asks for it. Re-triggering the menu item on a page that's already
// translating toggles it off instead of double-injecting.
async function ensurePageTranslateAssets(tabId) {
  try {
    const [{ result: alreadyRunning } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!window.__srPageTranslateLoaded,
    });
    if (alreadyRunning) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => { window.SRPageTranslate && window.SRPageTranslate.toggle(); },
      });
      return;
    }

    await ensureContentAssets(tabId); // constants/dom-scan must exist first
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['page-translate.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['page-translate.js'] });
  } catch (error) {
    console.warn('Could not start page translate on this tab:', error?.message || error);
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
