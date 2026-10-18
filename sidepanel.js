// === Cloud provider storage ===
// Groq/OpenAI/OpenRouter/Custom — any OpenAI-compatible endpoint. Each
// service keeps its own key/model so switching providers never loses one
// you've already configured (this is the bug lasso's own comment warns
// about: falling back to a shared/legacy key made an unconfigured service
// look configured by borrowing another's).
const SR_CLOUD_KEY_PREFIX = 'srCloudKey_';
const SR_CLOUD_MODEL_PREFIX = 'srCloudModel_';
const SR_KEY_LINKS = {
  groq: 'https://console.groq.com/keys',
  openai: 'https://platform.openai.com/api-keys',
  openrouter: 'https://openrouter.ai/keys',
};

class CloudProvider {
  static async getActiveService() {
    try {
      const r = await chrome.storage.sync.get(['srCloudService']);
      return r.srCloudService || 'groq';
    } catch {
      return 'groq';
    }
  }

  static async setActiveService(id) {
    try { await chrome.storage.sync.set({ srCloudService: id }); } catch { /* ignore */ }
  }

  static async getConfig(serviceId) {
    try {
      const id = serviceId || await this.getActiveService();
      const meta = SR_cloudServiceMeta(id);
      const keyField = `${SR_CLOUD_KEY_PREFIX}${id}`;
      const modelField = `${SR_CLOUD_MODEL_PREFIX}${id}`;
      const r = await chrome.storage.sync.get([keyField, modelField, 'srCloudCustomBaseURL', 'groqAPIKey']);
      // Legacy single-key storage (pre-multi-provider) — carries an already-saved Groq key forward.
      const apiKey = r[keyField] || (id === 'groq' ? (r.groqAPIKey || '') : '');
      const baseURL = id === 'custom' ? (r.srCloudCustomBaseURL || '') : meta.baseURL;
      const model = r[modelField] || meta.defaultModel;
      return { id, displayName: meta.name, baseURL, model, apiKey };
    } catch {
      const meta = SR_cloudServiceMeta('groq');
      return { id: 'groq', displayName: meta.name, baseURL: meta.baseURL, model: meta.defaultModel, apiKey: '' };
    }
  }

  static async hasKey(serviceId) {
    const cfg = await this.getConfig(serviceId);
    return !!(cfg.apiKey && cfg.apiKey.trim().length > 0);
  }

  static async setKey(serviceId, apiKey) {
    try {
      await chrome.storage.sync.set({ [`${SR_CLOUD_KEY_PREFIX}${serviceId}`]: apiKey });
      // Once Groq gets its own key under the new scheme, retire the legacy
      // single-key fallback — otherwise "Remove" on Groq wouldn't fully clear it.
      if (serviceId === 'groq') await chrome.storage.sync.remove(['groqAPIKey']);
    } catch { /* ignore */ }
  }

  static async clearKey(serviceId) {
    try {
      const keys = [`${SR_CLOUD_KEY_PREFIX}${serviceId}`];
      if (serviceId === 'groq') keys.push('groqAPIKey');
      await chrome.storage.sync.remove(keys);
    } catch { /* ignore */ }
  }

  static async setModel(serviceId, model) {
    try { await chrome.storage.sync.set({ [`${SR_CLOUD_MODEL_PREFIX}${serviceId}`]: model }); } catch { /* ignore */ }
  }

  static async setCustomBaseURL(url) {
    try { await chrome.storage.sync.set({ srCloudCustomBaseURL: url }); } catch { /* ignore */ }
  }
}

function keyHintForService(id) {
  const link = SR_KEY_LINKS[id];
  if (!link) return 'Stored only in your browser.';
  let host = link;
  try { host = new URL(link).host; } catch { /* keep raw link as fallback text */ }
  return `Get a key from <a href="${link}" target="_blank" rel="noopener">${host}</a>. Stored only in your browser.`;
}

