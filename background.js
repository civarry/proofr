// Shared tone metadata + cloud provider calls (SR_TONES, SR_rewrite, SR_getToneName, …)
importScripts('constants.js');

// API keys live in chrome.storage.local (this device only). Earlier versions
// kept them in storage.sync, which copies them to the user's Google account
// and other devices; migrateKeysToLocal moves any such key over once.
const SR_KEY_FIELDS = ['srCloudKey_groq', 'srCloudKey_openai', 'srCloudKey_openrouter', 'srCloudKey_custom', 'groqAPIKey'];

async function migrateKeysToLocal() {
  const synced = await chrome.storage.sync.get(SR_KEY_FIELDS);
  const found = Object.keys(synced).filter((k) => synced[k]);
  if (found.length === 0) return;
  const local = await chrome.storage.local.get(found);
  const toCopy = {};
  for (const k of found) if (!local[k]) toCopy[k] = synced[k];
  if (Object.keys(toCopy).length) await chrome.storage.local.set(toCopy);
  await chrome.storage.sync.remove(found);
}

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
    const [r, keys] = await Promise.all([
      chrome.storage.sync.get([modelField, 'srCloudCustomBaseURL']),
      chrome.storage.local.get([keyField, 'groqAPIKey']),
    ]);
    // Legacy single-key storage (pre-multi-provider) — carries an already-saved Groq key forward.
    const apiKey = keys[keyField] || (id === 'groq' ? (keys.groqAPIKey || '') : '');
    const baseURL = id === 'custom' ? (r.srCloudCustomBaseURL || '') : meta.baseURL;
    const model = r[modelField] || meta.defaultModel || '';
    // Local servers (Ollama, LM Studio, a custom localhost URL) take no key.
    // Presets for local servers (Ollama, LM Studio) take no key at all. A custom
    // endpoint on this computer may or may not want one (LiteLLM does), so
    // there the key is optional rather than hidden, as in lasso's form.
    const keyless = !!meta.keyless;
    const keyOptional = keyless || (typeof SR_isLocalURL === 'function' && SR_isLocalURL(baseURL));
    return { id, displayName: meta.name, baseURL, model, apiKey, keyless, keyOptional };
  }

  // Ready to send a request: a key, or a provider that doesn't need one.
  static async isReady(serviceId) {
    return providerReady(await this.getConfig(serviceId));
  }
}

function providerReady(cfg) {
  if (typeof SR_providerReady === 'function') return SR_providerReady(cfg);
  return !!(cfg && cfg.baseURL && (cfg.apiKey || cfg.keyless));
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

// Which AI can run right now, from a service worker. On-device only counts
// when the model is already downloaded: downloading needs a user click in a
// page, which the side panel's "Set up on-device AI" button provides.
async function aiStatus() {
  const [settings, provider, availability] = await Promise.all([
    getSettings(), CloudProvider.getConfig(), SR_deviceAvailability(),
  ]);
  return {
    settings,
    provider,
    hasKey: providerReady(provider),
    deviceNow: availability === 'available',
    deviceNeedsSetup: availability === 'downloadable' || availability === 'downloading',
  };
}

// Returns null when something can run, else { title, message } explaining
// the one thing the user needs to do.
function setupProblem({ settings, provider, hasKey, deviceNow, deviceNeedsSetup }) {
  const title = 'Set up Proofr';
  if (settings.engine === 'cloud' && !hasKey) {
    return { title, message: `The engine is set to "Cloud only", but no ${provider.displayName} key is saved. Add one in the Proofr side panel, or switch the engine to Auto.` };
  }
  if (settings.engine === 'device' && !deviceNow) {
    return deviceNeedsSetup
      ? { title, message: 'On-device AI needs a one-time setup. Click the Proofr toolbar icon and choose "Set up on-device AI".' }
      : { title, message: 'The engine is set to "On-device only", but Chrome’s built-in AI isn’t available here. Switch it to Auto or Cloud in the Proofr side panel.' };
  }
  if (!deviceNow && !hasKey) {
    return deviceNeedsSetup
      ? { title, message: 'On-device AI needs a one-time setup. Click the Proofr toolbar icon and choose "Set up on-device AI", or connect an AI provider there instead.' }
      : { title, message: 'No AI is set up yet. Chrome’s built-in AI isn’t available here, so click the Proofr toolbar icon and connect an AI provider (Groq has a free tier; Ollama and LM Studio need no key).' };
  }
  return null;
}

// Rewrite with whatever is ready: on-device only when already downloaded,
// otherwise the cloud key.
function rewriteNow(text, tone, status, targetLang) {
  const engine = (status.settings.engine === 'auto' && !status.deviceNow) ? 'cloud' : status.settings.engine;
  return SR_rewriteAuto(text, tone, { provider: status.provider, engine, targetLang });
}

// Clicking the toolbar icon opens the side panel directly (replaces the old popup).
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
    console.warn('Could not set side panel behavior:', error?.message || error);
  });
}

