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
      chrome.storage.sync.get([modelField, 'srCustomEndpoints', 'srCloudCustomBaseURL']),
      chrome.storage.local.get([keyField, 'groqAPIKey']),
    ]);
    // Legacy single-key storage (pre-multi-provider) — carries an already-saved Groq key forward.
    const apiKey = keys[keyField] || (id === 'groq' ? (keys.groqAPIKey || '') : '');
    const custom = SR_isCustomId(id) ? (SR_customEndpoints(r).find((c) => c.id === id) || { baseURL: '' }) : null;
    const baseURL = custom ? custom.baseURL : meta.baseURL;
    const displayName = custom ? SR_customDisplayName(custom) : meta.name;
    const model = r[modelField] || meta.defaultModel || '';
    // Local servers (Ollama, LM Studio, a custom localhost URL) take no key.
    // Presets for local servers (Ollama, LM Studio) take no key at all. A custom
    // endpoint on this computer may or may not want one (LiteLLM does), so
    // there the key is optional rather than hidden, as in lasso's form.
    const keyless = !!meta.keyless;
    const keyOptional = keyless || (typeof SR_isLocalURL === 'function' && SR_isLocalURL(baseURL));
    return { id, displayName, baseURL, model, apiKey, keyless, keyOptional };
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

// Same per-day counts as sidepanel.js SR_bumpDay (last 14 days).
function bumpDay(days) {
  const out = { ...(days || {}) };
  const today = new Date().toISOString().slice(0, 10);
  out[today] = (out[today] || 0) + 1;
  const cutoff = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
  for (const d of Object.keys(out)) if (d < cutoff) delete out[d];
  return out;
}

// === Progress: corrected word pairs only, never sentences ===
// Proofreads of the user's own writing (a text box, or the side panel) feed
// a local tally for the Progress tab: which words get fixed, and which they
// now get right. Writes are chained so two results landing together can't
// overwrite each other's update. Resolves to the words this proofread
// mastered (for the toast), or [].
// One line from Progress, at most once a week (SR_weeklyLine). Marked shown
// here, so a line is never repeated even if that note is missed.
async function weeklyLine() {
  try {
    const { srInsightsOn } = await chrome.storage.sync.get(['srInsightsOn']);
    if (srInsightsOn === false) return null;
    const { srInsights, srWeekLineAt } = await chrome.storage.local.get(['srInsights', 'srWeekLineAt']);
    const line = SR_weeklyLine(SR_insightsView(srInsights), srWeekLineAt);
    if (line) await chrome.storage.local.set({ srWeekLineAt: Date.now() });
    return line;
  } catch (_) {
    return null;
  }
}

let insightsQueue = Promise.resolve();
// rulesOnly: Proofr's own rules made every change, so they're the writer's
// mistakes for sure and the change guard (which watches the AI) doesn't apply.
function recordInsights(before, after, rulesOnly = false) {
  const run = insightsQueue.then(async () => {
    if (typeof SR_extractCorrections !== 'function' || typeof SR_mergeInsights !== 'function') return [];
    const { srInsightsOn } = await chrome.storage.sync.get(['srInsightsOn']);
    if (srInsightsOn === false) return [];
    // Every proofread counts, even a clean one: words with no fixes are what
    // brings "mistakes per 100 words" down. Fixes are counted from the full
    // diff, not the stored pairs, so pairs dropped for privacy (names,
    // numbers) don't read as fewer mistakes.
    // A result the change guard flagged rewrote more than it fixed; learning
    // from it would teach the model's mistakes, not the user's.
    if (!rulesOnly && typeof SR_changeGuard === 'function' && !SR_changeGuard(before, after).ok) return [];
    const pairs = SR_extractCorrections(before, after);
    const words = (String(before).match(/[\p{L}\p{N}]+/gu) || []).length;
    const ops = SR_wordDiffForDisplay(before, after, 'grammar');
    const fixes = ops ? SR_diffCount(ops) : pairs.length;
    const { srInsights } = await chrome.storage.local.get(['srInsights']);
    // `before` lets the merge see words the user already got right.
    const next = SR_mergeInsights(srInsights, pairs, Date.now(), words, fixes, before);
    await chrome.storage.local.set({ srInsights: next });
    return typeof SR_newlyMastered === 'function' ? SR_newlyMastered(srInsights, next) : [];
  }).catch((e) => { console.warn('Insights:', e?.message || e); return []; });
  insightsQueue = run;
  return run;
}

class StatsManager {
  static async getStats() {
    const result = await chrome.storage.local.get(['rewriteStats']);
    return result.rewriteStats || { totalRewrites: 0, styleUsage: {}, lastUsed: null };
  }

  static async updateStats(style) {
    const stats = await this.getStats();
    stats.totalRewrites++;
    stats.days = bumpDay(stats.days);
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
  // Settings sync between computers: "On-device" picked on one that has
  // Chrome's AI acts as Auto on one that can't run it (the saved choice stays).
  if (settings.engine === 'device' && availability === 'unavailable') settings.engine = 'auto';
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
      : { title, message: 'Connect an AI provider in the Proofr side panel to use this.' };
  }
  if (!deviceNow && !hasKey) {
    return deviceNeedsSetup
      ? { title, message: 'On-device AI needs a one-time setup. Click the Proofr toolbar icon and choose "Set up on-device AI", or connect an AI provider there instead.' }
      : { title, message: 'This needs an AI. Click the Proofr toolbar icon and connect a provider: Groq has a free tier, and Ollama or LM Studio run on your computer with no key. Proofread works without one.' };
  }
  return null;
}