// === Usage stats (aggregate only, not shown in this UI, kept for parity
// with the hover/context-menu rewrite paths in background.js) ===
class StatsManager {
  static async getStats() {
    try {
      const result = await chrome.storage.local.get(['rewriteStats']);
      return result.rewriteStats || { totalRewrites: 0, styleUsage: {}, lastUsed: null };
    } catch (error) {
      return { totalRewrites: 0, styleUsage: {}, lastUsed: null };
    }
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

// === Settings (engine, translate target, last-used mode) ===
// Every field here persists immediately on change. There is no batched
// "commit on close" step for any of these, so the engine control and the
// key field can each use whichever save pattern actually fits them.
class Settings {
  static async get() {
    try {
      const r = await chrome.storage.sync.get(['srEngine', 'srTargetLang', 'srLastTone']);
      return {
        engine: r.srEngine || 'auto',
        targetLang: r.srTargetLang || 'en',
        lastTone: r.srLastTone || 'grammar',
      };
    } catch {
      return { engine: 'auto', targetLang: 'en', lastTone: 'grammar' };
    }
  }
  static async set(patch) {
    try { await chrome.storage.sync.set(patch); } catch { /* ignore */ }
  }
}

// === Turn log (display/storage only, never read back into a rewrite
// request; see runTurn() below, which only ever sends turn.inputText). ===
const TURN_LOG_KEY = 'turnLog';
const MAX_TURNS = 50;

class TurnLog {
  static async getAll() {
    try {
      const r = await chrome.storage.local.get([TURN_LOG_KEY]);
      return r[TURN_LOG_KEY] || [];
    } catch {
      return [];
    }
  }
  static async save(turns) {
    const capped = turns.slice(-MAX_TURNS);
    try { await chrome.storage.local.set({ [TURN_LOG_KEY]: capped }); } catch { /* ignore */ }
    return capped;
  }
  static async clear() {
    try { await chrome.storage.local.remove([TURN_LOG_KEY]); } catch { /* ignore */ }
  }
}

// === DOM refs ===
const el = (id) => document.getElementById(id);
const refs = {};

// === State ===
let deviceReady = false;
let keyEditing = false;
let turns = [];
let currentMode = 'grammar';
let currentTargetLang = 'en';
let paletteView = 'modes'; // 'modes' | 'languages'
let paletteFiltered = [];
let paletteActiveIndex = 0;
let paletteOpenedViaSlash = false;
let savedToastTimer = null;

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function formatLatency(ms) {
  if (ms == null) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const ICON_REDO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';
const ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const ICON_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M6.06 6.06A18.45 18.45 0 0 0 1 12s4 8 11 8a10.9 10.9 0 0 0 5.94-1.94M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/></svg>';

// === Provider status pill ===
async function refreshProviderPill() {
  const availability = await SR_deviceAvailability();
  deviceReady = availability === 'available' || availability === 'downloadable' || availability === 'downloading';
  const provider = await CloudProvider.getConfig();
  const hasKey = !!provider.apiKey;
  const { engine } = await Settings.get();

  let label, runnable;
  if (engine === 'cloud') {
    label = hasKey ? `${provider.displayName} · connected` : 'Add key';
    runnable = hasKey;
  } else if (engine === 'device') {
    label = deviceReady ? 'On-device · local' : 'Unavailable';
    runnable = deviceReady;
  } else {
    label = deviceReady ? 'On-device · local' : (hasKey ? `${provider.displayName} · connected` : 'Add key');
    runnable = deviceReady || hasKey;
  }

  refs.providerPill.classList.toggle('connected', runnable);
  refs.providerPillText.textContent = label;
  refs.setupCard.classList.toggle('hidden', deviceReady || hasKey);
  return { deviceReady, hasKey, runnable };
}

// === "Saved" confirmation toast (engine control + key save) ===
function showSavedToast() {
  if (!refs.savedToast) return;
  clearTimeout(savedToastTimer);
  refs.savedToast.classList.add('show');
  savedToastTimer = setTimeout(() => refs.savedToast.classList.remove('show'), 1200);
}

// === Settings panel: AI engine (segmented control, instant-apply) ===
const ENGINE_CAPTIONS = {
  auto: "Auto: every rewrite prefers on-device, and only falls back to your cloud provider if it isn't available and a key is saved.",
  device: 'On-device: every rewrite runs locally in EN, ES, FR, DE, JA. Nothing ever leaves your device.',
  cloud: "Cloud only: every rewrite is sent to your selected provider's API. Fastest and covers every language, but requires a key and leaves your device.",
};

function updateEngineHint(engine) {
  if (engine === 'device' && !deviceReady) {
    refs.engineHint.textContent = 'On-device only: unavailable in this browser. Switch to Auto or Cloud.';
    return;
  }
  refs.engineHint.textContent = ENGINE_CAPTIONS[engine] || '';
}

async function refreshSettingsPanel() {
  const { engine } = await Settings.get();

  refs.engineSeg.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === engine);
    btn.disabled = btn.dataset.value === 'device' && !deviceReady;
  });
  updateEngineHint(engine);

  refs.keySection.classList.toggle('hidden', engine === 'device');
  await refreshCloudSection();