// === Hover actions: page scripts registered only while the user has them on ===
// No content script runs on any page by default. Turning on "Hover actions"
// in the side panel requests host access (a user gesture there); this keeps
// the registered scripts in step with that setting and that permission.
const HOVER_SCRIPT_ID = 'proofr-hover';

async function syncHoverScripts() {
  const [{ srHoverAssist }, granted, registered] = await Promise.all([
    chrome.storage.sync.get(['srHoverAssist']),
    chrome.permissions.contains({ origins: ['<all_urls>'] }),
    chrome.scripting.getRegisteredContentScripts({ ids: [HOVER_SCRIPT_ID] }),
  ]);
  const want = !!srHoverAssist && granted;
  if (want && registered.length === 0) {
    await chrome.scripting.registerContentScripts([{
      id: HOVER_SCRIPT_ID,
      matches: ['<all_urls>'],
      js: ['constants.js', 'dom-scan.js', 'hover-assist.js', 'content.js'],
      css: ['modal.css'],
      runAt: 'document_end',
    }]);
  } else if (!want && registered.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: [HOVER_SCRIPT_ID] });
  }
  // Access revoked from Chrome's own UI: reflect it in the toggle.
  if (srHoverAssist && !granted) await chrome.storage.sync.set({ srHoverAssist: false });
}

async function dropLegacyHostAccess() {
  const { srHoverAssist } = await chrome.storage.sync.get(['srHoverAssist']);
  if (srHoverAssist) return;
  const { origins = [] } = await chrome.permissions.getAll();
  // Only origins in optional_host_permissions can be removed; the old
  // api.groq.com grant isn't declared anymore, so it's left to Chrome.
  if (origins.includes('<all_urls>')) await chrome.permissions.remove({ origins: ['<all_urls>'] });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.srHoverAssist) syncHoverScripts().catch((e) => console.warn('Hover scripts:', e?.message || e));
});
chrome.permissions.onRemoved.addListener(() => { syncHoverScripts().catch(() => {}); });
chrome.permissions.onAdded.addListener(() => { syncHoverScripts().catch(() => {}); });

// === Install / update ===
// === Context menu ===
// The six modes people reach for most sit at the top; the rest are one level
// down under "More" so the menu scans quickly. The first item shows the real
// shortcut (blank if Chrome couldn't assign Alt+Shift+P on this machine).
const MENU_TOP = ['grammar', 'professional', 'friendly', 'short', 'simple', 'translate'];

async function shortcutLabel() {
  const commands = await chrome.commands.getAll().catch(() => []);
  const cmd = commands.find((c) => c.name === 'proofread-selection');
  return cmd && cmd.shortcut ? cmd.shortcut : '';
}

async function buildContextMenus() {
  const shortcut = await shortcutLabel();
  await chrome.contextMenus.removeAll();
  const add = (props) => chrome.contextMenus.create(props);
  const sel = ['selection'];

  // One top-level "Proofr" entry for both selections and text boxes. Two
  // separate top-level items would make Chrome nest them under the extension
  // name ("Proofr > Proofr > ..."). Each child filters by its own context.
  const selOrField = ['selection', 'editable'];
  add({ id: 'smartRewrite', title: 'Proofr', contexts: selOrField });
  for (const id of MENU_TOP) {
    const name = SR_getToneName(id);
    add({ id: `sr:${id}`, parentId: 'smartRewrite', contexts: sel, title: id === 'grammar' && shortcut ? `${name}  (${shortcut})` : name });
  }
  add({ id: 'srMore', parentId: 'smartRewrite', title: 'More', contexts: sel });
  for (const tone of SR_TONES.filter((t) => !MENU_TOP.includes(t.id))) {
    add({ id: `sr:${tone.id}`, parentId: 'srMore', title: tone.name, contexts: sel });
  }
  // Right-click in a text box with nothing selected (like Chrome's "Help me write").
  add({ id: 'srField:grammar', parentId: 'smartRewrite', title: 'Proofread this whole text box', contexts: ['editable'] });
  add({ id: 'separator1', parentId: 'smartRewrite', type: 'separator', contexts: selOrField });
  add({ id: 'openPanelWith', parentId: 'smartRewrite', title: 'Open in Proofr panel', contexts: sel });
  add({ id: 'openSettings', parentId: 'smartRewrite', title: 'Settings…', contexts: selOrField });

  // Plain page, nothing selected: a way into the panel.
  add({ id: 'openPanel', title: 'Open Proofr panel', contexts: ['page'] });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await buildContextMenus().catch((e) => console.warn('Context menu:', e?.message || e));

  await migrateKeysToLocal().catch((e) => console.warn('Key migration:', e?.message || e));

  // Versions up to 1.2.4 required access to every site; Chrome keeps that
  // grant across the update even though it's now optional. Give it back
  // unless the user has hover actions on (the only feature that uses it).
  if (details.reason === 'update') {
    await dropLegacyHostAccess().catch((e) => console.warn('Host access cleanup:', e?.message || e));
  }
  await syncHoverScripts().catch((e) => console.warn('Hover scripts:', e?.message || e));

  // First install: a welcome tab built around one real first proofread, the
  // pin prompt, and the setup the user's Chrome actually needs.
  if (details.reason === 'install') {
    chrome.tabs.create({ url: 'welcome.html' });
  }
});