// Where the text went, and which model answered: "Sent to Groq · gpt-oss-120b".
// A server on the user's own machine or network isn't "sent" anywhere they'd
// worry about: "Local · <model>".
function whereLabel(providerId, cfg, engine) {
  if (providerId === 'device') return `On this computer · ${engine || 'Gemini Nano'}`;
  // "openai/gpt-oss-120b" → "gpt-oss-120b": the vendor is already in the provider name.
  const model = cfg && cfg.model ? ` · ${String(cfg.model).split('/').pop()}` : '';
  if (cfg && typeof SR_isLocalURL === 'function' && SR_isLocalURL(cfg.baseURL)) return `Local${model}`;
  return `Sent to ${SR_providerDisplayLabel(providerId, cfg && cfg.displayName)}${model}`;
}

// Rewrite with whatever is ready: on-device only when already downloaded,
// otherwise the cloud key.
async function rewriteNow(text, tone, status, targetLang, onToken, signal) {
  const engine = (status.settings.engine === 'auto' && !status.deviceNow) ? 'cloud' : status.settings.engine;
  const result = await SR_rewriteAuto(text, tone, { provider: status.provider, engine, targetLang, onToken, signal });
  if (result.provider === 'device') keepDeviceWarm();
  return result;
}

// Chrome stops an idle extension background after ~30s, and with it the
// on-device base sessions (constants.js), so the next proofread would start
// cold. Extension API calls count as activity (Chrome 110+): while a base
// session exists, one cheap call every 25s keeps them for up to
// DEVICE_WARM_MS after the last on-device use. Checked by test/e2e-ui.mjs.
const DEVICE_WARM_MS = 5 * 60 * 1000;
let deviceWarmUntil = 0;
let deviceWarmTimer = null;
function keepDeviceWarm() {
  deviceWarmUntil = Date.now() + DEVICE_WARM_MS;
  if (deviceWarmTimer) return;
  deviceWarmTimer = setInterval(() => {
    if (Date.now() > deviceWarmUntil) {
      clearInterval(deviceWarmTimer);
      deviceWarmTimer = null;
      if (typeof SR_dropAllBases === 'function') SR_dropAllBases(); // free the model's memory
      return;
    }
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 25000);
}

// Clicking the toolbar icon opens the side panel directly (replaces the old popup).
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
    console.warn('Could not set side panel behavior:', error?.message || error);
  });
}

// === Page scripts: registered only while the user has a page feature on ===
// No content script runs on any page by default. Turning on "Hover actions" or
// "Check as I type" in the side panel requests host access (a user gesture
// there); this keeps one registration in step with those settings and that
// permission. One registration, not two: constants.js declares top-level
// names and must load once per page.
const HOVER_SCRIPT_ID = 'proofr-hover'; // the id older versions registered
function pageScript({ hover, live }) {
  return {
    id: HOVER_SCRIPT_ID,
    matches: ['<all_urls>'],
    js: ['constants.js', 'theme.js', ...(hover ? ['dom-scan.js', 'hover-assist.js'] : []), ...(live ? ['write-back.js', 'live-check.js'] : []), 'content.js'],
    css: ['modal.css'],
    runAt: 'document_end',
  };
}
// Frames get a small loader instead; it asks for the checker (below) once a
// text box in that frame gets focus. matchOriginAsFallback reaches frames with
// no address of their own (about:blank, srcdoc), like a "Try it" result.
const LIVE_FRAMES_ID = 'proofr-live-frames';
const LIVE_FRAMES_SCRIPT = { id: LIVE_FRAMES_ID, matches: ['<all_urls>'], js: ['live-frame.js'], allFrames: true, matchOriginAsFallback: true, runAt: 'document_end' };
const LIVE_FILES = ['write-back.js', 'live-check.js'];
async function addLiveCheckToFrame(tabId, frameId) {
  const target = { tabId, frameIds: [frameId] };
  const [{ result } = {}] = await chrome.scripting.executeScript({ target, func: () => ({ live: !!self.SR_LIVE, base: typeof SR_ruleCheck === 'function' }) });
  if (!result || result.live) return;
  await chrome.scripting.executeScript({ target, files: [...(result.base ? [] : ['constants.js', 'theme.js']), ...LIVE_FILES] });
}

// A page feature on means host access is in use.
async function pageFeaturesOn() {
  const { srHoverAssist, srLiveCheck } = await chrome.storage.sync.get(['srHoverAssist', 'srLiveCheck']);
  return { hover: !!srHoverAssist, live: !!srLiveCheck };
}