  const { srHoverAssist } = await chrome.storage.sync.get(['srHoverAssist']);
  refs.hoverToggle.checked = !!srHoverAssist;
}

// === Settings panel: cloud provider picker (service + model + base URL) ===
// Custom-built dropdown, not a native <select> — the browser's own open
// listbox is OS chrome (dark on this Mac) that CSS can't restyle, so this
// reuses the same pattern as the mode/language palette instead.
function closeCloudMenu() {
  refs.cloudServiceMenu.classList.add('hidden');
}

function openCloudMenu() {
  refs.cloudServiceMenu.classList.remove('hidden');
}

async function refreshCloudSection() {
  const serviceId = await CloudProvider.getActiveService();
  const meta = SR_cloudServiceMeta(serviceId);
  refs.cloudServiceBtnLabel.textContent = meta.name;
  refs.cloudServiceMenu.querySelectorAll('.cloud-select-item').forEach((item) => {
    item.classList.toggle('current', item.dataset.value === serviceId);
  });
  refs.customBaseURLRow.classList.toggle('hidden', serviceId !== 'custom');

  const cfg = await CloudProvider.getConfig(serviceId);
  refs.cloudModelInput.value = cfg.model;
  refs.cloudModelInput.placeholder = meta.defaultModel || 'model name';
  if (serviceId === 'custom') refs.customBaseURLInput.value = cfg.baseURL;

  await renderKeyField(serviceId);
  closeModelMenu();
}

// === Settings panel: browse available models ({baseURL}/models) ===
let cachedModelList = [];

function closeModelMenu() {
  refs.modelMenu.classList.add('hidden');
}

function renderModelMenu(query) {
  const q = (query || '').toLowerCase();
  const filtered = cachedModelList.filter((m) => m.toLowerCase().includes(q));
  if (filtered.length === 0) {
    refs.modelMenuList.innerHTML = '<div class="model-menu-empty">No matching models.</div>';
    return;
  }
  refs.modelMenuList.innerHTML = filtered.map((m) => `<div class="model-menu-item" data-model="${escapeHtml(m)}">${escapeHtml(m)}</div>`).join('');
}

async function openModelMenu() {
  refs.modelMenu.classList.remove('hidden');
  refs.modelMenuSearch.value = '';
  refs.modelMenuList.innerHTML = '<div class="model-menu-empty">Loading…</div>';
  refs.modelMenuSearch.focus();

  try {
    const provider = await CloudProvider.getConfig();
    cachedModelList = await SR_availableModels(provider);
    if (cachedModelList.length === 0) {
      refs.modelMenuList.innerHTML = '<div class="model-menu-empty">No chat models found.</div>';
      return;
    }
    renderModelMenu('');
  } catch (error) {
    refs.modelMenuList.innerHTML = `<div class="model-menu-empty">${escapeHtml(error.message || 'Could not load models.')}</div>`;
  }
}

async function selectModel(model) {
  refs.cloudModelInput.value = model;
  const serviceId = await CloudProvider.getActiveService();
  await CloudProvider.setModel(serviceId, model);
  closeModelMenu();
  showSavedToast();
}

// === Settings panel: cloud provider API key (explicit edit/save cycle) ===
function updateEyeIcon() {
  const visible = refs.apiKeyInput.type === 'text';
  refs.btnToggleKeyEye.innerHTML = visible ? ICON_EYE_OFF : ICON_EYE;
  refs.btnToggleKeyEye.setAttribute('aria-label', visible ? 'Hide key' : 'Show key');
}

async function renderKeyField(serviceId) {
  serviceId = serviceId || await CloudProvider.getActiveService();
  const cfg = await CloudProvider.getConfig(serviceId);
  const hasKey = !!cfg.apiKey;
  const input = refs.apiKeyInput;

  if (keyEditing) {
    input.readOnly = false;
    input.type = 'text'; // unmasked by default while typing a NEW key; a typo here has real cost
    input.value = '';
    input.placeholder = 'Paste new key…';
    input.classList.add('editing');
    refs.btnSaveKey.textContent = 'Save';
    refs.btnSaveKey.classList.remove('btn-outline');
    refs.btnSaveKey.classList.add('btn-solid');
    refs.keyHint.classList.add('hidden-fade');
    refs.btnClearKey.classList.add('hidden');
  } else if (hasKey) {
    const last4 = cfg.apiKey.slice(-4);
    input.readOnly = true;
    input.type = 'password';
    input.value = `••••••••••••${last4}`;
    input.placeholder = '';
    input.classList.remove('editing');
    refs.btnSaveKey.textContent = 'Change';
    refs.btnSaveKey.classList.remove('btn-solid');
    refs.btnSaveKey.classList.add('btn-outline');
    refs.keyHint.innerHTML = `${ICON_CHECK}Saved: stored only in your browser`;
    refs.keyHint.classList.add('ok');
    refs.keyHint.classList.remove('hidden-fade');
    refs.btnClearKey.classList.remove('hidden');
  } else {
    // No key yet: start directly in an editable, empty state so first-time
    // setup doesn't need an extra "Change" click first.
    input.readOnly = false;
    input.type = 'text';
    input.value = '';
    input.placeholder = `${cfg.displayName} API key…`;
    input.classList.remove('editing');
    refs.btnSaveKey.textContent = 'Save';
    refs.btnSaveKey.classList.remove('btn-outline');
    refs.btnSaveKey.classList.add('btn-solid');
    refs.keyHint.innerHTML = keyHintForService(serviceId);
    refs.keyHint.classList.remove('ok');
    refs.keyHint.classList.remove('hidden-fade');
    refs.btnClearKey.classList.add('hidden');
  }
  updateEyeIcon();
}