chrome.runtime.onStartup.addListener(() => {
  // The shortcut shown in the menu can be rebound with no event to tell us,
  // so the menu is rebuilt each time Chrome starts.
  buildContextMenus().catch(() => {});
  migrateKeysToLocal().catch(() => {});
  syncHoverScripts().catch(() => {});
});

// Named (not an inline listener) so tests can drive it with a fake click.
chrome.contextMenus.onClicked.addListener((info, tab) => handleMenuClick(info, tab));

async function handleMenuClick(info, tab) {
  // sidePanel.open must run inside the click's user gesture, so it's called
  // before any await; the text to prefill follows through storage.
  if (info.menuItemId === 'openPanel' || info.menuItemId === 'openPanelWith') {
    chrome.sidePanel.open({ tabId: tab.id }).catch((e) => console.warn('Side panel:', e?.message || e));
    if (info.menuItemId === 'openPanelWith' && info.selectionText) {
      await chrome.storage.local.set({ srPanelPrefill: info.selectionText });
    }
    return;
  }

  if (info.menuItemId === 'srField:grammar') {
    try {
      const [{ result: field } = {}] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: selectWholeField });
      // A rich editor's whole content (Gmail: quoted thread, signature, links)
      // would come back as plain text, so only plain fields are replaced in place.
      await handleRewrite(tab.id, field && field.text, 'grammar', { ensure: true, noReplace: !(field && field.plain) });
    } catch (error) {
      console.warn('Proofr could not read this text box:', error?.message || error);
    }
    return;
  }

  if (info.menuItemId === 'openSettings') {
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch (error) {
      await ensureContentAssets(tab.id);
      inject(tab.id, showErrorMessage, ['Click the Proofr toolbar icon to open settings.']);
    }
    return;
  }

  if (typeof info.menuItemId === 'string' && info.menuItemId.startsWith('sr:')) {
    const tone = info.menuItemId.slice(3);
    await handleRewrite(tab.id, info.selectionText, tone, { ensure: true });
  }
}

// === Keyboard shortcut (manifest "commands", rebindable at chrome://extensions/shortcuts) ===
// Pages where Chrome never lets an extension run: its own pages, the Web
// Store (where a new user is when they install), other extensions' pages.
function isBlockedPage(url) {
  if (!url) return false;
  return /^(chrome|chrome-extension|chrome-untrusted|devtools|edge|about|view-source):/i.test(url)
    || /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url);
}

// Tell the user instead of failing silently: open the panel (still inside
// the shortcut's gesture when the page is known to be blocked) with a note,
// else flag the toolbar icon.
async function explainBlockedPage(tabId, gestureStillValid) {
  await chrome.storage.local.set({ srPanelNotice: 'Chrome doesn’t let extensions work on this page. Paste the text here instead.' });
  if (gestureStillValid) {
    chrome.sidePanel.open({ tabId }).catch(() => {});
    return;
  }
  chrome.action.setBadgeText({ tabId, text: '!' });
  chrome.action.setTitle({ tabId, title: 'Proofr can’t work on this page. Click to paste the text in the panel.' });
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'proofread-selection' || !tab || tab.id == null) return;
  if (isBlockedPage(tab.url)) { explainBlockedPage(tab.id, true); return; }
  try {
    const [{ result: text } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readSelectionText,
    });
    await handleRewrite(tab.id, text, 'grammar', { ensure: true });
  } catch (error) {
    console.warn('Proofr shortcut could not run on this page:', error?.message || error);
    explainBlockedPage(tab.id, false);
  }
});