// One at a time: turning a feature on fires both permissions.onAdded and the
// storage change, and two overlapping runs both see "not registered" and
// both register ("Duplicate script ID"). Each run waits for the last.
let hoverSync = Promise.resolve();
function syncHoverScripts() {
  hoverSync = hoverSync.catch(() => {}).then(syncHoverScriptsNow);
  return hoverSync;
}
async function syncHoverScriptsNow() {
  const [features, granted, registered] = await Promise.all([
    pageFeaturesOn(),
    chrome.permissions.contains({ origins: ['<all_urls>'] }),
    chrome.scripting.getRegisteredContentScripts({ ids: [HOVER_SCRIPT_ID] }),
  ]);
  const want = (features.hover || features.live) && granted;
  const script = pageScript(features);
  if (want && registered.length === 0) {
    await chrome.scripting.registerContentScripts([script]);
  } else if (want && (registered[0].js || []).join() !== script.js.join()) {
    // A feature turned on or off, or a registration from an older version.
    await chrome.scripting.updateContentScripts([script]);
  } else if (!want && registered.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: [HOVER_SCRIPT_ID] });
  }
  const frames = await chrome.scripting.getRegisteredContentScripts({ ids: [LIVE_FRAMES_ID] });
  const wantFrames = features.live && granted;
  if (wantFrames && !frames.length) await chrome.scripting.registerContentScripts([LIVE_FRAMES_SCRIPT]);
  else if (!wantFrames && frames.length) await chrome.scripting.unregisterContentScripts({ ids: [LIVE_FRAMES_ID] });
  // Access revoked from Chrome's own UI: reflect it in the switches.
  if ((features.hover || features.live) && !granted) await chrome.storage.sync.set({ srHoverAssist: false, srLiveCheck: false });
}

// Turned on with tabs already open: those pages get the checker now, not on
// their next load. A page that already has Proofr's files gets only the new ones.
async function addLiveCheckToOpenTabs() {
  if (!(await chrome.permissions.contains({ origins: ['<all_urls>'] }))) return;
  const tabs = (await chrome.tabs.query({})).filter((t) => /^https?:/.test(t.url || '')); // web pages only
  await Promise.all(tabs.map(async (tab) => {
    try {
      const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => ({ live: !!self.SR_LIVE, base: typeof SR_ruleCheck === 'function' }) });
      if (!result || result.live) return;
      const files = [...(result.base ? [] : ['constants.js', 'theme.js']), ...LIVE_FILES];
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files });
      // Its frames get the loader, as a fresh page's would.
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['live-frame.js'] }).catch(() => {});
    } catch (_) { /* a page Chrome keeps extensions out of */ }
  }));
}

async function dropLegacyHostAccess() {
  const { hover, live } = await pageFeaturesOn();
  if (hover || live) return;
  const { origins = [] } = await chrome.permissions.getAll();
  // Only origins in optional_host_permissions can be removed; the old
  // api.groq.com grant isn't declared anymore, so it's left to Chrome.
  if (origins.includes('<all_urls>')) await chrome.permissions.remove({ origins: ['<all_urls>'] });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes.srHoverAssist || changes.srLiveCheck)) syncHoverScripts().catch((e) => console.warn('Hover scripts:', e?.message || e));
  if (area === 'sync' && changes.srLiveCheck && changes.srLiveCheck.newValue) addLiveCheckToOpenTabs().catch(() => {});
});
chrome.permissions.onRemoved.addListener(() => { syncHoverScripts().catch(() => {}); });
chrome.permissions.onAdded.addListener(() => { syncHoverScripts().catch(() => {}); });

// === Install / update ===
// === Context menu ===
// The six modes people reach for most sit at the top; the rest are one level
// down under "More" so the menu scans quickly. The first item shows the real
// shortcut (blank if Chrome couldn't assign Alt+Shift+P on this machine).
// Shared with the store screenshot replica (store/screenshots.html) so the two can't drift.
const MENU_TOP = SR_MENU_TOP;

async function shortcutLabel() {
  const commands = await chrome.commands.getAll().catch(() => []);
  const cmd = commands.find((c) => c.name === 'proofread-selection');
  return cmd && cmd.shortcut ? cmd.shortcut : '';
}

// Builds run one at a time. Install and startup can fire together (an update
// applied when Chrome starts); overlapping builds would both clear the menu
// first, then both add every item, and the second set fails as duplicates.
let menuBuild = Promise.resolve();
function buildContextMenus() {
  menuBuild = menuBuild.catch(() => {}).then(buildContextMenusNow);
  return menuBuild;
}