function onSaveClick() {
  if (keyEditing) {
    saveKey();
    return;
  }
  keyEditing = true;
  renderKeyField();
  refs.apiKeyInput.focus();
}

async function saveKey() {
  const serviceId = await CloudProvider.getActiveService();
  const key = refs.apiKeyInput.value.trim();
  if (!key) {
    refs.keyHint.classList.remove('ok');
    refs.keyHint.textContent = 'Enter your API key first.';
    refs.keyHint.classList.remove('hidden-fade');
    return;
  }
  if (!SR_isValidApiKey(key, serviceId)) {
    refs.keyHint.classList.remove('ok');
    refs.keyHint.textContent = 'That key looks off. Double-check it and try again.';
    refs.keyHint.classList.remove('hidden-fade');
    return;
  }

  const cfg = await CloudProvider.getConfig(serviceId);
  if (serviceId === 'custom' && !cfg.baseURL) {
    refs.keyHint.classList.remove('ok');
    refs.keyHint.textContent = 'Set a base URL above first.';
    refs.keyHint.classList.remove('hidden-fade');
    return;
  }

  refs.btnSaveKey.disabled = true;
  refs.btnSaveKey.textContent = 'Checking…';
  try {
    const res = await fetch(SR_modelsURL(cfg.baseURL), {
      headers: { 'Authorization': `Bearer ${key}` },
    });
    if (!res.ok) {
      refs.keyHint.classList.remove('ok');
      refs.keyHint.textContent = `${cfg.displayName} rejected that key. Double-check and try again.`;
      refs.keyHint.classList.remove('hidden-fade');
      return;
    }
    await CloudProvider.setKey(serviceId, key);
    keyEditing = false;
    await renderKeyField(serviceId);
    await refreshProviderPill();
    showSavedToast();
  } catch (error) {
    refs.keyHint.classList.remove('ok');
    refs.keyHint.textContent = `Could not reach ${cfg.displayName} to verify the key. Check your connection.`;
    refs.keyHint.classList.remove('hidden-fade');
  } finally {
    refs.btnSaveKey.disabled = false;
    if (keyEditing) refs.btnSaveKey.textContent = 'Save'; // stayed in edit mode after a failure; restore the label
  }
}

async function clearKey() {
  const serviceId = await CloudProvider.getActiveService();
  await CloudProvider.clearKey(serviceId);
  keyEditing = false;
  await renderKeyField(serviceId);
  await refreshProviderPill();
}

function toggleSettingsPanel(forceOpen) {
  const panel = refs.settingsPanel;
  const open = forceOpen !== undefined ? forceOpen : panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !open);
  if (open) {
    keyEditing = false;
    refreshSettingsPanel();
  } else {
    closeCloudMenu();
  }
}

// === Mode tag + palette ===
function updateModeTag() {
  const name = SR_getToneName(currentMode);
  refs.modeTagLabel.textContent = currentMode === 'translate'
    ? `${name} → ${SR_fullLangName(currentTargetLang)}`
    : name;
}

// Languages beyond the on-device five only work through a cloud provider,
// so they're tagged in the palette until a key is saved.
let hasKeyCached = false;
function needsKey(code) {
  return !hasKeyCached && !SR_isOnDeviceLanguage(code);
}