// === Messages from page scripts ===
// Two shapes here: the fire-and-forget flow ("try another tone" in the
// modal) which drives the on-page modal directly via handleRewrite, and the
// request/response flow (hover reading actions) which hands the result back
// to the hover script so it can open it in the modal itself.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'rewriteWithTone') {
    handleRewrite(sender.tab.id, message.text, message.tone, { targetLang: message.targetLang });
    return false;
  }
  if (message.action === 'hoverRewrite') {
    handleHoverRewrite(message, sendResponse);
    return true; // async sendResponse
  }
  if (message.action === 'hoverAskAI') {
    handleHoverAskAI(message, sendResponse);
    return true; // async sendResponse
  }
  if (message.action === 'hasCloudKey') {
    CloudProvider.isReady().then((hasKey) => sendResponse({ hasKey }), () => sendResponse({ hasKey: false }));
    return true; // async sendResponse
  }
  return false;
});

// === Hover reading actions on a single hovered block ===
async function handleHoverRewrite(message, sendResponse) {
  try {
    const status = await aiStatus();
    const problem = setupProblem(status);
    if (problem) {
      sendResponse({ error: 'setup', title: problem.title, message: problem.message });
      return;
    }
    const { text, provider: providerId } = await rewriteNow(message.text, message.tone, status, message.targetLang);
    await StatsManager.updateStats(message.tone);
    sendResponse({ text, provider: providerId });
  } catch (error) {
    sendResponse({ error: 'failed', message: error.message || 'Something went wrong.' });
  }
}

// === Hover Ask: freeform instruction on a hovered block (cloud key) ===
async function handleHoverAskAI(message, sendResponse) {
  try {
    const provider = await CloudProvider.getConfig();
    if (!providerReady(provider)) {
      sendResponse({ error: 'setup', title: 'Set up Proofr', message: 'Connect an AI provider in the Proofr side panel to ask about text.' });
      return;
    }
    const text = await SR_askCloud(provider, message.text, message.instruction);
    await StatsManager.updateStats('ask');
    sendResponse({ text, provider: provider.id });
  } catch (error) {
    sendResponse({ error: 'failed', message: error.message || 'Something went wrong.' });
  }
}

// === Core flow: validate → capture target → loading → rewrite → result ===
async function handleRewrite(tabId, text, tone, { ensure = false, targetLang, noReplace = false } = {}) {
  try {
    // No content script runs by default, so the modal is injected on demand
    // (under the activeTab grant from the menu click or shortcut).
    if (ensure) await ensureContentAssets(tabId);

    if (!text || text.trim().length === 0) {
      inject(tabId, showErrorMessage, ['Select some text first, then choose a tone.']);
      return;
    }

    const status = await aiStatus();
    // Prefer the language the caller passed (avoids racing storage), else the saved default.
    const lang = targetLang || status.settings.targetLang;
    const problem = setupProblem(status);
    if (problem) {
      inject(tabId, showErrorMessage, [problem.message, problem.title]);
      return;
    }

    // Remember exactly where the selection was now, not when the result
    // arrives: the user may click elsewhere, or start another rewrite, during
    // a slow one. Each request keeps its own target, keyed by id.
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (!noReplace) await chrome.scripting.executeScript({ target: { tabId }, func: captureReplaceTarget, args: [text, requestId] });
    inject(tabId, showLoadingModal, [text, tone, lang]);

    const { text: rewritten, provider: providerId } = await rewriteNow(text, tone, status, lang);
    await StatsManager.updateStats(tone);

    inject(tabId, showRewriteResult, [text, rewritten, tone, providerId, lang, requestId]);
  } catch (error) {
    console.warn('Rewrite failed:', error?.message || error);
    let message = error.message || 'Something went wrong.';
    // On-device failures (too long, unsupported language, timeout) have a
    // cloud fallback the user may not know about.
    if (!(await CloudProvider.isReady()) && !/key|provider/i.test(message)) {
      message += ' Connecting an AI provider in the Proofr side panel handles longer text and more languages.';
    }
    inject(tabId, showErrorMessage, [message]);
  }
}

function inject(tabId, func, args) {
  chrome.scripting.executeScript({ target: { tabId }, func, args }).catch((error) => {
    console.warn('Could not show Proofr on this page:', error?.message || error);
  });
}