async function buildContextMenusNow() {
  const shortcut = await shortcutLabel();
  // The School setting: Proofread only, no rewriting tones.
  const school = (await chrome.storage.sync.get(['srSchool'])).srSchool === true;
  await chrome.contextMenus.removeAll();
  const add = (props) => chrome.contextMenus.create(props, () => {
    if (chrome.runtime.lastError) console.warn('Context menu:', chrome.runtime.lastError.message);
  });
  const sel = ['selection'];

  // School: Proofread is the only action, so it's one top-level item instead
  // of a submenu: right-click, then click. With nothing selected it proofreads
  // the whole text box. Settings and the panel stay on the toolbar icon.
  if (school) {
    add({ id: 'srOne:grammar', title: `Proofread with Proofr${shortcut ? `  (${shortcut})` : ''}`, contexts: ['selection', 'editable'] });
    add({ id: 'openPanel', title: 'Open Proofr panel', contexts: ['page'] });
    return;
  }

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

// After removal, Chrome opens a page asking why, with one tap to an email
// draft. Only the version is in the link. Set on every start, so it always
// names the version installed.
try {
  chrome.runtime.setUninstallURL(`https://civarry.github.io/proofr/goodbye.html?v=${chrome.runtime.getManifest().version}`);
} catch (_) { /* not available in this context */ }

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

// Turning the School setting on or off changes what the menu offers.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && 'srSchool' in changes) buildContextMenus().catch(() => {});
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

  if (info.menuItemId === 'srOne:grammar' && info.selectionText && info.selectionText.trim()) {
    await handleRewrite(tab.id, info.selectionText, 'grammar', { ensure: true, frameId: info.frameId || 0 });
    return;
  }
  if (info.menuItemId === 'srField:grammar' || info.menuItemId === 'srOne:grammar') {
    try {
      await proofreadWholeBox(tab.id, info.frameId || 0);
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
    await handleRewrite(tab.id, info.selectionText, tone, { ensure: true, frameId: info.frameId || 0 });
  }
}

// Nothing selected: the whole text box the cursor is in. Plain text and plain
// lines are replaced in place; a rich box's links, lists or quoted email would
// come back as plain text, so that result opens in the dialog, which says why.
async function proofreadWholeBox(tabId, frameId) {
  await injectWriteBack(tabId, frameId);
  const [{ result: field } = {}] = await chrome.scripting.executeScript({ target: frameTarget(tabId, frameId), func: () => self.SR_WB.selectWhole() });
  const rich = !!(field && field.text && !field.plain);
  await handleRewrite(tabId, field && field.text, 'grammar', { ensure: true, noReplace: !(field && field.plain), frameId, richBox: rich, wholeBox: true });
}

// The shortcut: the selection may be in any frame. The focused one wins, since
// other frames can keep an old selection.
async function runProofreadShortcut(tab) {
  const frames = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: readSelectionText });
  const read = frames.map((f) => ({ frameId: f.frameId, ...(f.result || {}) }));
  const focused = read.find((f) => f.focused);
  const picked = (focused && focused.text.trim()) ? focused : read.find((f) => f.text && f.text.trim());
  if (picked) { await handleRewrite(tab.id, picked.text, 'grammar', { ensure: true, frameId: picked.frameId }); return; }
  await proofreadWholeBox(tab.id, focused ? focused.frameId : 0);
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

// Hover actions on and off from the keyboard, so the icon never gets in the
// way. A pause, not the Settings switch: switching off gives up page access,
// and only a click in the side panel can ask for it back. Paused, the page
// scripts stay but show nothing, on every tab at once (srHoverPaused).
async function toggleHoverPause(tab) {
  const { srHoverAssist, srHoverPaused } = await chrome.storage.sync.get(['srHoverAssist', 'srHoverPaused']);
  const cmd = (await chrome.commands.getAll().catch(() => [])).find((c) => c.name === 'toggle-hover');
  const keys = cmd && cmd.shortcut ? cmd.shortcut : 'The shortcut';
  let message;
  if (!srHoverAssist) {
    message = 'Hover actions are off. Turn them on in Proofr’s settings, under On web pages.';
  } else {
    const paused = !srHoverPaused;
    await chrome.storage.sync.set({ srHoverPaused: paused });
    message = paused ? `Hover actions paused. ${keys} turns them back on.` : `Hover actions on. ${keys} pauses them.`;
  }
  if (tab && tab.id != null && !isBlockedPage(tab.url)) {
    await ensureContentAssets(tab.id);
    inject(tab.id, showHoverNote, [message]);
  }
  return message;
}

function showHoverNote(message) {
  if (window.SmartRewriteModal) window.SmartRewriteModal.showSuccess(message);
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'toggle-hover') { await toggleHoverPause(tab); return; }
  if (!tab || tab.id == null) return;
  if (command === 'review-last') {
    if (isBlockedPage(tab.url)) return;
    await ensureContentAssets(tab.id);
    inject(tab.id, reviewLast, []);
    return;
  }
  if (command !== 'proofread-selection') return;
  if (isBlockedPage(tab.url)) { explainBlockedPage(tab.id, true); return; }
  try {
    await runProofreadShortcut(tab);
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
    handleRewrite(sender.tab.id, message.text, message.tone, { targetLang: message.targetLang, engine: message.engine, frameId: message.frameId || 0 });
    return false;
  }
  // The dialog is in the top page; a box in a frame is written from that frame.
  if (message.action === 'targetOp') {
    if (!sender.tab || !['insert', 'undo', 'applyAccepted'].includes(message.op)) return false;
    chrome.scripting.executeScript({
      target: frameTarget(sender.tab.id, message.frameId),
      func: (op, id, args) => self.SR_WB[op](id, ...args),
      args: [message.op, message.requestId, message.args],
    }).then(([r]) => sendResponse(r && r.result), () => sendResponse(null));
    return true; // async sendResponse
  }
  if (message.action === 'stopRewrite') {
    const controller = activeRewrites.get(message.requestId);
    if (controller) controller.abort();
    return false;
  }
  // Check as I type: the handle beside the box proofreads it whole, the same
  // way as the shortcut with nothing selected (rules, then AI if set up).
  if (message.action === 'liveFrameNeeded' && sender.tab && sender.frameId) {
    chrome.storage.sync.get(['srLiveCheck']).then(({ srLiveCheck }) => srLiveCheck && addLiveCheckToFrame(sender.tab.id, sender.frameId))
      .catch((e) => console.warn('Check as I type:', e?.message || e));
    return false;
  }
  if (message.action === 'liveProofreadBox' && sender.tab) {
    proofreadWholeBox(sender.tab.id, sender.frameId || 0).catch((e) => console.warn('Proofr could not read this text box:', e?.message || e));
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
  // The side panel's Proofreads go through the same write queue as the
  // page's. Only extension pages may write here, never a content script.
  if (message.action === 'recordInsights') {
    if (sender.tab || !String(sender.url || '').startsWith(chrome.runtime.getURL(''))) return false;
    recordInsights(String(message.before || ''), String(message.after || ''), message.rulesOnly === true).then((mastered) => sendResponse({ ok: true, mastered }));
    return true; // async sendResponse
  }
  // The hover menu shows its Ask box whenever some AI can answer.
  if (message.action === 'askReady') {
    aiStatus().then((status) => sendResponse({ ready: !setupProblem(status) }), () => sendResponse({ ready: false }));
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
    const { text, provider: providerId, engine } = await rewriteNow(message.text, message.tone, status, message.targetLang);
    await StatsManager.updateStats(message.tone);
    sendResponse({ text, provider: providerId, where: whereLabel(providerId, status.provider, engine) });
  } catch (error) {
    sendResponse({ error: 'failed', message: error.message || 'Something went wrong.' });
  }
}