function renderPalette(query = '') {
  if (paletteView === 'languages') {
    paletteFiltered = SR_LANGUAGES_FULL;
    refs.paletteHintLeft.textContent = 'TRANSLATE TO';
  } else {
    paletteFiltered = SR_TONES.filter((t) => t.name.toLowerCase().includes(query.toLowerCase()));
    refs.paletteHintLeft.textContent = 'MODE';
  }
  paletteActiveIndex = 0;

  if (paletteFiltered.length === 0) {
    refs.paletteList.innerHTML = '<div class="palette-empty">No matching mode</div>';
    return;
  }

  refs.paletteList.innerHTML = paletteFiltered.map((item, i) => {
    const isCurrent = paletteView === 'languages'
      ? item.code === currentTargetLang
      : item.id === currentMode;
    const keyOnly = paletteView === 'languages' && needsKey(item.code);
    const desc = paletteView === 'languages' ? '' : item.desc;
    const trailing = keyOnly ? '<span class="key-badge">NEEDS KEY</span>' : `<span class="desc">${escapeHtml(desc)}</span>`;
    return `<div class="palette-item ${i === 0 ? 'active' : ''} ${isCurrent ? 'current' : ''}" data-i="${i}">
      <span class="name"><b>${escapeHtml(item.name)}</b></span>
      ${trailing}
    </div>`;
  }).join('');
}

function updatePaletteActive() {
  [...refs.paletteList.children].forEach((node, i) => node.classList.toggle('active', i === paletteActiveIndex));
}

async function openPalette(view) {
  paletteView = view;
  if (view === 'languages') hasKeyCached = await CloudProvider.hasKey();
  renderPalette();
  refs.palette.classList.add('open');
}

function closePalette() {
  refs.palette.classList.remove('open');
  paletteView = 'modes';
  paletteOpenedViaSlash = false;
}

function selectPaletteItem(item) {
  if (!item) return;

  if (paletteView === 'modes') {
    if (item.id === 'translate') {
      // Drill into the language sub-list rather than closing: Translate
      // needs a target language before it's actually usable.
      currentMode = 'translate';
      paletteView = 'languages';
      renderPalette();
      updatePaletteActive();
      return;
    }
    currentMode = item.id;
    Settings.set({ srLastTone: currentMode });
    updateModeTag();
    closePalette();
  } else {
    currentTargetLang = item.code;
    Settings.set({ srLastTone: 'translate', srTargetLang: item.code });
    updateModeTag();
    closePalette();
  }

  if (paletteOpenedViaSlash) {
    refs.ta.value = '';
    autoGrow();
    updateCharCount();
    refs.sendBtn.disabled = true;
  }
  refs.ta.focus();
}

// === Composer ===
function autoGrow() {
  refs.ta.style.height = 'auto';
  refs.ta.style.height = Math.min(refs.ta.scrollHeight, 220) + 'px';
}

function updateCharCount() {
  const len = refs.ta.value.length;
  const max = (typeof SR_DEVICE_MAX_CHARS !== 'undefined') ? SR_DEVICE_MAX_CHARS : 4000;
  refs.charCount.textContent = `${len} / ${max}`;
  refs.charCount.classList.toggle('visible', len > 0);
}

function resetComposer() {
  refs.ta.value = '';
  autoGrow();
  updateCharCount();
  refs.sendBtn.disabled = true;
}

async function sendMessage() {
  const text = refs.ta.value.trim();
  if (!text) return;

  const hasKey = await CloudProvider.hasKey();
  const { engine } = await Settings.get();
  const runnable = engine === 'cloud' ? hasKey : engine === 'device' ? deviceReady : (deviceReady || hasKey);
  if (!runnable) {
    toggleSettingsPanel(true);
    return;
  }

  // On-device only covers five languages; anything else needs a cloud key.
  if (currentMode === 'translate' && !SR_isOnDeviceLanguage(currentTargetLang) && !hasKey) {
    toggleSettingsPanel(true);
    return;
  }

  const turn = {
    id: (crypto.randomUUID ? crypto.randomUUID() : `t${Date.now()}${Math.random()}`),
    ts: Date.now(),
    mode: currentMode,
    targetLang: currentMode === 'translate' ? currentTargetLang : undefined,
    inputText: text,
    status: 'pending',
  };
  turns.push(turn);
  renderThread();
  resetComposer();

  await runTurn(turn);
}