// Make sure the modal is on the page. Pages with hover actions on already
// have it from the registered scripts; constants.js can't be injected twice
// into the same world, so check first. Silently ignores pages that block
// injection (chrome:// pages, the Web Store).
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

// === Functions injected into the page ===
// Text fields keep their selection in selectionStart/End, which
// window.getSelection() doesn't report.
function readSelectionText() {
  const el = document.activeElement;
  if (el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|email|url|)$/i.test(el.type)))) {
    return el.value.slice(el.selectionStart, el.selectionEnd);
  }
  return String(window.getSelection() || '');
}

// "Proofread this text box": a plain field gets selected whole so the normal
// capture and in-place replace path handles it. A rich editor is only read.
function selectWholeField() {
  const el = document.activeElement;
  if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) {
    el.select();
    return { text: el.value, plain: true };
  }
  if (el && el.isContentEditable) return { text: el.innerText, plain: false };
  return { text: '', plain: false };
}

function captureReplaceTarget(originalText, requestId) {
  const el = document.activeElement;
  const targets = window.__srTargets || (window.__srTargets = new Map());
  if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') && el.selectionStart !== el.selectionEnd) {
    targets.set(requestId, { kind: 'field', el, start: el.selectionStart, end: el.selectionEnd, original: originalText });
    return;
  }
  const sel = window.getSelection();
  if (el && el.isContentEditable && sel && sel.rangeCount > 0 && !sel.isCollapsed) {
    targets.set(requestId, { kind: 'editable', el, range: sel.getRangeAt(0).cloneRange(), original: originalText });
  }
}

function showErrorMessage(message, title) {
  if (window.SmartRewriteModal) {
    window.SmartRewriteModal.showError(message, title ? { title } : undefined);
  } else {
    alert('Proofr: ' + message);
  }
}

function showLoadingModal(originalText, tone, targetLang) {
  if (window.SmartRewriteModal) {
    window.SmartRewriteModal.showLoading(originalText, tone, targetLang);
  }
}

// Replaces the captured selection through the browser's own editing command,
// so the page's editor (React, Lexical, ProseMirror…) sees a normal input
// event and Ctrl+Z restores the original. Only replaces when the captured
// text is still there; otherwise the result opens in the modal instead.
function showRewriteResult(originalText, rewrittenText, tone, provider, targetLang, requestId) {
  const targets = window.__srTargets;
  const target = targets && targets.get(requestId);
  if (targets) targets.delete(requestId);
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  let replaced = false;
  let undoable = false;

  try {
    if (target && target.kind === 'field' && target.el.isConnected
        && norm(target.el.value.slice(target.start, target.end)) === norm(target.original)) {
      target.el.focus();
      target.el.setSelectionRange(target.start, target.end);
      undoable = replaced = document.execCommand('insertText', false, rewrittenText);
      if (!replaced) {
        // Not undoable, so the toast below doesn't promise undo for this path.
        target.el.setRangeText(rewrittenText, target.start, target.end, 'end');
        target.el.dispatchEvent(new Event('input', { bubbles: true }));
        replaced = true;
      }
    } else if (target && target.kind === 'editable' && target.el.isConnected
        && target.range.startContainer.isConnected
        && norm(target.range.toString()) === norm(target.original)) {
      target.el.focus();
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(target.range);
      undoable = replaced = document.execCommand('insertText', false, rewrittenText);
    }
  } catch (_) {
    replaced = false;
  }

  if (replaced) {
    if (window.SmartRewriteModal) {
      const undoKey = /Mac/i.test(navigator.platform) ? '⌘Z' : 'Ctrl+Z';
      // Proofread says how much it fixed, so "nothing changed" is visible too.
      const ops = (tone === 'grammar' && typeof SR_wordDiff === 'function') ? SR_wordDiff(originalText, rewrittenText) : null;
      const fixes = ops && typeof SR_diffCount === 'function' ? SR_diffCount(ops) : null;
      const what = fixes === 0 ? 'No changes needed.' : fixes ? `Fixed ${fixes} thing${fixes === 1 ? '' : 's'}.` : 'Text replaced.';
      window.SmartRewriteModal.showSuccess(undoable && fixes !== 0 ? `${what} ${undoKey} to undo.` : what);
    }
    return;
  }

  if (window.SmartRewriteModal) {
    window.SmartRewriteModal.showResult(originalText, rewrittenText, tone, provider, targetLang);
  } else {
    navigator.clipboard.writeText(rewrittenText)
      .then(() => alert('Rewritten text copied to clipboard:\n\n' + rewrittenText))
      .catch(() => alert('Rewritten text:\n\n' + rewrittenText));
  }
}