// === Hover Ask: freeform instruction on a hovered block ===
// Same engine rules as the other hover actions: on-device AI or a provider.
async function handleHoverAskAI(message, sendResponse) {
  try {
    const status = await aiStatus();
    const problem = setupProblem(status);
    if (problem) {
      sendResponse({ error: 'setup', title: problem.title, message: problem.message });
      return;
    }
    const engine = (status.settings.engine === 'auto' && !status.deviceNow) ? 'cloud' : status.settings.engine;
    const { text, provider: providerId, engine: engineName } = await SR_askAuto(message.text, message.instruction, { provider: status.provider, engine });
    await StatsManager.updateStats('ask');
    sendResponse({ text, provider: providerId, where: whereLabel(providerId, status.provider, engineName) });
  } catch (error) {
    sendResponse({ error: 'failed', message: error.message || 'Something went wrong.' });
  }
}

// === Core flow: validate → capture target → loading → rewrite → result ===
// Rewrites in flight, by request id, so the toast's Stop (or Esc) can end one.
const activeRewrites = new Map();

async function handleRewrite(tabId, text, tone, { ensure = false, targetLang, noReplace = false, engine: forceEngine, frameId = 0, richBox = false, wholeBox = false } = {}) {
  let requestId = null;
  let usedDevice = false;
  try {
    // No content script runs by default, so the modal is injected on demand
    // (under the activeTab grant from the menu click or shortcut).
    if (ensure) await ensureContentAssets(tabId);

    if (!text || text.trim().length === 0) {
      inject(tabId, showErrorMessage, ['Select some text first, then choose a tone.', null, { light: true }]);
      return;
    }

    const status = await aiStatus();
    if (forceEngine) status.settings = { ...status.settings, engine: forceEngine };
    // Prefer the language the caller passed (avoids racing storage), else the saved default.
    const lang = targetLang || status.settings.targetLang;
    const problem = setupProblem(status);
    // The School setting fixes mistakes only: no rewriting, summaries or translations.
    const school = (await chrome.storage.sync.get(['srSchool'])).srSchool === true;
    if (school && tone !== 'grammar') {
      inject(tabId, showErrorMessage, ['The School setting is on, so Proofr only fixes mistakes. Turn it off in the Proofr side panel to rewrite.', 'Proofread only']);
      return;
    }
    // A Proofread never needs AI: with none set up, Proofr's own rules run alone.
    const rulesOnly = !!problem && tone === 'grammar';
    if (problem && !rulesOnly) {
      inject(tabId, showErrorMessage, [problem.message, problem.title]);
      return;
    }

    // Remember exactly where the selection was now, not when the result
    // arrives: the user may click elsewhere, or start another rewrite, during
    // a slow one. Each request keeps its own target, keyed by id.
    requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const controller = new AbortController();
    activeRewrites.set(requestId, controller);
    // Only the user's own writing teaches Progress: a text box (the selection
    // is in one, or the whole box was read), never text selected on a page,
    // which someone else wrote.
    let ownText = noReplace;
    let target = null;
    if (!noReplace) {
      target = await captureTarget(tabId, frameId, requestId, text);
      ownText = !!target;
    }
    const onDevice = !rulesOnly && (status.settings.engine === 'device' || (status.settings.engine === 'auto' && status.deviceNow));
    // Rules alone answer in milliseconds: no "working" toast to flash.
    if (!rulesOnly) inject(tabId, showLoadingModal, [text, tone, lang, requestId, onDevice, !!target, school]);

    // On-device answers stream; show them arriving in the dialog instead of a
    // long skeleton. Throttled: each update is a script injection.
    let lastPush = 0;
    const onToken = (soFar) => {
      const now = Date.now();
      if (now - lastPush < 150) return;
      lastPush = now;
      inject(tabId, streamPartial, [soFar]);
    };
    usedDevice = onDevice;
    // Coach mode marks mistakes without showing fixes, so a streamed answer
    // (which is the fix) must not appear while it runs.
    const coach = tone === 'grammar' && (await chrome.storage.sync.get(['srCoach'])).srCoach === true;
    let rewritten, providerId, engine, rules = null;
    if (tone === 'grammar') {
      // Rules first, then the AI (when one is ready), then the rules again.
      const res = await SR_proofreadHybrid(text, {
        school,
        atStart: wholeBox, // a selection may start mid-sentence; a whole box can't
        runAI: rulesOnly ? null : (t) => rewriteNow(t, tone, status, lang, coach ? null : onToken, controller.signal),
      });
      rewritten = res.text;
      providerId = res.ai ? res.ai.provider : 'rules';
      engine = res.ai && res.ai.engine;
      rules = { count: res.ruleCount, hits: res.hits, hints: res.hints, only: !res.ai, school, base: res.base };
    } else {
      ({ text: rewritten, provider: providerId, engine } = await rewriteNow(text, tone, status, lang, coach ? null : onToken, controller.signal));
    }
    await StatsManager.updateStats(tone);
    // Local storage only, a few ms: awaited so a word mastered by this very
    // proofread can be named in its toast.
    const mastered = tone === 'grammar' && ownText ? await recordInsights(text, rewritten, !!(rules && rules.only)) : [];
    // Only when the text can go in place: the dialog path has no note to carry it.
    const week = tone === 'grammar' && ownText && target && !coach ? await weeklyLine() : null;

    const where = providerId === 'rules' ? SR_RULES_LABEL : whereLabel(providerId, status.provider, engine);
    inject(tabId, showRewriteResult, [text, rewritten, tone, providerId, lang, requestId, where, coach, mastered, target, richBox, week, rules]);
  } catch (error) {
    // Stopped from the toast: it already says "Stopped.", so add nothing.
    if (error && error.name === 'AbortError') return;
    console.warn('Rewrite failed:', error?.message || error);
    let message = error.message || 'Something went wrong.';
    const cloud = await CloudProvider.getConfig();
    const cloudReady = providerReady(cloud);
    // On-device failures (too long, unsupported language, timeout) have a
    // cloud fallback the user may not know about.
    if (!cloudReady && error.name !== 'SuspectOutput' && !/key|provider/i.test(message)) {
      message += ' Connecting an AI provider in the Proofr side panel handles longer text and more languages.';
    }
    // Every model error can be retried in place; an on-device failure can go
    // straight to the connected cloud provider instead.
    const retry = { text, tone, targetLang, frameId, label: 'Try again' };
    const alternative = usedDevice && cloudReady ? { text, tone, targetLang, frameId, engine: 'cloud', label: `Use ${cloud.displayName} instead` } : null;
    const title = error.name === 'SuspectOutput' ? 'Proofr didn\'t use that answer' : null;
    inject(tabId, showErrorMessage, [message, title, { retry, alternative }]);
  } finally {
    if (requestId) activeRewrites.delete(requestId);
  }
}