// Every call here is a fresh, single-turn request: SR_rewriteAuto only ever
// receives turn.inputText + turn.mode for THIS turn. Nothing from `turns`
// (the display log) is read into the request; that array exists purely to
// render past entries.
async function runTurn(turn, opts = {}) {
  const start = performance.now();
  try {
    const provider = await CloudProvider.getConfig();
    const { engine } = await Settings.get();
    const { text: rewritten, provider: providerId } = await SR_rewriteAuto(turn.inputText, turn.mode, {
      provider,
      engine,
      targetLang: turn.targetLang,
      temperatureBoost: opts.boost ? 0.15 : 0,
    });
    turn.outputText = rewritten;
    turn.provider = providerId;
    turn.latencyMs = Math.round(performance.now() - start);
    turn.status = 'done';
    delete turn.errorMessage;
    await StatsManager.updateStats(turn.mode);
  } catch (error) {
    turn.status = 'error';
    turn.errorMessage = error.message || 'Something went wrong.';
  }
  turns = await TurnLog.save(turns);
  renderThread();
}

async function regenerateTurn(turn) {
  turn.status = 'pending';
  renderThread();
  await runTurn(turn, { boost: true });
}

async function copyTurn(turn, btn) {
  if (!turn.outputText) return;
  try {
    await navigator.clipboard.writeText(turn.outputText);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = turn.outputText;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const original = btn.innerHTML;
  btn.innerHTML = `${ICON_CHECK}Copied`;
  btn.classList.add('copied');
  setTimeout(() => {
    btn.innerHTML = original;
    btn.classList.remove('copied');
  }, 1600);
}

// === Thread rendering ===
function renderAssistantCard(turn) {
  const modeName = escapeHtml(SR_getToneName(turn.mode));

  if (turn.status === 'pending') {
    return `<div class="assistant-card">
      <div class="assistant-head"><span><span class="tag">${modeName}</span> · …</span><span></span></div>
      <div class="assistant-body">
        <div class="sr-skel-line"></div><div class="sr-skel-line"></div><div class="sr-skel-line short"></div>
      </div>
    </div>`;
  }

  if (turn.status === 'error') {
    return `<div class="assistant-card error">
      <div class="assistant-head"><span><span class="tag">${modeName}</span></span><span></span></div>
      <div class="assistant-body error-text">${escapeHtml(turn.errorMessage || 'Something went wrong.')}</div>
      <div class="assistant-actions"><button class="chip-btn" data-action="retry">${ICON_REDO}Try again</button></div>
    </div>`;
  }

  const engineName = SR_providerDisplayLabel(turn.provider);
  return `<div class="assistant-card">
    <div class="assistant-head"><span><span class="tag">${modeName}</span> · ${engineName}</span><span>${formatLatency(turn.latencyMs)}</span></div>
    <div class="assistant-body">${escapeHtml(turn.outputText)}</div>
    <div class="assistant-actions">
      <button class="chip-btn" data-action="redo">${ICON_REDO}Rewrite again</button>
      <button class="chip-btn" data-action="copy">${ICON_COPY}Copy</button>
    </div>
  </div>`;
}

function renderTurn(turn) {
  const modeLabel = turn.mode === 'translate' && turn.targetLang
    ? `Translate → ${SR_fullLangName(turn.targetLang)}`
    : SR_getToneName(turn.mode);

  const node = document.createElement('div');
  node.className = 'turn';
  node.dataset.id = turn.id;
  node.innerHTML = `
    <div class="turn-meta"><span>${formatTime(turn.ts)}</span><span class="sep">·</span><span>${escapeHtml(modeLabel)}</span></div>
    <div class="msg-user">${escapeHtml(turn.inputText)}</div>
    <div class="msg-assistant">${renderAssistantCard(turn)}</div>
  `;
  return node;
}

function renderThread() {
  if (turns.length === 0) {
    refs.thread.innerHTML = '<div class="thread-empty">Your rewrites will appear here.</div>';
    return;
  }
  refs.thread.innerHTML = '';
  const frag = document.createDocumentFragment();
  turns.forEach((t) => frag.appendChild(renderTurn(t)));
  refs.thread.appendChild(frag);
  refs.thread.scrollTop = refs.thread.scrollHeight;
}

// Delegated: one listener handles copy/redo/retry for every turn, present or future.
function bindThreadDelegation() {
  refs.thread.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const turnEl = btn.closest('.turn');
    const turn = turns.find((t) => t.id === turnEl?.dataset.id);
    if (!turn) return;

    if (btn.dataset.action === 'copy') await copyTurn(turn, btn);
    else if (btn.dataset.action === 'redo' || btn.dataset.action === 'retry') await regenerateTurn(turn);
  });
}