function inject(tabId, func, args) {
  chrome.scripting.executeScript({ target: { tabId }, func, args }).catch((error) => {
    console.warn('Could not show Proofr on this page:', error?.message || error);
  });
}

function frameTarget(tabId, frameId) {
  return frameId ? { tabId, frameIds: [frameId] } : { tabId };
}

async function injectWriteBack(tabId, frameId) {
  await chrome.scripting.executeScript({ target: frameTarget(tabId, frameId), files: ['write-back.js'] });
}

// Where the result can go back to: { frameId }, or null for page text. A frame
// Proofr can't reach (another site's, under the one-tab grant) ends up in the
// dialog, with Copy.
async function captureTarget(tabId, frameId, requestId, text) {
  try {
    await injectWriteBack(tabId, frameId);
    const [r] = await chrome.scripting.executeScript({
      target: frameTarget(tabId, frameId),
      func: (id, original) => self.SR_WB.capture(id, original),
      args: [requestId, text],
    });
    return r && r.result ? { frameId } : null;
  } catch (error) {
    console.warn('Proofr can\'t reach this text box:', error?.message || error);
    return null;
  }
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
    await chrome.scripting.executeScript({ target: { tabId }, files: ['constants.js', 'theme.js', 'content.js'] });
  } catch (error) {
    console.warn('Could not inject Proofr into this page:', error?.message || error);
  }
}

// === Functions injected into the page ===
// Text fields keep their selection in selectionStart/End, which
// window.getSelection() doesn't report, and a web component keeps its own.
function readSelectionText() {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  const focused = document.hasFocus();
  if (el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|email|url|)$/i.test(el.type)))) {
    return { text: el.value.slice(el.selectionStart, el.selectionEnd), focused };
  }
  const root = el && el.getRootNode();
  const sel = root && root.getSelection ? root.getSelection() : window.getSelection();
  return { text: String(sel || ''), focused };
}

// `actions.retry` / `actions.alternative` arrive as plain data (injected
// arguments are serialized) and become buttons that re-run the request.
function showErrorMessage(message, title, actions) {
  if (!window.SmartRewriteModal) { alert('Proofr: ' + message); return; }
  const opts = {};
  if (title) opts.title = title;
  if (actions && actions.light) opts.light = true;
  const rerun = (a) => a && { label: a.label, run: () => {
    chrome.runtime.sendMessage({ action: 'rewriteWithTone', text: a.text, tone: a.tone, targetLang: a.targetLang, engine: a.engine, frameId: a.frameId });
    return true;
  } };
  if (actions && actions.retry) opts.retry = rerun(actions.retry);
  if (actions && actions.alternative) opts.alternative = rerun(actions.alternative);
  window.SmartRewriteModal.showError(message, opts);
}

// The keyboard way back to the last result on this page (the toast may be
// gone, and focus stays in the text box, so Review isn't reachable by Tab).
function reviewLast() {
  if (!window.SmartRewriteModal) return;
  if (window.__srLastReview && window.SmartRewriteModal.showReview) window.SmartRewriteModal.showReview(window.__srLastReview);
  else window.SmartRewriteModal.showError('Nothing to review on this page yet.', { light: true });
}