// === Info overlays (Privacy / Help) ===
function openOverlay(html) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="overlay-card">${html}
    <button class="btn-solid" data-close="1" type="button">Close</button></div>`;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.dataset.close) overlay.remove();
  });
  document.body.appendChild(overlay);
}

const InfoOverlays = {
  showPrivacyPolicy() {
    openOverlay(`
      <h3>Privacy</h3>
      <p>Your <strong>API key</strong>, <strong>rewrite history</strong>, and <strong>usage counts</strong> live only in your browser storage. Nothing is sent to us.</p>
      <p>With <strong>on-device AI</strong>, your text is rewritten locally and never leaves your computer.</p>
      <p>If a cloud provider is used instead, the text goes directly to that provider over HTTPS, governed by their privacy policy. Every rewrite is sent as its own independent request. Proofr never sends your rewrite history back to any model.</p>
    `);
  },
  showSupport() {
    openOverlay(`
      <h3>Help</h3>
      <p><strong>On any page:</strong> select text → right-click → Proofr, or press <strong>Ctrl+Shift+R</strong> for a quick Professional rewrite. Turn on <strong>Hover actions</strong> in Settings to summarize, simplify, or translate any paragraph you're reading. Right-click anywhere → "Translate this page" for a full bilingual translation.</p>
      <p><strong>In this panel:</strong> type or paste text, click the <strong>/Mode</strong> tag (or type <strong>/</strong>) to pick a mode, then <strong>Ctrl/Cmd+Enter</strong> or the send button. Each entry in the list is independent. Proofr doesn't read earlier entries when rewriting a new one.</p>
      <p><strong>How it rewrites:</strong> if your Chrome has built-in AI, rewrites in English, Spanish, French, German, and Japanese run on-device with no key. Other languages, the hover "Ask" box, and Chrome without built-in AI use your cloud provider key. The pill up top shows which is active.</p>
      <p>Questions? <a href="mailto:cjcarito15@gmail.com">cjcarito15@gmail.com</a> · <a href="https://github.com/civarry" target="_blank" rel="noopener">github.com/civarry</a></p>
    `);
  },

};

// === Wire up ===
document.addEventListener('DOMContentLoaded', async () => {
  [
    'mark', 'providerPill', 'providerPillText', 'btnClearHistory', 'btnSettings', 'btnSettingsBack',
    'settingsPanel', 'savedToast', 'setupCard', 'hoverToggle', 'engineSeg', 'engineHint',
    'keySection', 'cloudServiceBtn', 'cloudServiceBtnLabel', 'cloudServiceMenu',
    'customBaseURLRow', 'customBaseURLInput', 'cloudModelInput',
    'btnBrowseModels', 'modelMenu', 'modelMenuSearch', 'modelMenuList',
    'apiKeyInput', 'btnToggleKeyEye', 'btnSaveKey', 'btnClearKey', 'keyHint',
    'thread', 'palette', 'paletteHintLeft', 'paletteList',
    'modeTag', 'modeTagLabel', 'ta', 'charCount', 'sendBtn',
  ].forEach((id) => { refs[id] = el(id); });

  if (typeof SR_LOGO_SVG !== 'undefined') refs.mark.innerHTML = SR_LOGO_SVG;

  const { lastTone, targetLang } = await Settings.get();
  currentMode = lastTone;
  currentTargetLang = targetLang;
  updateModeTag();

  const { hasKey } = await refreshProviderPill();

  turns = await TurnLog.getAll();
  renderThread();
  bindThreadDelegation();
  updateCharCount();

  // Header
  refs.btnSettings.addEventListener('click', () => toggleSettingsPanel());
  refs.btnSettingsBack.addEventListener('click', () => toggleSettingsPanel(false));
  refs.btnClearHistory.addEventListener('click', async () => {
    if (turns.length === 0) return;
    if (!confirm("Clear all rewrite history? This can't be undone.")) return;
    turns = [];
    await TurnLog.clear();
    renderThread();
  });

  // Settings panel: engine (instant-apply segmented control)
  refs.engineSeg.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      await Settings.set({ srEngine: btn.dataset.value });
      await refreshSettingsPanel();
      await refreshProviderPill();
      showSavedToast();
    });
  });

  // Settings panel: hover actions on page text (off by default; hover-assist.js
  // watches this key live, so open tabs pick it up without a reload)
  refs.hoverToggle.addEventListener('change', async () => {
    await Settings.set({ srHoverAssist: refs.hoverToggle.checked });
    showSavedToast();
  });

  // Settings panel: cloud provider picker (custom dropdown, not a native <select>)
  refs.cloudServiceBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    refs.cloudServiceMenu.classList.contains('hidden') ? openCloudMenu() : closeCloudMenu();
  });
  refs.cloudServiceMenu.addEventListener('click', async (e) => {
    const item = e.target.closest('.cloud-select-item');
    if (!item) return;
    closeCloudMenu();
    await CloudProvider.setActiveService(item.dataset.value);
    keyEditing = false;
    await refreshCloudSection();
    await refreshProviderPill();
    showSavedToast();
  });
  document.addEventListener('click', (e) => {
    if (!refs.cloudServiceMenu.contains(e.target) && e.target !== refs.cloudServiceBtn && !refs.cloudServiceBtn.contains(e.target)) {
      closeCloudMenu();
    }
  });
  refs.cloudModelInput.addEventListener('change', async () => {
    const id = await CloudProvider.getActiveService();
    await CloudProvider.setModel(id, refs.cloudModelInput.value.trim());
    showSavedToast();
  });
  refs.customBaseURLInput.addEventListener('change', async () => {
    await CloudProvider.setCustomBaseURL(refs.customBaseURLInput.value.trim());
    showSavedToast();
  });

  // Settings panel: browse available models
  refs.btnBrowseModels.addEventListener('click', (e) => {
    e.stopPropagation();
    refs.modelMenu.classList.contains('hidden') ? openModelMenu() : closeModelMenu();
  });
  refs.modelMenuSearch.addEventListener('input', () => renderModelMenu(refs.modelMenuSearch.value));
  refs.modelMenuList.addEventListener('click', (e) => {
    const item = e.target.closest('.model-menu-item');
    if (!item) return;
    selectModel(item.dataset.model);
  });
  document.addEventListener('click', (e) => {
    if (!refs.modelMenu.contains(e.target) && e.target !== refs.btnBrowseModels && !refs.btnBrowseModels.contains(e.target)) {
      closeModelMenu();
    }
  });

  // Settings panel: provider API key (explicit edit/save cycle)
  refs.btnSaveKey.addEventListener('click', onSaveClick);
  refs.btnClearKey.addEventListener('click', clearKey);
  refs.apiKeyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') onSaveClick(); });
  refs.btnToggleKeyEye.addEventListener('click', () => {
    refs.apiKeyInput.type = refs.apiKeyInput.type === 'text' ? 'password' : 'text';
    updateEyeIcon();
  });
  refs.settingsPanel.querySelectorAll('[data-action]').forEach((node) => {
    node.addEventListener('click', (e) => {
      e.preventDefault();
      const fn = InfoOverlays[node.dataset.action];
      if (fn) fn();
    });
  });

  // Mode tag + palette
  refs.modeTag.addEventListener('click', () => {
    if (refs.palette.classList.contains('open')) { closePalette(); return; }
    openPalette(currentMode === 'translate' ? 'languages' : 'modes');
  });
  refs.paletteList.addEventListener('click', (e) => {
    const item = e.target.closest('.palette-item');
    if (!item) return;
    selectPaletteItem(paletteFiltered[+item.dataset.i]);
  });
  document.addEventListener('click', (e) => {
    if (!refs.palette.contains(e.target) && e.target !== refs.modeTag && !refs.modeTag.contains(e.target)) {
      closePalette();
    }
  });

  // Composer
  refs.ta.addEventListener('input', () => {
    autoGrow();
    updateCharCount();
    refs.sendBtn.disabled = refs.ta.value.trim().length === 0;

    const v = refs.ta.value;
    if (v.startsWith('/')) {
      paletteOpenedViaSlash = true;
      const q = v.slice(1).split(' ')[0];
      if (!refs.palette.classList.contains('open') || paletteView !== 'modes') openPalette('modes');
      renderPalette(q);
      updatePaletteActive();
    } else if (paletteOpenedViaSlash) {
      closePalette();
    }
  });
  refs.ta.addEventListener('keydown', (e) => {
    if (refs.palette.classList.contains('open')) return; // let the palette nav handler own this keystroke
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); sendMessage(); }
  });
  refs.sendBtn.addEventListener('click', sendMessage);

  // Palette keyboard nav (Slack/Notion-style)
  document.addEventListener('keydown', (e) => {
    if (!refs.palette.classList.contains('open')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); paletteActiveIndex = Math.min(paletteActiveIndex + 1, paletteFiltered.length - 1); updatePaletteActive(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); paletteActiveIndex = Math.max(paletteActiveIndex - 1, 0); updatePaletteActive(); }
    if (e.key === 'Enter') { e.preventDefault(); selectPaletteItem(paletteFiltered[paletteActiveIndex]); }
    if (e.key === 'Escape') { closePalette(); }
  });

  if (!deviceReady && !hasKey) {
    toggleSettingsPanel(true);
  } else {
    setTimeout(() => refs.ta.focus(), 100);
  }
});