function streamPartial(soFar) {
  if (window.SmartRewriteModal && window.SmartRewriteModal.streamText) window.SmartRewriteModal.streamText(soFar);
}

function showLoadingModal(originalText, tone, targetLang, requestId, onDevice, inPlace, school) {
  if (window.SmartRewriteModal) {
    window.SmartRewriteModal.school = !!school;
    window.SmartRewriteModal.showLoading(originalText, tone, targetLang, { requestId, onDevice, inPlace });
  }
}

// Puts the result back through write-back.js, in the frame that holds the box.
// If the captured text is gone, the result opens in the modal instead.
async function showRewriteResult(originalText, rewrittenText, tone, provider, targetLang, requestId, where, coach, mastered, target, richBox, week, rules) {
  let replaced = false;
  if (window.SmartRewriteModal) window.SmartRewriteModal.school = !!(rules && rules.school);
  // Every Review of this result explains rule fixes and offers the School
  // suggestions (off until clicked; the text box gets them only through Apply).
  const extra = rules ? { reasons: rules.hits || [], hints: rules.hints || [] } : {};
  const inFrame = !!(target && target.frameId);
  // Which box has focus now? In a frame, the top page knows if focus left it.
  const movedOnFrom = async () => {
    if (!inFrame) return self.SR_WB.movedOn(requestId);
    const a = document.activeElement;
    return !!a && a !== document.body && a.tagName !== 'IFRAME' && !(a.closest && a.closest('#smart-rewrite-modal, #sr-toast'));
  };
  const op = (name, ...args) => (inFrame
    ? chrome.runtime.sendMessage({ action: 'targetOp', op: name, frameId: target.frameId, requestId, args })
    : self.SR_WB[name](requestId, ...args));
  const insertInto = (text) => op('insert', text);
  const insertSafely = async (text) => { try { return !!(await insertInto(text)); } catch (_) { return false; } };

  // Proofread must keep the meaning; every other mode must add nothing the
  // author didn't write (a link or number an instruction hidden in the text asked for).
  // The guard watches the AI. Proofr's own rules are sure fixes, so a result
  // from the rules alone isn't held back, and with an AI the guard compares
  // what the AI was given (after the rules) with what it returned.
  const guard = tone === 'grammar'
    ? (rules && rules.only ? null : typeof SR_changeGuard === 'function' ? SR_changeGuard(rules && rules.base ? rules.base : originalText, rewrittenText) : null)
    : (typeof SR_rewriteGuard === 'function' ? SR_rewriteGuard(originalText, rewrittenText, tone) : null);
  const guardFailed = !!(guard && !guard.ok);
  const doneName = tone === 'grammar' ? 'Proofread' : tone === 'translate' ? 'Translation' : 'Rewrite';
  // "Replace anyway" after a guard trip: same target, same safety re-check.
  // The dialog hands back the accepted text (changes clicked off are put
  // back), so that's what goes in, not the full suggestion.
  const replaceAnyway = target ? { label: 'Replace anyway', otherLabel: 'Replace selection', run: (accepted) => insertSafely(accepted ?? rewrittenText) } : null;
  const guardNotice = guardFailed ? `Check this before using it: ${guard.reasons.join(', ')}.` : null;

  // The user moved on to another field while this was running: never pull
  // focus back, drop text into a box they left, or open a dialog over the
  // box they're typing in. Offer it in the toast instead; Apply is their
  // click, so focusing the old box then is expected. A result the guard
  // flagged gets no one-click Apply: Review shows why, with Replace anyway.
  const movedOn = target && await movedOnFrom();
  if (movedOn) {
    const review = { original: originalText, rewritten: rewrittenText, tone, provider, where, ...extra };
    if (guardFailed) { review.notice = guardNotice; review.action = replaceAnyway; }
    window.__srLastReview = review;
    if (window.SmartRewriteModal) {
      window.SmartRewriteModal.showSuccess(
        guardFailed ? `${doneName} ready for the box you left. Review it first: it ${guard.reasons[0]}.` : `${doneName} ready for the box you left.`,
        guardFailed ? { review } : { review, apply: { label: 'Apply', run: () => insertSafely(rewrittenText) } });
    }
    return;
  }

  // Coach mode: mark the spots, leave the text alone. The user fixes them in
  // the box, or reveals the usual diff with Apply to text box.
  // With nothing to mark, Coach says so the usual way: the small toast.
  const coachSpots = coach && typeof SR_wordDiffForDisplay === 'function' ? SR_diffCount(SR_wordDiffForDisplay(originalText, rewrittenText, 'grammar') || [{ type: 'ins' }]) : 1;
  if (coach && coachSpots > 0 && window.SmartRewriteModal && window.SmartRewriteModal.showCoach) {
    const opts = { notice: guardNotice, where, reasons: extra.reasons };
    const apply = guardFailed ? replaceAnyway
      : target ? { label: 'Apply to text box', run: (accepted) => insertSafely(accepted ?? rewrittenText) } : null;
    if (apply) opts.action = apply;
    window.__srLastReview = { original: originalText, rewritten: rewrittenText, tone, provider, where, notice: guardNotice, action: apply, reasons: extra.reasons };
    window.SmartRewriteModal.showCoach(originalText, rewrittenText, {
      where,
      onReveal: () => window.SmartRewriteModal.showResult(originalText, rewrittenText, tone, provider, targetLang, opts),
    });
    return;
  }

  if (guardFailed) {
    if (window.SmartRewriteModal) {
      const opts = { notice: guardNotice, where, ...extra };
      if (replaceAnyway) opts.action = replaceAnyway;
      window.__srLastReview = { original: originalText, rewritten: rewrittenText, tone, provider, where, notice: guardNotice, action: replaceAnyway, ...extra };
      window.SmartRewriteModal.showResult(originalText, rewrittenText, tone, provider, targetLang, opts);
    }
    return;
  }

  try {
    replaced = target ? !!(await insertInto(rewrittenText)) : false;
  } catch (_) {
    replaced = false;
  }

  // What the box holds now: the result, until Review or "Use all" changes it.
  // Undo and Apply both check the box still holds it, so it must stay current.
  let current = rewrittenText;
  // A visible Undo on the toast: Cmd/Ctrl+Z doesn't work in every editor.
  const undo = async () => { try { return !!(await op('undo', current)); } catch (_) { return false; } };
  // After an in-place fix, Review can still change it: changes the user clicks
  // off in the diff are applied to the text box (not just to Copy).
  const applyAccepted = async (accepted) => {
    try {
      const ok = !!(await op('applyAccepted', current, accepted));
      if (ok) current = accepted;
      return ok;
    } catch (_) { return false; }
  };

  if (replaced) {
    if (window.SmartRewriteModal) {
      // Proofread says how much it fixed, so "nothing changed" is visible too.
      const ops = (tone === 'grammar' && typeof SR_wordDiffForDisplay === 'function') ? SR_wordDiffForDisplay(originalText, rewrittenText, tone) : null;
      const fixes = ops && typeof SR_diffCount === 'function' ? SR_diffCount(ops) : null;
      const nothing = fixes === 0 && rewrittenText === originalText;
      // Hidden characters (zero-width spaces from copied AI text) can't be
      // marked in the diff, so the note counts them.
      const hidden = tone === 'grammar' && typeof SR_countHidden === 'function' ? SR_countHidden(originalText) - SR_countHidden(rewrittenText) : 0;
      const hiddenNote = hidden > 0 ? `${hidden} hidden character${hidden === 1 ? '' : 's'} removed` : '';
      // A short count first, details after it in lighter text. Rules alone count
      // their fixes, not the diff's marks ("alot" → "a lot" is one fix, two marks).
      // Who made each fix (rules or AI) is in Review's header, not here.
      const n = rules && rules.only && rules.count ? rules.count : fixes;
      const what = nothing ? 'No mistakes found'
        : fixes === 0 ? (hiddenNote ? `${hiddenNote.charAt(0).toUpperCase()}${hiddenNote.slice(1)}` : 'Spacing fixed')
        : fixes ? `${n} fix${n === 1 ? '' : 'es'}` : 'Text replaced';
      const hintCount = extra.hints ? extra.hints.length : 0;
      const hintNote = hintCount ? `${hintCount} suggestion${hintCount === 1 ? '' : 's'} for formal writing` : '';
      const sub = [fixes ? hiddenNote : '', hintNote].filter(Boolean).join(' · ');
      // "Nothing to fix" needs no Review or Undo; otherwise both are buttons
      // (showSuccess drops Review when only spacing changed). School
      // suggestions open in Review, off until clicked, and go in with Apply.
      const review = { original: originalText, rewritten: rewrittenText, tone, provider, where, ...extra,
        action: { label: 'Apply to text box', run: (accepted) => applyAccepted(accepted ?? rewrittenText) } };
      if (fixes !== 0 || hintCount) window.__srLastReview = review; // for the "review last change" shortcut
      // A word this proofread mastered is named in the same toast (no extra UI).
      const won = mastered && mastered.length ? { mastered } : {};
      if (week) won.week = week;
      // School suggestions: one click puts them all in, Undo still goes back to the original.
      if (hintCount) {
        const withHints = SR_applyHits(rewrittenText, extra.hints);
        won.useAll = { label: hintCount === 1 ? 'Use it' : `Use all ${hintCount}`, run: async () => {
          if (!(await applyAccepted(withHints))) return false;
          const used = `${hintCount === 1 ? 'suggestion' : `${hintCount} suggestions`} used`;
          window.SmartRewriteModal.showSuccess(nothing ? `${used.charAt(0).toUpperCase()}${used.slice(1)}` : what, { sub: nothing ? '' : used, review: { ...review, rewritten: withHints, hints: [] }, undo });
          return true;
        } };
      }
      window.SmartRewriteModal.showSuccess(what, { sub, ...(nothing ? (hintCount ? { review, undo, ...won } : won) : { review, undo, ...won }) });
    }
    return;
  }

  if (window.SmartRewriteModal) {
    window.__srLastReview = { original: originalText, rewritten: rewrittenText, tone, provider, where, ...extra };
    const notice = richBox ? 'This box has links or formatting that Proofr would lose, so it wasn\'t changed. Select just your text to replace it.' : null;
    window.SmartRewriteModal.showResult(originalText, rewrittenText, tone, provider, targetLang, { where, notice, ...extra });
  } else {
    navigator.clipboard.writeText(rewrittenText)
      .then(() => alert('Rewritten text copied to clipboard:\n\n' + rewrittenText))
      .catch(() => alert('Rewritten text:\n\n' + rewrittenText));
  }
}
