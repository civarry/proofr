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
      // Keys are device-only (storage.local); background.js migrates any older synced key.
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
    } catch {
      const meta = SR_cloudServiceMeta('groq');
      return { id: 'groq', displayName: meta.name, baseURL: meta.baseURL, model: meta.defaultModel, apiKey: '' };
    }
  }

  // Ready to send a request: a key, or a provider that doesn't need one.
  static async isReady(serviceId) {
    return providerReady(await this.getConfig(serviceId));
  }

  static async setKey(serviceId, apiKey) {
    try {
      await chrome.storage.local.set({ [`${SR_CLOUD_KEY_PREFIX}${serviceId}`]: apiKey });
      // Once Groq gets its own key under the new scheme, retire the legacy
      // single-key fallback — otherwise "Remove" on Groq wouldn't fully clear it.
      if (serviceId === 'groq') await chrome.storage.local.remove(['groqAPIKey']);
    } catch { /* ignore */ }
  }

  static async clearKey(serviceId) {
    try {
      const keys = [`${SR_CLOUD_KEY_PREFIX}${serviceId}`];
      if (serviceId === 'groq') keys.push('groqAPIKey');
      await chrome.storage.local.remove(keys);
    } catch { /* ignore */ }
  }

  static async setModel(serviceId, model) {
    try { await chrome.storage.sync.set({ [`${SR_CLOUD_MODEL_PREFIX}${serviceId}`]: model }); } catch { /* ignore */ }
  }

  static async setCustomBaseURL(url) {
    try { await chrome.storage.sync.set({ srCloudCustomBaseURL: url }); } catch { /* ignore */ }
  }
}

function providerReady(cfg) {
  if (typeof SR_providerReady === 'function') return SR_providerReady(cfg);
  return !!(cfg && cfg.baseURL && (cfg.apiKey || cfg.keyless));
}

// The provider's own page for creating a key, from the preset when it has one.
function keyLinkFor(id) {
  return SR_cloudServiceMeta(id).keyURL || SR_KEY_LINKS[id] || null;
}

function keyHintForService(id) {
  const link = keyLinkFor(id);
  if (!link) return 'Stored on this computer only.';
  let host = link;
  try { host = new URL(link).host; } catch { /* keep raw link as fallback text */ }
  return `Get a key from <a href="${link}" target="_blank" rel="noopener">${host}</a>. Stored on this computer only.`;
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
    stats.days = SR_bumpDay(stats.days);
    stats.styleUsage[style] = (stats.styleUsage[style] || 0) + 1;
    stats.lastUsed = Date.now();
    await chrome.storage.local.set({ rewriteStats: stats });
    return stats;
  }
}

// Per-day counts for the last 14 days, for the quiet "this week" line in
// Settings. Local only; no streaks (they reward writing badly on purpose).
function SR_bumpDay(days) {
  const out = { ...(days || {}) };
  const today = new Date().toISOString().slice(0, 10);
  out[today] = (out[today] || 0) + 1;
  const cutoff = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
  for (const d of Object.keys(out)) if (d < cutoff) delete out[d];
  return out;
}

async function refreshWeekLine() {
  const { rewriteStats } = await chrome.storage.local.get(['rewriteStats']);
  const since = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
  const n = Object.entries((rewriteStats && rewriteStats.days) || {}).filter(([d]) => d >= since).reduce((a, [, c]) => a + c, 0);
  refs.weekLine.textContent = n ? `This week: ${n} rewrite${n === 1 ? '' : 's'} with Proofr.` : '';
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
let cloudChosen = false;
let deviceNeedsSetup = false;
let deviceSetupRunning = false;
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
  // Quotes too: values go inside attributes (model ids from a provider's list).
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s ?? '').replace(/[&<>"']/g, (c) => map[c]);
}
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function formatLatency(ms) {
  if (ms == null) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 14-7-7 14-2-5-5-2Z"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>';
const ICON_REDO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';
const ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const ICON_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M6.06 6.06A18.45 18.45 0 0 0 1 12s4 8 11 8a10.9 10.9 0 0 0 5.94-1.94M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/></svg>';

// === Provider status pill ===
async function refreshProviderPill() {
  const availability = await SR_deviceAvailability();
  deviceReady = availability === 'available' || availability === 'downloadable' || availability === 'downloading';
  deviceNeedsSetup = availability === 'downloadable' || availability === 'downloading';
  const provider = await CloudProvider.getConfig();
  const hasKey = providerReady(provider);
  const { engine } = await Settings.get();

  let label, runnable;
  if (engine === 'cloud') {
    label = hasKey ? `${provider.displayName} · connected` : 'Set up AI';
    runnable = hasKey;
  } else if (engine === 'device') {
    label = deviceReady ? 'On-device · local' : 'Unavailable';
    runnable = deviceReady;
  } else {
    label = deviceReady && !deviceNeedsSetup ? 'On-device · local'
      : hasKey ? `${provider.displayName} · connected`
      : deviceNeedsSetup ? 'Set up on-device AI' : 'Set up AI';
    runnable = deviceReady || hasKey;
  }

  // Green means ready now; a model still waiting for its download isn't.
  refs.providerPill.classList.toggle('connected', runnable && !(deviceNeedsSetup && !hasKey && engine !== 'cloud'));
  refs.providerPillText.textContent = label;
  refs.setupCard.classList.toggle('hidden', deviceReady || hasKey);
  // On-device works here and nothing else is set up: the provider form is
  // noise, so it waits behind one button.
  const offerCloud = deviceReady && !hasKey && !cloudChosen;
  refs.cloudOffer.classList.toggle('hidden', !offerCloud);
  refs.cloudSection.classList.toggle('collapsed', offerCloud);
  refs.deviceSetupCard.classList.toggle('hidden', !(deviceNeedsSetup || deviceSetupRunning));
  return { deviceReady, hasKey, runnable };
}

// === Quick engine switcher (the status pill) ===
// Lists only what can run right now: on-device if this Chrome has it, every
// provider that's connected, and Auto when both exist. One click switches;
// setting up something new still goes through Settings.
function closeEngineMenu() {
  refs.engineMenu.classList.add('hidden');
  refs.providerPill.setAttribute('aria-expanded', 'false');
}

async function engineChoices() {
  const { engine } = await Settings.get();
  const active = await CloudProvider.getActiveService();
  const choices = [];
  if (deviceReady) {
    choices.push({ id: 'device', title: 'On this computer', sub: deviceNeedsSetup ? 'Chrome\'s AI, needs a one-time setup' : 'Chrome\'s built-in AI, private', current: engine === 'device' });
  }
  const ready = [];
  for (const svc of SR_CLOUD_SERVICES) {
    const cfg = await CloudProvider.getConfig(svc.id);
    if (providerReady(cfg)) ready.push(cfg);
  }
  for (const cfg of ready) {
    choices.push({ id: `cloud:${cfg.id}`, title: cfg.displayName, sub: cfg.model, current: engine === 'cloud' && active === cfg.id });
  }
  if (deviceReady && ready.length) {
    const fallback = ready.find((c) => c.id === active) || ready[0];
    choices.push({ id: `auto:${fallback.id}`, title: 'Auto', sub: `On this computer first, then ${fallback.displayName}`, current: engine === 'auto' });
  }
  return choices;
}

async function openEngineMenu() {
  const choices = await engineChoices();
  refs.engineMenu.innerHTML = choices.map((c) => `
    <button type="button" class="engine-item" role="menuitemradio" aria-checked="${c.current}" data-choice="${escapeHtml(c.id)}">
      <b>${escapeHtml(c.title)}</b><span>${escapeHtml(c.sub || '')}</span>
    </button>`).join('')
    + (choices.length ? '<div class="engine-sep" role="separator"></div>' : '')
    + '<button type="button" class="engine-item" role="menuitem" data-choice="settings"><b>Add or change a provider…</b></button>';
  refs.engineMenu.classList.remove('hidden');
  refs.providerPill.setAttribute('aria-expanded', 'true');
  (refs.engineMenu.querySelector('[aria-checked="true"]') || refs.engineMenu.querySelector('.engine-item')).focus();
}

async function chooseEngine(choice) {
  closeEngineMenu();
  if (choice === 'settings') { toggleSettingsPanel(true); return; }
  if (choice === 'device') {
    await Settings.set({ srEngine: 'device' });
  } else {
    const [kind, id] = choice.split(':');
    await CloudProvider.setActiveService(id);
    await Settings.set({ srEngine: kind === 'auto' ? 'auto' : 'cloud' });
  }
  await refreshProviderPill();
  if (!refs.settingsPanel.classList.contains('hidden')) await refreshSettingsPanel();
  // On-device picked but the model isn't downloaded yet: show the setup card.
  if (choice === 'device' && deviceNeedsSetup) toggleSettingsPanel(true);
  showSavedToast();
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

  refs.cloudSection.classList.toggle('hidden', engine === 'device');
  // Open Advanced when it holds a non-default choice, so it's never hidden state.
  if (engine !== 'auto') refs.advancedSection.open = true;
  await refreshCloudSection();

  const { srHoverAssist } = await chrome.storage.sync.get(['srHoverAssist']);
  refs.hoverToggle.checked = !!srHoverAssist;
  const { srInsightsOn, srCoach, srPracticeSound } = await chrome.storage.sync.get(['srInsightsOn', 'srCoach', 'srPracticeSound']);
  refs.soundToggle.checked = srPracticeSound === true;
  refs.insightsToggle.checked = srInsightsOn !== false;
  refs.coachToggle.checked = srCoach === true;
  refreshWeekLine();
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
  activeServiceId = serviceId;
  refs.cloudServiceBtnLabel.textContent = meta.name;
  renderProviderMenu(serviceId);
  refs.customBaseURLRow.classList.toggle('hidden', serviceId !== 'custom');
  refs.providerNote.textContent = meta.note || '';

  const cfg = await CloudProvider.getConfig(serviceId);
  refs.cloudModelInput.value = cfg.model;
  refs.cloudModelInput.dataset.saved = cfg.model;
  refs.cloudModelInput.placeholder = meta.defaultModel || 'Connect first, then pick a model';
  loadModelList(serviceId);
  if (serviceId === 'custom') refs.customBaseURLInput.value = cfg.baseURL;
  refs.apiKeyLabel.textContent = `${meta.name} API key`;
  refs.keySection.classList.toggle('keyless', cfg.keyless);

  await renderKeyField(serviceId);
  closeModelMenu();
}

// Presets come from SR_CLOUD_SERVICES (constants.js), so a provider added
// there shows up here without touching this file.
let activeServiceId = 'groq';
function renderProviderMenu(currentId) {
  refs.cloudServiceMenu.innerHTML = SR_CLOUD_SERVICES.map((svc) => `
    <div class="cloud-select-item ${svc.id === currentId ? 'current' : ''}" data-value="${escapeHtml(svc.id)}" role="option" aria-selected="${svc.id === currentId}">
      <span>${escapeHtml(svc.name)}</span>${svc.keyless ? '<span class="cloud-select-tag">no key</span>' : ''}
    </div>`).join('');
}

// Only Groq, OpenAI, and OpenRouter were verified to send CORS headers for
// extension requests; any other endpoint needs host access to its origin.
function needsHostAccess(id) {
  if (typeof SR_needsHostAccess === 'function') return SR_needsHostAccess(id);
  return !['groq', 'openai', 'openrouter'].includes(id);
}

// === Settings panel: model picker, filled from the connection itself ===
// Once a provider is ready, its {baseURL}/models list loads on its own and
// the model field becomes a combobox over it: click or type to filter, pick
// with the mouse or arrows + Enter. A name the provider doesn't list can
// still be typed (some endpoints don't publish a list).
const modelLists = {};      // serviceId -> string[] (chat models only)
let modelActiveIndex = -1;
let modelFiltered = [];

function closeModelMenu() {
  refs.modelMenu.classList.add('hidden');
  refs.cloudModelInput.setAttribute('aria-expanded', 'false');
}

function renderModelMenu(query) {
  const list = modelLists[activeServiceId] || [];
  const q = (query || '').toLowerCase();
  modelFiltered = list.filter((m) => m.toLowerCase().includes(q));
  modelActiveIndex = -1;
  if (modelFiltered.length === 0) {
    refs.modelMenuList.innerHTML = `<div class="model-menu-empty">${list.length ? 'No matching models. Press Enter to use this name anyway.' : 'No models listed yet.'}</div>`;
    return;
  }
  const current = refs.cloudModelInput.dataset.saved || '';
  refs.modelMenuList.innerHTML = modelFiltered.map((m, i) =>
    `<div class="model-menu-item ${m === current ? 'current' : ''}" role="option" id="model-opt-${i}" data-model="${escapeHtml(m)}">${escapeHtml(m)}</div>`).join('');
}

function openModelMenu({ filter = false } = {}) {
  if (!(modelLists[activeServiceId] || []).length) return;
  renderModelMenu(filter ? refs.cloudModelInput.value : '');
  refs.modelMenu.classList.remove('hidden');
  refs.cloudModelInput.setAttribute('aria-expanded', 'true');
  refs.modelMenuList.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
}

function setModelHint(text) {
  refs.modelHint.textContent = text;
}

// Loads (or reuses) the provider's model list. `ids` skips the request when
// the caller just fetched /models itself (key save, Connect).
async function loadModelList(serviceId, { ids, open = false } = {}) {
  const cfg = await CloudProvider.getConfig(serviceId);
  if (!providerReady(cfg)) {
    setModelHint(cfg.keyless || cfg.keyOptional ? 'Connect to see the models this server has.' : 'Save a key to see the models this provider offers.');
    return;
  }
  if (ids) modelLists[serviceId] = ids;
  if (!modelLists[serviceId]) {
    setModelHint('Loading models…');
    try {
      modelLists[serviceId] = await SR_availableModels(cfg);
    } catch (error) {
      setModelHint(`Couldn't load the model list (${error.message || 'request failed'}). You can still type a model name.`);
      return;
    }
  }
  if (serviceId !== activeServiceId) return; // the user switched providers meanwhile
  const n = modelLists[serviceId].length;
  setModelHint(n ? `${n} model${n === 1 ? '' : 's'} available from ${cfg.displayName}. Click the field to choose.` : `${cfg.displayName} didn't list any chat models. Type a model name.`);
  if (open) {
    refs.cloudModelInput.focus();
    openModelMenu();
  }
}

async function selectModel(model) {
  refs.cloudModelInput.value = model;
  refs.cloudModelInput.dataset.saved = model;
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

  if (cfg.keyless) {
    // A server on this computer: nothing to paste, just check it's running.
    input.readOnly = false;
    input.value = '';
    refs.btnSaveKey.textContent = 'Connect';
    refs.btnSaveKey.classList.remove('btn-outline');
    refs.btnSaveKey.classList.add('btn-solid');
    refs.keyHint.textContent = `No key needed. Start ${cfg.displayName} on this computer, then press Connect.`;
    refs.keyHint.classList.remove('ok', 'hidden-fade');
    refs.btnClearKey.classList.add('hidden');
  } else if (keyEditing) {
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
    refs.keyHint.innerHTML = `${ICON_CHECK}Saved on this computer only`;
    refs.keyHint.classList.add('ok');
    refs.keyHint.classList.remove('hidden-fade');
    refs.btnClearKey.classList.remove('hidden');
  } else {
    // No key yet: start directly in an editable, empty state so first-time
    // setup doesn't need an extra "Change" click first.
    input.readOnly = false;
    input.type = 'text';
    input.value = '';
    input.placeholder = cfg.keyOptional ? 'API key (optional for a server on this computer)' : `${cfg.displayName} API key…`;
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
  // A saved key shows "Change" first; with no key yet the field is already
  // editable, so Save must save rather than switch modes (which would clear
  // the key the user just pasted).
  const hasSavedKey = refs.apiKeyInput.readOnly;
  if (keyEditing || !hasSavedKey) {
    // Endpoints other than the CORS-verified presets need host access to
    // their origin. Requested here, synchronously inside the click, while it
    // still counts as a user gesture.
    if (needsHostAccess(activeServiceId)) {
      const baseURL = activeServiceId === 'custom'
        ? refs.customBaseURLInput.value.trim()
        : SR_cloudServiceMeta(activeServiceId).baseURL;
      requestEndpointAccess(baseURL).finally(saveKey);
      return;
    }
    saveKey();
    return;
  }
  keyEditing = true;
  renderKeyField();
  refs.apiKeyInput.focus();
}

function requestEndpointAccess(baseURL) {
  let origin;
  try { origin = new URL(baseURL).origin + '/*'; } catch { return Promise.resolve(false); }
  return chrome.permissions.request({ origins: [origin] }).catch(() => false);
}

// Default models get retired by providers (Groq retired llama-3.3-70b in
// Aug 2026). After a key is verified, keep the user's model if the provider
// still lists it, else switch to the best available one.
async function healModel(serviceId, availableIds) {
  if (!availableIds.length || typeof SR_pickAvailableModel !== 'function') return;
  const cfg = await CloudProvider.getConfig(serviceId);
  if (availableIds.includes(cfg.model)) return;
  const picked = SR_pickAvailableModel(serviceId, availableIds);
  if (picked) {
    await CloudProvider.setModel(serviceId, picked);
    refs.cloudModelInput.value = picked;
    refs.cloudModelInput.dataset.saved = picked;
  }
}

async function connectKeyless(serviceId) {
  const cfg = await CloudProvider.getConfig(serviceId);
  refs.btnSaveKey.disabled = true;
  refs.btnSaveKey.textContent = 'Connecting…';
  try {
    const ids = await SR_availableModels(cfg);
    await healModel(serviceId, ids);
    refs.keyHint.innerHTML = `${ICON_CHECK}Connected`;
    refs.keyHint.classList.add('ok');
    await refreshProviderPill();
    showSavedToast();
    await loadModelList(serviceId, { ids, open: true });
  } catch (error) {
    refs.keyHint.textContent = `Couldn't reach ${cfg.displayName} at ${cfg.baseURL}. Is it running?`;
    refs.keyHint.classList.remove('ok');
  } finally {
    refs.btnSaveKey.disabled = false;
    refs.btnSaveKey.textContent = 'Connect';
  }
}

async function saveKey() {
  const serviceId = await CloudProvider.getActiveService();
  const current = await CloudProvider.getConfig(serviceId);
  const key = refs.apiKeyInput.value.trim();
  // No key to save for a local server: just check it answers.
  if (current.keyless || (current.keyOptional && !key)) {
    await connectKeyless(serviceId);
    return;
  }
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
    const listed = await res.json().catch(() => null);
    const ids = (listed && Array.isArray(listed.data) ? listed.data : []).map((m) => m && m.id).filter(Boolean);
    await CloudProvider.setKey(serviceId, key);
    await healModel(serviceId, SR_chatModels(ids));
    delete modelLists[serviceId]; // a different key can see different models
    keyEditing = false;
    await renderKeyField(serviceId);
    await refreshProviderPill();
    showSavedToast();
    // Just connected: show what this key can use, open, so the choice is visible.
    await loadModelList(serviceId, { ids: SR_chatModels(ids), open: true });
  } catch (error) {
    refs.keyHint.classList.remove('ok');
    refs.keyHint.textContent = `Could not reach ${cfg.displayName} to verify the key. Check your connection.`;
    refs.keyHint.classList.remove('hidden-fade');
  } finally {
    refs.btnSaveKey.disabled = false;
    if (keyEditing) refs.btnSaveKey.textContent = 'Save'; // stayed in edit mode after a failure; restore the label
  }
}

// An endpoint's own origin is granted when it's connected. Give it back when
// that endpoint stops being used. While hover actions are on,
// <all_urls> already covers it, so leave permissions alone then.
async function releaseEndpointAccess(baseURL) {
  let origin;
  try { origin = new URL(baseURL).origin + '/*'; } catch { return; }
  const { srHoverAssist } = await chrome.storage.sync.get(['srHoverAssist']);
  if (srHoverAssist) return;
  await chrome.permissions.remove({ origins: [origin] }).catch(() => {});
}

async function clearKey() {
  const serviceId = await CloudProvider.getActiveService();
  if (needsHostAccess(serviceId)) await releaseEndpointAccess((await CloudProvider.getConfig(serviceId)).baseURL);
  await CloudProvider.clearKey(serviceId);
  delete modelLists[serviceId];
  keyEditing = false;
  await renderKeyField(serviceId);
  await refreshProviderPill();
}

async function consumePanelHandoff() {
  const { srPanelPrefill, srPanelNotice } = await chrome.storage.local.get(['srPanelPrefill', 'srPanelNotice']);
  if (!srPanelPrefill && !srPanelNotice) return;
  await chrome.storage.local.remove(['srPanelPrefill', 'srPanelNotice']);
  if (!refs.settingsPanel.classList.contains('hidden')) toggleSettingsPanel(false);
  refs.panelNotice.textContent = srPanelNotice || '';
  refs.panelNotice.classList.toggle('hidden', !srPanelNotice);
  if (srPanelPrefill) {
    refs.ta.value = srPanelPrefill;
    autoGrow();
    updateCharCount();
    refs.sendBtn.disabled = false;
  }
  refs.ta.focus();
}

// Providers retire models (Groq's old default in Aug 2026, OpenAI's in Jan
// 2027). Once a day, when the panel opens, ask the provider which models it
// still lists and move off a retired one the same way saving a key does.
const MODEL_CHECK_MS = 24 * 60 * 60 * 1000;
async function checkModelStillListed() {
  try {
    const { srModelCheckedAt } = await chrome.storage.local.get(['srModelCheckedAt']);
    if (srModelCheckedAt && Date.now() - srModelCheckedAt < MODEL_CHECK_MS) return;
    const cfg = await CloudProvider.getConfig();
    if (!providerReady(cfg)) return;
    const ids = await SR_availableModels(cfg);
    await chrome.storage.local.set({ srModelCheckedAt: Date.now() });
    await healModel(cfg.id, ids);
  } catch {
    // Offline or provider hiccup: try again next time the panel opens.
  }
}

// Downloads Chrome's on-device model from a click (the download needs user
// activation, which the service worker never has). Declares English only,
// like SR_deviceAvailability: some Chrome builds support fewer languages, and
// the model downloaded is the same either way.
async function setUpOnDevice() {
  const LM = SR_deviceModel();
  if (!LM) return;
  deviceSetupRunning = true;
  refs.btnDeviceSetup.disabled = true;
  refs.deviceSetupStatus.textContent = 'Starting download…';
  try {
    const session = await LM.create({
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          refs.deviceSetupStatus.textContent = `Downloading Chrome's on-device model… ${Math.round((e.loaded || 0) * 100)}%`;
        });
      },
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
    });
    try { session.destroy && session.destroy(); } catch { /* ignore */ }
    refs.deviceSetupStatus.textContent = 'On-device AI is ready.';
  } catch (error) {
    refs.deviceSetupStatus.textContent = `Couldn't set up on-device AI: ${error.message || error}. You can connect a free Groq key below instead.`;
  } finally {
    deviceSetupRunning = false;
    refs.btnDeviceSetup.disabled = false;
    await refreshProviderPill();
  }
}

function toggleSettingsPanel(forceOpen) {
  const panel = refs.settingsPanel;
  const open = forceOpen !== undefined ? forceOpen : panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !open);
  syncChrome();
  if (open) {
    keyEditing = false;
    refreshSettingsPanel();
  } else {
    closeCloudMenu();
  }
}

// === Mode tag + palette ===
// One tone order everywhere (right-click menu, screenshots, here): the
// shared top list, minus the mode just used, gives the "Try as" chips.
const CHIP_LABELS = { grammar: 'Proofread', professional: 'Professional', friendly: 'Friendly', short: 'Concise', simple: 'Plain English' };

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
  if (view === 'languages') hasKeyCached = await CloudProvider.isReady();
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
  refs.sendBtn.disabled = !activeRun; // stays enabled as Stop while a rewrite runs
}

async function sendMessage() {
  // While a rewrite runs, the send button is a Stop button.
  if (activeRun) { activeRun.abort(); return; }
  const text = refs.ta.value.trim();
  if (!text) return;
  if (await startTurn(text, currentMode, currentMode === 'translate' ? currentTargetLang : undefined)) resetComposer();
}

// Starts a new entry for `text` in `mode`. Used by Send and by the "Try as"
// chips on a result (same text, another tone). Returns false when nothing
// can run yet and Settings was opened instead.
async function startTurn(text, mode, targetLang) {
  if (activeRun) return false;

  const hasKey = await CloudProvider.isReady();
  const { engine } = await Settings.get();
  const runnable = engine === 'cloud' ? hasKey : engine === 'device' ? deviceReady : (deviceReady || hasKey);
  if (!runnable) {
    toggleSettingsPanel(true);
    return false;
  }

  // On-device only covers five languages; anything else needs a cloud key.
  if (mode === 'translate' && !SR_isOnDeviceLanguage(targetLang) && !hasKey) {
    toggleSettingsPanel(true);
    return false;
  }

  const turn = {
    id: (crypto.randomUUID ? crypto.randomUUID() : `t${Date.now()}${Math.random()}`),
    ts: Date.now(),
    mode,
    targetLang: mode === 'translate' ? targetLang : undefined,
    inputText: text,
    status: 'pending',
  };
  turns.push(turn);
  renderThread();
  runTurn(turn);
  return true;
}

// === The one rewrite in flight ===
// Streamed text and the elapsed timer update only the pending card's body,
// never the whole thread (that re-render would run dozens of times a second).
let activeRun = null; // AbortController while a rewrite runs

function pendingBody(turn) {
  return refs.thread.querySelector(`.turn[data-id="${CSS.escape(turn.id)}"] .assistant-body`);
}

function paintPending(turn, elapsedMs) {
  const body = pendingBody(turn);
  if (!body) return;
  const secs = Math.floor(elapsedMs / 1000);
  const wait = turn.streamed
    ? ''
    : `<div class="status-text">${escapeHtml(turn.statusText || (turn.onDevice ? 'Working on this computer…' : 'Working…'))}${secs >= 2 ? ` ${secs}s` : ''}${turn.onDevice && secs >= 4 && !turn.statusText ? '<br>On-device AI can take a while on the first run.' : ''}</div>
      <div class="sr-skel-line"></div><div class="sr-skel-line"></div><div class="sr-skel-line short"></div>`;
  body.innerHTML = turn.streamed ? `<span class="streaming">${escapeHtml(turn.streamed)}</span>` : wait;
}

function setRunning(running) {
  refs.sendBtn.classList.toggle('stop', running);
  refs.sendBtn.title = running ? 'Stop' : 'Send (Ctrl/Cmd+Enter)';
  refs.sendBtn.setAttribute('aria-label', running ? 'Stop' : 'Send');
  refs.sendBtn.innerHTML = running ? ICON_STOP : ICON_SEND;
  refs.sendBtn.disabled = running ? false : refs.ta.value.trim().length === 0;
}

// Every call here is a fresh, single-turn request: SR_rewriteAuto only ever
// receives turn.inputText + turn.mode for THIS turn. Nothing from `turns`
// (the display log) is read into the request; that array exists purely to
// render past entries.
async function runTurn(turn, opts = {}) {
  const start = performance.now();
  const controller = new AbortController();
  activeRun = controller;
  setRunning(true);
  let frame = 0;
  const repaint = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; paintPending(turn, performance.now() - start); });
  };
  const ticker = setInterval(repaint, 1000);
  try {
    const provider = await CloudProvider.getConfig();
    const settings = await Settings.get();
    // Same rule as background.js rewriteNow: on Auto with a key, don't start a
    // multi-GB model download mid-rewrite; use the key until the user sets
    // on-device up from the card in Settings.
    const availability = await SR_deviceAvailability();
    const engine = (settings.engine === 'auto' && providerReady(provider) && availability !== 'available')
      ? 'cloud' : settings.engine;
    turn.onDevice = engine === 'device' || (engine === 'auto' && availability !== 'unavailable');
    repaint();
    const { text: rewritten, provider: providerId, engine: engineName } = await SR_rewriteAuto(turn.inputText, turn.mode, {
      provider,
      engine,
      allowDownload: true, // Send is a click, so a translation language pack may download
      targetLang: turn.targetLang,
      temperatureBoost: opts.boost ? 0.15 : 0,
      signal: controller.signal,
      onStatus: (msg) => { turn.statusText = msg; repaint(); },
      onToken: (soFar) => { turn.streamed = soFar; repaint(); },
    });
    turn.outputText = rewritten;
    turn.provider = providerId;
    // Same wording as background.js whereLabel: a server on this machine or
    // network isn't "sent" anywhere a user would worry about.
    // Also which model answered, like the page's result label.
    const model = provider && provider.model ? ` · ${String(provider.model).split('/').pop()}` : '';
    turn.where = providerId === 'device' ? `On this computer · ${engineName || 'Gemini Nano'}`
      : (typeof SR_isLocalURL === 'function' && SR_isLocalURL(provider.baseURL)) ? `On your computer or network${model}`
      : `Sent to ${SR_providerDisplayLabel(providerId)}${model}`;
    turn.latencyMs = Math.round(performance.now() - start);
    turn.status = 'done';
    delete turn.errorMessage;
    delete turn.statusText;
    await StatsManager.updateStats(turn.mode);
    if (turn.mode === 'grammar') {
      // Text pasted here is taken as the user's own draft. A word it masters
      // is named on the card.
      const res = await recordInsights(turn.inputText, rewritten);
      if (res && Array.isArray(res.mastered) && res.mastered.length) turn.mastered = res.mastered.slice(0, 3).map(String);
    }
  } catch (error) {
    turn.status = 'error';
    turn.errorMessage = controller.signal.aborted ? 'Stopped.' : (error.message || 'Something went wrong.');
  } finally {
    clearInterval(ticker);
    if (frame) cancelAnimationFrame(frame);
    activeRun = null;
    setRunning(false);
    delete turn.streamed;
    delete turn.onDevice;
  }
  turn.justFinished = true; // the card gets its one short reveal
  turns = await TurnLog.save(turns);
  renderThread();
  delete turn.justFinished;
}

async function regenerateTurn(turn) {
  if (activeRun) return;
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
// Proofread results show what changed (Copy still copies the plain text).
function turnBodyHtml(turn) {
  const ops = (turn.mode === 'grammar' && typeof SR_wordDiffForDisplay === 'function')
    ? SR_wordDiffForDisplay(turn.inputText, turn.outputText, turn.mode) : null;
  if (!ops || SR_diffCount(ops) === 0) return escapeHtml(turn.outputText);
  return ops.map((op) => op.type === 'ins' ? `<ins class="diff-ins">${escapeHtml(op.text)}</ins>`
    : op.type === 'del' ? `<del class="diff-del">${escapeHtml(op.text)}</del>`
    : escapeHtml(op.text)).join('');
}

function renderAssistantCard(turn) {
  const modeName = escapeHtml(SR_getToneName(turn.mode));

  if (turn.status === 'pending') {
    return `<div class="assistant-card">
      <div class="assistant-head"><span><span class="tag">${modeName}</span> · …</span><span></span></div>
      <div class="assistant-body">
        ${turn.statusText ? `<div class="status-text">${escapeHtml(turn.statusText)}</div>` : ''}
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

  // Say where the text went, in plain words.
  const engineName = escapeHtml(turn.where || (turn.provider === 'device' ? 'On this computer' : `Sent to ${SR_providerDisplayLabel(turn.provider)}`));
  return `<div class="assistant-card${turn.justFinished ? ' reveal' : ''}">
    <div class="assistant-head" title="${turn.latencyMs != null ? `Took ${formatLatency(turn.latencyMs)}` : ''}"><span><span class="tag">${modeName}</span> · ${engineName}</span></div>
    <div class="assistant-body">${turnBodyHtml(turn)}</div>
    ${turn.mastered ? `<div class="mastered-line"><span class="prog-icon ok" aria-hidden="true">${ICON_CHECK}</span><span>${turn.mastered.map((w) => `<b>${escapeHtml(w)}</b>`).join(' and ')}: ${turn.mastered.length === 1 ? '3 right in a row. Mastered.' : 'mastered.'}</span></div>` : ''}
    <div class="assistant-actions">
      <button class="chip-btn" data-action="copy">${ICON_COPY}Copy</button>
      <div class="retone"><span class="retone-label">Try as</span>${SR_MENU_TOP.filter((m) => m !== turn.mode && m !== 'translate').slice(0, 3)
        .map((m) => `<button class="chip-btn" data-action="retone" data-mode="${m}">${CHIP_LABELS[m] || SR_getToneName(m)}</button>`).join('')}</div>
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
    // One line, not a manual: the fastest way in, with the real shortcut.
    const keys = shortcutText ? `<kbd>${escapeHtml(shortcutText)}</kbd>` : 'the Proofr shortcut';
    refs.thread.innerHTML = `<div class="thread-empty">
      <p>Select text anywhere and press ${keys}. Or paste it below.</p>
    </div>`;
    return;
  }
  refs.thread.innerHTML = '';
  const frag = document.createDocumentFragment();
  turns.forEach((t) => frag.appendChild(renderTurn(t)));
  refs.thread.appendChild(frag);
  maybeShowRatePrompt();
  refs.thread.scrollTop = refs.thread.scrollHeight;
}

// A tip-jar link (Ko-fi / GitHub Sponsors), shown in Settings > About only
// once it's set. Empty means the row stays hidden: no link that goes nowhere.
const SUPPORT_URL = '';

// === Keyboard shortcut ===
// Chrome owns the binding (manifest "commands"); users change it on
// chrome://extensions/shortcuts. Read the real one so every mention matches,
// in the platform's own notation (Chrome returns ⌥⇧P on a Mac).
let shortcutText = '';
async function loadShortcut() {
  const commands = await chrome.commands.getAll().catch(() => []);
  const cmd = commands.find((c) => c.name === 'proofread-selection');
  shortcutText = (cmd && cmd.shortcut) || '';
  refs.shortcutValue.textContent = shortcutText || 'Not set';
}

// === Progress ===
// Built from srInsights in local storage: corrected word pairs and daily word
// counts, never sentences. background.js writes it (the panel's own
// Proofreads are sent there too, so every write goes through one queue).
// AI tips send the word list, and nothing else, to whichever AI is set up,
// and only when asked.
let progressView = null;

function recordInsights(before, after) {
  return chrome.runtime.sendMessage({ action: 'recordInsights', before, after }).catch(() => {});
}

function showTab(name) {
  const progress = name === 'progress';
  for (const [tab, on] of [[refs.tabWrite, !progress], [refs.tabProgress, progress]]) {
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  if (!refs.settingsPanel.classList.contains('hidden')) toggleSettingsPanel(false);
  refs.practicePanel.classList.add('hidden');
  refs.progressPanel.classList.toggle('hidden', !progress);
  syncChrome();
  closeEngineMenu();
  if (progress) renderProgress();
}

// Settings is its own page, not part of Write or Progress: the tabs go away
// while it's open (Back returns to the tab you were on). The trash icon
// clears Write's history, so it only shows on Write.
function syncChrome() {
  const settingsOpen = !refs.settingsPanel.classList.contains('hidden');
  const practicing = !refs.practicePanel.classList.contains('hidden');
  const onWrite = refs.tabWrite.getAttribute('aria-selected') === 'true';
  refs.tabBar.hidden = settingsOpen || practicing;
  refs.btnClearHistory.hidden = settingsOpen || practicing || !onWrite;
}

// Line through the weeks that have a rate; weeks with no words are gaps in x.
function sparkSvg(weeks) {
  const pts = weeks.map((w, i) => (w.per100 == null ? null : { i, v: w.per100 })).filter(Boolean);
  if (pts.length < 2) return '';
  const max = Math.max(...pts.map((p) => p.v), 1);
  const x = (i) => 8 + (i * 304) / (weeks.length - 1);
  const y = (v) => 34 - (v / max) * 28;
  const line = pts.map((p) => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return `<polyline class="line" points="${line}"/><circle class="dot" cx="${x(last.i).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="4"/>`;
}

const CHEVRON = '<svg class="chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5 7 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const PROG_ROWS = 6; // rows before "Show all"
let progShowAll = false;
let progTipsBusy = false;

// The AI a tips request would go to, or null with none: the connected
// provider, else Chrome's on-device model (downloadable counts: the click
// can start it).
async function tipsTarget() {
  const provider = await CloudProvider.getConfig();
  const { engine } = await Settings.get();
  const device = await SR_deviceAvailability();
  const deviceOk = !!SR_deviceModel() && device !== 'unavailable';
  if (providerReady(provider) && (engine === 'cloud' || device !== 'available')) {
    return { provider, label: provider.model ? `${provider.displayName} · ${provider.model}` : provider.displayName };
  }
  return deviceOk ? { provider: null, label: 'On this computer' } : null;
}

const shortDate = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

async function renderProgress() {
  if (typeof SR_insightsView !== 'function') return null;
  const { srInsights, srPracticeStats, srTipsCache } = await chrome.storage.local.get(['srInsights', 'srPracticeStats', 'srTipsCache']);
  const { srInsightsOn } = await chrome.storage.sync.get(['srInsightsOn']);
  const view = SR_insightsView(srInsights, Date.now());
  progressView = view;
  const empty = !view.total.proofreads;
  refs.progEmpty.hidden = !empty;
  refs.progBody.hidden = empty;
  refs.btnProgEmpty.hidden = srInsightsOn !== false;
  // A brand-new user has no words yet, but Mix-ups needs none.
  refs.btnProgMixups.hidden = !empty || srInsightsOn === false;
  if (empty) {
    refs.progEmptyTitle.textContent = srInsightsOn === false ? 'Progress is turned off' : 'Nothing here yet';
    refs.progEmptyText.textContent = srInsightsOn === false
      ? 'Turn on "Learn from my proofreads" and Proofr will keep the words it fixes for you, on this computer.'
      : 'Proofread something you wrote. The words Proofr fixes for you show up here, and so does how your mistake rate changes week to week.';
    return view;
  }

  // Hero: the headline in plain words (SR_progressHero), the trend, Practice.
  const hero = SR_progressHero(view);
  refs.progHeadLead.textContent = hero.lead;
  refs.progHeadText.textContent = hero.text;
  refs.progLine.textContent = hero.line;
  // The trend line only once there is a trend (two weeks with enough
  // writing); before that, how close this week is to counting. An <svg> has
  // no .hidden property, so the attribute is set directly.
  const trend = ['better', 'worse', 'flat'].includes(hero.state);
  const spark = trend ? sparkSvg(view.weeks) : '';
  refs.progSpark.innerHTML = spark;
  refs.progSpark.toggleAttribute('hidden', !spark);
  const week = view.weeks[view.weeks.length - 1] || { words: 0 };
  const need = SR_TREND_MIN_WORDS;
  refs.progStart.hidden = !!spark;
  if (!spark) {
    const w = Math.min(SR_count(week.words), need);
    refs.progStartFill.style.width = `${Math.round((w / need) * 100)}%`;
    refs.progStartText.textContent = w < need
      ? `${w} of ${need} words this week. Your trend line starts at ${need}.`
      : 'This week counts. Your trend line appears after one more week like it.';
  }
  const rated = view.weeks.filter((w) => w.per100 != null);
  refs.progSpark.setAttribute('aria-label', rated.length ? `Mistakes per 100 words by week: ${rated.map((w) => w.per100).join(', ')}` : '');
  const rows = SR_wordRows(view, srPracticeStats, Date.now());
  const masteredLine = SR_masteredLine(view);
  const masteredCount = masteredLine ? view.mastered.filter(SR_practicable).length : 0;
  refs.progMasteredChip.hidden = !masteredCount;
  refs.progMasteredChip.textContent = `${masteredCount} mastered`;
  refs.progPracticeChip.hidden = !rows.length;
  refs.progPracticeChip.textContent = `${rows.length} in practice`;
  // Nothing of theirs to drill: Practice still opens, on Mix-ups.
  refs.progPracticeNote.hidden = SR_practicePlan(view, srPracticeStats, 1, Date.now()).some((t) => !t.starter);

  // Your main habit (SR_habits): one headline, one example line, at most one "Also".
  const habits = typeof SR_habits === 'function' ? SR_habits(view) : [];
  refs.progHabitsCard.hidden = !habits.length;
  if (habits.length) {
    const [top, next] = habits;
    refs.progHabitTitle.textContent = top.label;
    // Examples the label already names ('You write "i" for "I"') add nothing.
    const eg = top.examples.filter((w) => !top.label.includes(`"${w}"`)).slice(0, 2);
    refs.progHabitEg.hidden = !eg.length;
    refs.progHabitEg.textContent = eg.length ? `Like ${eg.join(' and ')}.` : '';
    refs.progHabitAlso.hidden = !next;
    refs.progHabitAlso.textContent = next ? `Also: ${next.label[0].toLowerCase()}${next.label.slice(1)}` : '';
  }

  // Your words: a row per word, its tip (when the AI wrote one) inside.
  refs.progWordsCard.hidden = !rows.length && !masteredLine;
  const tipWords = rows.slice(0, SR_TIPS_MAX).map((r) => r.to);
  const tips = SR_tipsState(srTipsCache, tipWords);
  const tipFor = (to) => (tips.state === 'none' ? null : srTipsCache.tips[to] || null);
  const shown = progShowAll ? rows : rows.slice(0, PROG_ROWS);
  refs.progWords.innerHTML = shown.map((r, i) => {
    const tip = tipFor(r.to);
    return `<div class="prog-word"><button type="button" class="prog-word-row" aria-expanded="false" aria-controls="progWord${i}">`
      + `<span class="w"><b>${escapeHtml(r.to)}</b>${tip ? '<i class="prog-tip-badge">TIP</i>' : ''}</span>`
      + `<span class="prog-meter" role="img" aria-label="${escapeHtml(r.label)}"><b style="width:${Math.round(r.meter * 100)}%"></b></span>`
      + `<span class="lbl">${escapeHtml(r.label)}</span>${CHEVRON}</button>`
      + `<div class="prog-word-more" id="progWord${i}" hidden><p><s>${escapeHtml(r.from)}</s> → <span class="to">${escapeHtml(r.to)}</span>.${r.rule ? ` ${escapeHtml(r.rule)}` : ''}</p>`
      + `${r.history ? `<p>${escapeHtml(r.history)}</p>` : ''}${tip ? `<p class="ai"><i>AI TIP</i>${escapeHtml(tip)}</p>` : ''}</div></div>`;
  }).join('');
  refs.btnAllWords.hidden = rows.length <= PROG_ROWS;
  refs.btnAllWords.textContent = progShowAll ? 'Show fewer' : `Show all ${rows.length}`;
  refs.progMasteredLine.hidden = !masteredLine;
  refs.progMasteredLine.textContent = masteredLine;

  // The tips action: none yet, writing, up to date, stale, or no AI to ask.
  const target = rows.length ? await tipsTarget() : null;
  const state = progTipsBusy ? 'busy' : tips.state === 'fresh' ? 'fresh' : !target ? (rows.length ? 'noai' : 'off') : tips.state;
  // Up to date still offers one action, so the user is never stuck: tips for
  // the words the AI left without one, or else fresh wording for all of them.
  const missing = state === 'fresh' ? tips.missing : [];
  const canAsk = !!target;
  refs.btnTips.hidden = !(['none', 'stale', 'busy'].includes(state) || (state === 'fresh' && canAsk));
  refs.btnTips.disabled = state === 'busy';
  refs.btnTips.textContent = state === 'busy' ? 'Writing tips…' : state === 'stale' ? 'Refresh AI tips'
    : state === 'fresh' ? (missing.length ? `Get tips for ${missing.length} more` : 'Write new tips') : 'Get AI tips';
  refs.progTipsState.hidden = true;
  refs.progTipsState.textContent = '';
  const note = state === 'none' ? `One request to ${target.label}. Only these words are sent. New tips when your words change.`
    : state === 'stale' ? `Written ${shortDate(tips.date)}. Your words changed since then (new: ${tips.added.join(', ')}).`
      : state === 'fresh' && missing.length ? `AI tips from ${shortDate(tips.date)}. No tip yet for ${missing.join(', ')}.`
        : state === 'fresh' ? `AI tips from ${shortDate(tips.date)}, one per word marked TIP. ${canAsk ? 'Write new tips asks again for fresh wording: one request.' : ''}`.trim()
          : state === 'noai' ? 'Connect an AI in Settings to get tips.' : '';
  if (!progTipsBusy || note) {
    refs.progTipsNote.hidden = !note;
    refs.progTipsNote.textContent = note;
  }
  return view;
}

// Tips: one request for up to SR_TIPS_MAX of the words shown, to the AI from
// tipsTarget (from this click, so an on-device first download is allowed).
// The list is fenced as data, the reply checked like any other
// (SR_cleanOutput), and a tip kept only when it is about its own word
// (SR_checkTips). Kept until a new word shows up (SR_tipsState).
async function getTips() {
  const view = progressView;
  if (!view || progTipsBusy) return;
  const { srPracticeStats, srTipsCache } = await chrome.storage.local.get(['srPracticeStats', 'srTipsCache']);
  const all = SR_wordRows(view, srPracticeStats, Date.now()).slice(0, SR_TIPS_MAX);
  // Up to date but some words have no tip: ask for just those, keep the rest.
  const now = SR_tipsState(srTipsCache, all.map((r) => r.to));
  const only = now.state === 'fresh' && now.missing.length ? new Set(now.missing) : null;
  const rows = only ? all.filter((r) => only.has(r.to)) : all;
  const target = rows.length ? await tipsTarget() : null;
  if (!target) { renderProgress(); return; }
  const prompt = SR_buildTipsPrompt(rows, view.kinds);
  progTipsBusy = true;
  await renderProgress();
  try {
    let text;
    if (target.provider) {
      text = await SR_callCloud(target.provider, prompt, 0.4, 60 * rows.length + 60);
    } else {
      const session = await SR_deviceModel().create({ expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] });
      try { text = await session.prompt(SR_joinPrompt(prompt)); } finally { try { session.destroy(); } catch { /* ignore */ } }
    }
    const tips = SR_checkTips(SR_cleanOutput(text, { fence: prompt.fence }), rows);
    if (!Object.keys(tips).length) throw new Error('The AI\'s tips didn\'t match your words, so Proofr didn\'t show them. Try again.');
    const merged = only ? { ...srTipsCache.tips, ...tips } : tips;
    await chrome.storage.local.set({ srTipsCache: { words: all.map((r) => r.to), date: Date.now(), tips: merged } });
    progTipsBusy = false;
    await renderProgress();
  } catch (error) {
    progTipsBusy = false;
    await renderProgress();
    refs.progTipsNote.hidden = false;
    refs.progTipsNote.textContent = error.message || 'Couldn\'t get tips right now. Try again.';
  }
}

// === Practice ===
// One question per word, one answer each. SR_practicePlan picks the words the
// user needs most (missed last time first, words just got right last). Each
// word has a level (srPracticeStats): 1 pick from 2, 2 pick from 3, 3 tap the
// mistake, 4 type it; SR_servedLevel nudges it so about 4 in 5 land. A miss
// brings the word back 3-5 questions later with a different sentence.
// Sentences come from a pool of questions the user's AI wrote (checked by
// code, then by Proofread) and are never shown twice (srPracticeSeen holds
// fingerprints, not text); with none waiting, a local template is used at
// once. Practice never counts toward mastery, which only real writing earns.
// With fewer than 4 words of their own, classic mix-ups (SR_PRACTICE_STARTERS)
// fill the round to 6; they keep their own stats and never touch Progress.
// Three modes: Mix-ups (starters only, one pass), Quick (10 words) and Keep going (every word until it's right
// twice this session, a checkpoint every 10 answers, a natural end).
const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const RING_C = 2 * Math.PI * 50;
const PRACTICE_MAX = 10;
const PRACTICE_STRETCH = 10; // Keep going: answers between checkpoints
const PRACTICE_DONE_AT = 2; // Keep going: right answers that finish a word for the session
const PRACTICE_LEVEL_NAMES = { 2: 'pick from three', 3: 'spot it yourself', 4: 'type it yourself' };
const PRACTICE_READY = 5; // AI questions kept waiting for the round's words
const PRACTICE_REQUEUE_MAX = 4;
const PRACTICE_ASK = { 1: 'Which word is right?', 2: 'Which word is right?', 3: 'Tap the mistake', 4: 'Type the missing word' };
const practice = { mode: 'quick', rights: new Map(), prevBest: 0, sound: false, plan: [], queue: [], q: 0, cur: null, seed: 0, total: 0, firstTry: 0, combo: 0, best: 0, first: new Map(), recent: [], slots: [], requeued: 0, answered: false, sheetOpen: false, stats: {}, pool: { v: 2, words: {} }, seen: new Set(), seenList: [], session: new Set() };

// "Practice now" opens the game-mode tiles. Nothing on it names a word: the
// user's words are the answers. Mix-ups (starters only) works with no words of
// the user's own; the other two need some. All tiles look alike at rest; opened
// from the keyboard (click detail 0), the last mode used has focus, and Enter
// with nothing focused starts it.
async function startPractice(e) {
  if (!progressView || typeof SR_practicePlan !== 'function') return;
  const { srPracticeMode, srPracticeStats, srPracticeBest } = await chrome.storage.local.get(['srPracticeMode', 'srPracticeStats', 'srPracticeBest']);
  const own = SR_practicePlan(progressView, srPracticeStats, Infinity, Date.now()).filter((t) => !t.starter).length;
  refs.prWhy.textContent = own ? `${own} of your ${own === 1 ? 'words needs' : 'words need'} practice` : 'Mix-ups for now. Your own words show up here as you proofread.';
  refs.prBestLine.hidden = !SR_count(srPracticeBest);
  refs.prBestLine.textContent = `Best run: ${SR_count(srPracticeBest)}`;
  for (const b of [refs.prQuick, refs.prKeep]) {
    b.disabled = !own;
    b.querySelector('.pr-tile-text span').textContent = own ? (b === refs.prQuick ? '10 questions' : 'Until you\'re done') : 'Proofread more to unlock';
  }
  refs.progressPanel.classList.add('hidden');
  refs.practicePanel.classList.remove('hidden');
  syncChrome(); // Practice is its own screen: no tabs above it
  for (const x of [refs.prDone, refs.prStage, refs.prCheckpoint, refs.prBar, refs.prTally, refs.prCombo]) x.hidden = true;
  closeSheet();
  refs.prChoose.hidden = false;
  const last = refs.prTiles.querySelector(`[data-mode="${srPracticeMode}"]`);
  const pick = last && !last.disabled ? last : own ? refs.prQuick : refs.prMix;
  practice.pick = pick.dataset.mode;
  if (!e || e.detail === 0) pick.focus();
  else document.activeElement?.blur();
}

async function beginPractice(mode) {
  const view = progressView;
  if (!view || refs.prChoose.hidden) return; // once per chooser: a double tap starts one round
  refs.prChoose.hidden = true;
  const { srPracticeStats, srPracticePool, srPracticeSeen, srPracticeBest } = await chrome.storage.local.get(['srPracticeStats', 'srPracticePool', 'srPracticeSeen', 'srPracticeBest']);
  const { srPracticeSound } = await chrome.storage.sync.get(['srPracticeSound']);
  const plan = mode === 'mixups' ? SR_mixupPlan(srPracticeStats, PRACTICE_MAX, Date.now())
    : SR_practicePlan(view, srPracticeStats, mode === 'keep' ? Infinity : PRACTICE_MAX, Date.now());
  if (!plan.length) { closePractice(); return; }
  chrome.storage.local.set({ srPracticeMode: mode }).catch(() => {});
  const seenList = SR_addSeen(srPracticeSeen, []);
  Object.assign(practice, {
    mode, run: (practice.run || 0) + 1, rights: new Map(), prevBest: SR_count(srPracticeBest), sound: srPracticeSound === true, plan, queue: plan.map((target) => ({ target })), q: 0, cur: null, seed: Math.floor(Math.random() * 1e6), total: plan.length,
    firstTry: 0, combo: 0, best: 0, first: new Map(), recent: [], slots: [], requeued: 0, answered: false, sheetOpen: false,
    stats: SR_mergePracticeStats(srPracticeStats, []), pool: SR_practicePoolRead(srPracticePool), seen: new Set(seenList), seenList, session: new Set(),
  });
  // Without an AI to write for them, words with no built-in sentence sit this round out.
  if (!plan.every(canAsk) && !(await practiceWriter())) {
    practice.plan = plan.filter(canAsk);
    practice.queue = practice.queue.filter((x) => canAsk(x.target));
    practice.total = practice.plan.length;
    if (!practice.plan.length) { closePractice(); return; }
  }
  refs.prStage.hidden = false;
  refs.prBar.hidden = mode === 'keep';
  refs.prTally.hidden = mode !== 'keep';
  setBar(0);
  askNext(); // a waiting question or a template; waits on the AI only for a word with neither
  refillPracticePool();
}

function savePractice() {
  return chrome.storage.local.set({ srPracticeStats: practice.stats, srPracticePool: practice.pool, srPracticeSeen: practice.seenList, srPracticeBest: Math.max(practice.prevBest, practice.best) }).catch(() => {});
}

// Built when shown, so a batch that just arrived is used: a waiting AI question
// not seen before, else a template whose sentence hasn't come up this round;
// either way, none that shows a later word's fix.
function buildQuestion(target) {
  // Words still to come this round: no sentence may show their fix early.
  const later = practice.queue.slice(practice.q + 1).map((x) => x.target);
  const ai = SR_poolTake(practice.pool, target, practice.seen, later);
  let q = ai && SR_practiceQuestion(target, ai.filled, practice.seed + practice.q);
  let print = ai && SR_questionPrint(ai);
  if (!q || q.source !== 'ai') {
    // No built-in sentence either: this word waits for the AI (askNext).
    const t = SR_freshTemplate(target, practice.seed + practice.q, practice.session, later);
    if (!t) return null;
    ({ q, print } = t);
  } else {
    practice.seen.add(print);
    practice.seenList = SR_addSeen(practice.seenList, [print]);
  }
  practice.session.add(print);
  const level = SR_servedLevel(practice.stats[SR_practiceKey(target)]?.level, practice.recent);
  return { ...q, target, level, checked: ai ? ai.checked : null };
}

// Keeps at least PRACTICE_READY AI questions waiting for the round's words.
// On-device: one sentence per word (4 a refill), each on a rotating topic, then
// a Proofread of each. A provider: one batched call for 8, then one Proofread
// over the batch (2 calls, within the daily budget). Only the words and topics
// are sent; code makes the blanks and keeps only what Proofread leaves alone.
// Quietly does nothing with learning off, without an AI, past the budget, or
// on error: templates still work. practice.lastDrops keeps why sentences were
// dropped (counts only), for measuring on a real model.
// The AI Practice can write with right now: { onDevice, provider, budget }, or
// null with learning off, no AI, or today's provider budget spent.
async function practiceWriter() {
  const { srInsightsOn } = await chrome.storage.sync.get(['srInsightsOn']);
  if (srInsightsOn === false) return null;
  const onDevice = (await SR_deviceAvailability()) === 'available';
  if (onDevice) return { onDevice, provider: null };
  const provider = await CloudProvider.getConfig();
  if (!providerReady(provider)) return null;
  const { srPracticeGenDay } = await chrome.storage.local.get(['srPracticeGenDay']);
  const budget = SR_practiceBudget(srPracticeGenDay, SR_dayKey(Date.now()), 2);
  return budget.ok ? { onDevice, provider, budget } : null;
}

// force: write even with enough waiting, for a word that has none. Returns the
// refill under way, so a caller can wait for it.
let refilling = null;
function refillPracticePool(force) {
  const ready = () => practice.plan.reduce((n, t) => n + (practice.pool.words[t.to]?.length || 0), 0);
  if (refilling) return refilling;
  if (!force && ready() >= PRACTICE_READY) return Promise.resolve();
  refilling = writePracticeQuestions().finally(() => { refilling = null; });
  return refilling;
}

async function writePracticeQuestions() {
  try {
    const writer = await practiceWriter();
    if (!writer) return;
    const { onDevice, provider } = writer;
    if (!onDevice) await chrome.storage.local.set({ srPracticeGenDay: writer.budget.next });
    const words = [...practice.plan].sort((a, b) => (practice.pool.words[a.to]?.length || 0) - (practice.pool.words[b.to]?.length || 0));
    const items = SR_practiceItems(words, onDevice ? 4 : 8, Math.floor(Math.random() * SR_PRACTICE_TOPICS.length));
    const proofread = async (text) => (await SR_rewriteAuto(text, 'grammar', { provider, engine: onDevice ? 'device' : 'cloud' })).text;
    const { questions, drops } = onDevice
      ? await SR_makeQuestionsEach(items, { write: writeOnDevice, proofread, seen: practice.seen })
      : await SR_makeQuestions(items, { generate: (parts) => SR_callCloud(provider, parts, 0.9, 80 * items.length), proofread, seen: practice.seen });
    practice.lastDrops = drops;
    SR_practicePoolAdd(practice.pool, questions, practice.seen);
    await savePractice();
  } catch (_) { /* templates still work */ }
}

// On-device sentence writer: a base session holding the rules and examples
// (made once), cloned per word so each request starts clean.
let practiceBase = null;
async function writeOnDevice(item) {
  if (!practiceBase) {
    const parts = SR_buildSentenceParts();
    const initialPrompts = [{ role: 'system', content: parts.system }, ...parts.shots.flatMap(([u, a]) => [{ role: 'user', content: u }, { role: 'assistant', content: a }])];
    const opts = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }], initialPrompts };
    practiceBase = { parts, opts, promise: SR_deviceModel().create(opts) };
    practiceBase.promise.catch(() => { practiceBase = null; });
  }
  const { parts, opts, promise } = practiceBase;
  const base = await promise;
  // Without clone(), a fresh session with the same rules: slower, never shares history.
  const session = typeof base.clone === 'function' ? await base.clone() : await SR_deviceModel().create(opts);
  try { return await SR_within(session.prompt(parts.user(SR_practiceWord(item), item.topic)), SR_DEVICE_TIMEOUT_MS); } finally { try { session.destroy(); } catch (_) { /* ignore */ } }
}

function setBar(done) {
  refs.prTally.textContent = `${done} answered · best run ${practice.best}`;
  const pct = practice.queue.length ? Math.round((done / practice.queue.length) * 100) : 0;
  refs.prBarFill.style.width = `${pct}%`;
  refs.prBar.setAttribute('aria-valuenow', String(pct));
}

// Restart a one-shot animation class.
function replay(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

// A word with a built-in sentence or a waiting AI question can be asked now.
function canAsk(target) {
  return !!SR_practicePhrase(target) || !!practice.pool.words[target.to]?.length;
}

// Shows the next question. A word with no question yet (no built-in sentence,
// none written by the AI) trades places with the next word that has one; with
// none left, Practice waits for the AI to write, and drops what it still can't ask.
async function askNext() {
  const run = practice.run;
  const buildable = () => (practice.cur = buildQuestion(practice.queue[practice.q].target)) !== null;
  const swap = () => {
    if (buildable()) return true;
    const j = practice.queue.findIndex((x, i) => i > practice.q && canAsk(x.target));
    if (j < 0) return false;
    practice.queue.splice(practice.q, 0, ...practice.queue.splice(j, 1));
    return buildable();
  };
  if (swap()) { showQuestion(); return; }
  refs.prAsk.textContent = 'Writing a question…';
  refs.prSentence.innerHTML = '';
  refs.prChoices.hidden = true;
  refs.prType.hidden = true;
  refs.prHint.hidden = true;
  await refillPracticePool(true);
  if (run !== practice.run || refs.practicePanel.classList.contains('hidden')) return;
  if (swap()) { showQuestion(); return; }
  // Nothing more can be asked: drop the words left without a question.
  const stuck = new Set(practice.queue.slice(practice.q).map((x) => x.target));
  practice.queue.splice(practice.q);
  practice.plan = practice.plan.filter((t) => !stuck.has(t));
  if (practice.first.size) finishPractice(false);
  else closePractice();
}

function showQuestion() {
  const cur = practice.cur;
  const { tokens, k, target, level } = cur;
  practice.answered = false;
  // Level 3 shows the user's own mistake in place, every word a plain button to
  // tap; the others show the blank to fill. Punctuation is text, kept with its
  // word in one unbreakable .pr-w (opening marks with the next word).
  const words = [];
  let open = '';
  tokens.forEach((t, j) => {
    if (t.punct) {
      if (words.length) words[words.length - 1].after += escapeHtml(t.text);
      else open += escapeHtml(t.text);
      return;
    }
    const html = level === 3 ? `<button type="button" class="pr-chip" data-j="${j}">${escapeHtml(j === k ? target.from : t.text)}</button>`
      : j === k ? '<span class="pr-blank" id="prBlank" aria-label="blank"></span>' : escapeHtml(t.text);
    words.push({ before: open, html, after: '' });
    open = '';
  });
  refs.prSentence.innerHTML = words.map((w) => `<span class="pr-w">${w.before}${w.html}${w.after}</span>`).join(' ') + open;
  refs.prAsk.textContent = PRACTICE_ASK[level];
  refs.prHint.hidden = level !== 3;
  refs.prLeft.textContent = practice.mode === 'keep' ? '' : `${practice.q + 1} of ${practice.queue.length}`;
  refs.prChoices.hidden = level > 2;
  refs.prType.hidden = level !== 4;
  if (level <= 2) {
    const raw = SR_practiceChoices(target, practice.seed + practice.q * 7);
    const own = String(target.from).replace(/[<>&"]/g, '').trim();
    // Level 1: just the fix and the user's own mistake.
    const wrong = raw.filter((w) => w !== target.to && (level === 2 || w === own));
    // The right answer's place can't be guessed from the last questions (SR_answerSlot).
    const want = SR_answerSlot(wrong.length + 1, practice.slots);
    practice.slots.push(want);
    wrong.splice(want, 0, target.to);
    refs.prChoices.innerHTML = wrong.map((w, n) =>
      `<button type="button" class="pr-choice" data-word="${escapeHtml(w)}"><span class="key" aria-hidden="true">${n + 1}</span>${escapeHtml(w)}</button>`).join('');
  }
  replay(refs.prStage, 'enter');
  if (level === 4) {
    refs.prInput.value = '';
    refs.prInput.disabled = false;
    refs.prCheck.disabled = false;
    refs.prInput.focus();
  } else if (level === 3) {
    // No word looks picked: after a key, focus waits on the sentence so one Tab reaches the first word.
    if (practiceByKey) refs.prSentence.focus();
    else document.activeElement?.blur();
  } else refs.prChoices.querySelector('.pr-choice')?.focus();
}

// The last input in Practice: a key (true) or a pointer (false).
let practiceByKey = false;

function onChoice(word) {
  if (practice.answered || practice.sheetOpen || !practice.cur || practice.cur.level > 2) return;
  const { target } = practice.cur;
  for (const b of refs.prChoices.querySelectorAll('.pr-choice')) {
    b.disabled = true;
    if (b.dataset.word === target.to) b.classList.add('is-answer');
    else if (b.dataset.word === word) b.classList.add('picked-wrong');
  }
  fillBlank(word === target.to);
  answer(word === target.to);
}

// Level 3: one tap. The mistake shows its fix in place; a wrong tap shakes.
function onChip(j) {
  if (practice.answered || practice.sheetOpen || !practice.cur || practice.cur.level !== 3) return;
  const { k, target } = practice.cur;
  const right = j === k;
  for (const b of refs.prSentence.querySelectorAll('.pr-chip')) b.disabled = true;
  const fix = refs.prSentence.querySelector(`.pr-chip[data-j="${k}"]`);
  fix.textContent = target.to;
  replay(fix, right ? 'fixed' : 'missed');
  if (!right) replay(refs.prSentence.querySelector(`.pr-chip[data-j="${j}"]`), 'nope');
  answer(right);
}

// Level 4: the typed word, checked by SR_typedRight.
function onTyped() {
  if (practice.answered || practice.sheetOpen || !practice.cur || practice.cur.level !== 4) return;
  if (!refs.prInput.value.trim()) { refs.prInput.focus(); return; }
  const right = SR_typedRight(refs.prInput.value, practice.cur.target);
  refs.prInput.disabled = true;
  refs.prCheck.disabled = true;
  fillBlank(right);
  answer(right);
}

function fillBlank(right) {
  const blank = document.getElementById('prBlank');
  if (!blank) return;
  blank.textContent = practice.cur.target.to;
  replay(blank, right ? 'right' : 'wrong');
}

// Records one answer (stats saved at once, so leaving mid-round keeps it),
// brings a missed word back later in the round, and shows the feedback.
function answer(right) {
  const { target, level } = practice.cur;
  const again = !!practice.queue[practice.q].again;
  const key = SR_practiceKey(target);
  const before = SR_practiceLevel(practice.stats[key]?.level);
  practice.answered = true;
  practice.stats = SR_mergePracticeStats(practice.stats, [{ ...target, right, served: level, again }], Date.now());
  practice.recent.push(right);
  const up = SR_practiceLevel(practice.stats[key]?.level);
  if (right) practice.rights.set(key, (practice.rights.get(key) || 0) + 1);
  chime(right);
  if (!practice.first.has(key)) { practice.first.set(key, { to: target.to, right }); if (right) practice.firstTry++; }
  if (right) { practice.combo++; practice.best = Math.max(practice.best, practice.combo); } else practice.combo = 0;
  if (!right && practice.requeued < PRACTICE_REQUEUE_MAX) {
    practice.queue.splice(SR_requeueAt(practice.q, practice.queue.length), 0, { target, again: true });
    practice.requeued++;
  }
  savePractice();
  refillPracticePool();
  setBar(practice.mode === 'keep' ? practice.recent.length : practice.q + 1);
  if (practice.combo >= 2) {
    refs.prCombo.hidden = false;
    refs.prCombo.textContent = `${practice.combo} in a row`;
    refs.prCombo.classList.remove('bump', 'big');
    replay(refs.prCombo, practice.combo === 5 || practice.combo === 10 ? 'big' : 'bump');
  } else refs.prCombo.hidden = true;
  refs.prSheetLevel.hidden = up <= before;
  refs.prSheetLevel.textContent = up > before ? `${target.to}: level ${up}, ${PRACTICE_LEVEL_NAMES[up]}.` : '';
  const rule = practice.cur.tokens[practice.cur.k].target.rule || '';
  openSheet(right,
    right ? 'Correct' : 'Not quite',
    right ? (rule || `"${target.to}" it is.`) : `The right word is "${target.to}". ${rule}`.trim());
}

function openSheet(good, title, text) {
  practice.sheetOpen = true;
  refs.prSheet.className = `pr-sheet open ${good ? 'good' : 'bad'}`;
  refs.prSheetIcon.innerHTML = good ? ICON_CHECK : ICON_X;
  refs.prSheetTitle.textContent = title;
  refs.prSheetText.textContent = text;
  refs.prContinue.textContent = practice.q + 1 >= practice.queue.length && !keepNeeds().length ? 'See results' : 'Continue';
  refs.prContinue.focus();
}

function closeSheet() {
  practice.sheetOpen = false;
  refs.prSheet.className = 'pr-sheet';
}

// Keep going: the words not yet right PRACTICE_DONE_AT times this session.
function keepNeeds() {
  if (practice.mode !== 'keep') return [];
  return practice.plan.filter((t) => (practice.rights.get(SR_practiceKey(t)) || 0) < PRACTICE_DONE_AT);
}

function onContinue() {
  if (!practice.sheetOpen) return;
  closeSheet();
  if (practice.q + 1 >= practice.queue.length) {
    // Keep going: the undone words again, the word just asked last.
    const last = practice.queue[practice.q].target;
    const needs = keepNeeds().sort((a, b) => (a === last) - (b === last));
    practice.queue.push(...needs.map((target) => ({ target })));
  }
  if (practice.q + 1 >= practice.queue.length) { finishPractice(practice.mode === 'keep'); return; }
  if (practice.mode === 'keep' && practice.recent.length % PRACTICE_STRETCH === 0) { showCheckpoint(); return; }
  practice.q++;
  askNext();
}

function showCheckpoint() {
  refs.prStage.hidden = true;
  refs.prCheckpoint.hidden = false;
  const right = practice.recent.slice(-PRACTICE_STRETCH).filter(Boolean).length;
  refs.prCheckText.textContent = `This stretch: ${right}/${PRACTICE_STRETCH}. Best run: ${practice.best} in a row.`;
  refs.btnPrMore.focus();
}

function closeCheckpoint(more) {
  if (refs.prCheckpoint.hidden) return;
  refs.prCheckpoint.hidden = true;
  if (!more) { finishPractice(false); return; }
  refs.prStage.hidden = false;
  practice.q++;
  askNext();
}

// Optional (srPracticeSound, off by default): a soft two-note chime for a
// right answer, one low tone for a wrong one, made here with Web Audio.
let practiceAudio = null;
function chime(right) {
  if (!practice.sound) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    practiceAudio = practiceAudio || new AC();
    const t0 = practiceAudio.currentTime;
    const len = right ? 0.1 : 0.18;
    for (const [freq, at] of right ? [[660, 0], [880, 0.08]] : [[196, 0]]) {
      const osc = practiceAudio.createOscillator(), gain = practiceAudio.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.05, t0 + at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
      osc.connect(gain).connect(practiceAudio.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + len);
    }
  } catch (_) { /* no sound is fine */ }
}

// natural: Keep going ran out of words that need practice.
function finishPractice(natural) {
  refs.prStage.hidden = true;
  refs.prCheckpoint.hidden = true;
  refs.prCombo.hidden = true;
  refs.prDone.hidden = false;
  practice.total = practice.first.size;
  const { firstTry, total, best } = practice;
  const pct = total ? Math.round((firstTry / total) * 100) : 0;
  refs.prRing.style.strokeDasharray = `${RING_C}`;
  refs.prRingSvg.setAttribute('aria-label', `${firstTry} of ${total} right`);
  // The ring fills and the score counts up together, frame by frame (both at
  // once with reduced motion). Ends exactly on the final values.
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const start = performance.now();
  const paint = (p) => {
    const e = 1 - (1 - p) ** 3;
    refs.prRing.style.strokeDashoffset = `${RING_C * (1 - (pct / 100) * e)}`;
    refs.prScore.textContent = `${Math.round(firstTry * e)}/${total}`;
  };
  let settled = false;
  const tick = (t) => { if (settled) return; const p = reduce ? 1 : Math.min(1, (t - start) / 800); paint(p); if (p < 1) requestAnimationFrame(tick); else settled = true; };
  paint(reduce ? 1 : 0);
  requestAnimationFrame(tick);
  // Frames don't run while the panel isn't painting (hidden, screen locked):
  // the real score must still land, animation or not.
  setTimeout(() => { if (!settled) { settled = true; paint(1); } }, 900);
  refs.prDoneTitle.textContent = pct === 100 ? 'Perfect round' : pct >= 70 ? 'Nice work' : 'Good practice';
  refs.prDoneText.textContent = (natural ? 'That\'s everything you needed today. ' : '')
    + (practice.mode === 'keep' ? `${practice.recent.length} answered. ` : '')
    + (best >= 2 ? `Best run: ${best} in a row. ` : '')
    // A first round has nothing to beat: "New best" only once there was one.
    + (best >= 2 && practice.prevBest > 0 && best > practice.prevBest ? 'New best. ' : '')
    + (pct === 100 ? 'Your progress shows in your real writing, on the Progress tab.' : 'The ones you missed come back in your next round.');
  refs.prWords.innerHTML = [...practice.first.values()].map((w) => `<span class="pr-word ${w.right ? 'ok' : 'again'}">${escapeHtml(w.to)}</span>`).join('');
  refs.btnPracticeAgain.focus();
}

function closePractice() {
  closeSheet();
  refs.prCheckpoint.hidden = true;
  refs.practicePanel.classList.add('hidden');
  showTab('progress');
}


// === Rating ask ===
// Under a successful result once SR_rateDue says so (the same rewriteStats
// counter every surface increments). Same ask for everyone, no reward, never
// blocks anything. "Rate it" retires it; "Not now" asks once more later.
async function maybeShowRatePrompt() {
  const last = turns[turns.length - 1];
  if (!last || last.status !== 'done') return;
  const { rewriteStats, srRateAsked } = await chrome.storage.local.get(['rewriteStats', 'srRateAsked']);
  if (!SR_rateDue(rewriteStats, srRateAsked)) return;
  if (refs.thread.querySelector('.rate-line')) return;
  const line = document.createElement('div');
  line.className = 'rate-line';
  line.innerHTML = `<span>Finding Proofr useful? A rating helps other people find it.</span>
    <a href="${SR_REVIEWS_URL}" target="_blank" rel="noopener" data-rate="rate">Rate it</a>
    <button type="button" data-rate="later">${SR_rateDecline(srRateAsked)}</button>`;
  line.addEventListener('click', async (e) => {
    const choice = e.target.closest('[data-rate]');
    if (!choice) return;
    await chrome.storage.local.set({ srRateAsked: SR_rateAfter(choice.dataset.rate, rewriteStats, srRateAsked) });
    line.remove();
  });
  refs.thread.appendChild(line);
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
    else if (btn.dataset.action === 'retone') await startTurn(turn.inputText, btn.dataset.mode, turn.targetLang);
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
      <p><strong>On any page:</strong> select text → right-click → Proofr, or press <strong>${escapeHtml(shortcutText || 'your Proofr shortcut')}</strong> to proofread it (change it under Settings → Keyboard shortcut). In a text box the selection is replaced in place; press Ctrl+Z (⌘Z on Mac) to undo. Turn on <strong>Hover actions</strong> in Settings to summarize, simplify, or translate any paragraph you're reading.</p>
      <p><strong>In this panel:</strong> type or paste text, click the <strong>/Mode</strong> tag (or type <strong>/</strong>) to pick a mode, then <strong>Ctrl/Cmd+Enter</strong> or the send button. Each entry in the list is independent. Proofr doesn't read earlier entries when rewriting a new one.</p>
      <p><strong>How it rewrites:</strong> if your Chrome has built-in AI, rewrites in English, Spanish, French, German, and Japanese run on-device with no key. Other languages, the hover "Ask" box, and Chrome without built-in AI use your cloud provider key. The pill up top shows which is active.</p>
      <p>Questions? <a href="mailto:cjcarito15@gmail.com">cjcarito15@gmail.com</a> · <a href="https://github.com/civarry" target="_blank" rel="noopener">github.com/civarry</a></p>
    `);
  },

};

// === Wire up ===
document.addEventListener('DOMContentLoaded', async () => {
  [
    'mark', 'providerPill', 'providerPillText', 'engineMenu', 'btnClearHistory', 'tabBar', 'btnSettings', 'btnSettingsBack',
    'settingsPanel', 'savedToast', 'setupCard', 'deviceSetupCard', 'btnDeviceSetup', 'deviceSetupStatus',
    'hoverToggle', 'hoverHint', 'engineSeg', 'engineHint',
    'cloudOffer', 'btnUseCloud', 'panelNotice', 'supportRow', 'shortcutValue', 'btnChangeShortcut', 'weekLine',
    'tabWrite', 'tabProgress', 'progressPanel', 'progEmpty', 'progEmptyTitle', 'progEmptyText', 'btnProgEmpty', 'btnProgMixups', 'progBody',
    'progHeadLead', 'progHeadText', 'progLine', 'progSpark', 'progStart', 'progStartFill', 'progStartText', 'progMasteredChip', 'progPracticeChip', 'btnPractice', 'progPracticeNote',
    'progHabitsCard', 'progHabitTitle', 'progHabitEg', 'progHabitAlso', 'progWordsCard', 'progTipsState', 'progTipsNote', 'progWords', 'btnAllWords', 'progMasteredLine',
    'btnTips', 'btnClearInsights', 'insightsToggle', 'coachToggle', 'soundToggle',
    'prChoose', 'prWhy', 'prBestLine', 'prTiles', 'prQuick', 'prKeep', 'prMix', 'prTally', 'prCheckpoint', 'prCheckText', 'btnPrMore', 'btnPrStop', 'prSheetLevel',
    'practicePanel', 'btnPracticeBack', 'prBar', 'prBarFill', 'prCombo', 'prStage', 'prAsk', 'prLeft', 'prSentence', 'prHint', 'prChoices', 'prType', 'prInput', 'prCheck',
    'prDone', 'prRing', 'prRingSvg', 'prScore', 'prDoneTitle', 'prDoneText', 'prWords', 'btnPracticeAgain', 'btnPracticeDone',
    'prSheet', 'prSheetIcon', 'prSheetTitle', 'prSheetText', 'prContinue',
    'keySection', 'cloudSection', 'advancedSection', 'providerNote', 'apiKeyLabel',
    'cloudServiceBtn', 'cloudServiceBtnLabel', 'cloudServiceMenu',
    'customBaseURLRow', 'customBaseURLInput', 'cloudModelInput',
    'btnBrowseModels', 'modelMenu', 'modelMenuList', 'modelHint',
    'apiKeyInput', 'btnToggleKeyEye', 'btnSaveKey', 'btnClearKey', 'keyHint',
    'thread', 'palette', 'paletteHintLeft', 'paletteList',
    'modeTag', 'modeTagLabel', 'ta', 'charCount', 'sendBtn',
  ].forEach((id) => { refs[id] = el(id); });

  if (typeof SR_LOGO_SVG !== 'undefined') refs.mark.innerHTML = SR_LOGO_SVG;

  const { lastTone, targetLang } = await Settings.get();
  currentMode = lastTone;
  currentTargetLang = targetLang;
  updateModeTag();

  await loadShortcut();
  const { hasKey } = await refreshProviderPill();
  // Cold start is the slowest part of an on-device rewrite; start it now,
  // while the user is still pasting. Never triggers a model download.
  if (typeof SR_warmDevice === 'function') SR_warmDevice().catch(() => {});
  if (hasKey) checkModelStillListed();

  turns = await TurnLog.getAll();
  renderThread();
  bindThreadDelegation();
  updateCharCount();

  // Header
  refs.btnSettings.addEventListener('click', () => toggleSettingsPanel());
  refs.btnSettingsBack.addEventListener('click', () => toggleSettingsPanel(false));
  // Clear at once and offer Undo for a few seconds, instead of an "Are you
  // sure?" dialog people learn to click through (SATISFACTION.md E2).
  let clearedTurns = null;
  let clearTimer = null;
  refs.btnClearHistory.addEventListener('click', async () => {
    if (turns.length === 0 || activeRun) return;
    clearedTurns = turns;
    turns = [];
    await TurnLog.clear();
    renderThread();
    refs.panelNotice.innerHTML = 'History cleared. <button type="button" class="notice-undo" id="btnUndoClear">Undo</button>';
    refs.panelNotice.classList.remove('hidden');
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => { clearedTurns = null; refs.panelNotice.classList.add('hidden'); }, 8000);
  });
  refs.panelNotice.addEventListener('click', async (e) => {
    if (!e.target.closest('#btnUndoClear') || !clearedTurns) return;
    turns = await TurnLog.save(clearedTurns.concat(turns));
    clearedTurns = null;
    clearTimeout(clearTimer);
    refs.panelNotice.classList.add('hidden');
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
  // Turning it on asks Chrome for access to page text first; that request has
  // to happen synchronously inside this click. background.js registers or
  // removes the page scripts when srHoverAssist changes.
  refs.hoverToggle.addEventListener('change', () => {
    if (refs.hoverToggle.checked) {
      chrome.permissions.request({ origins: ['<all_urls>'] }).then(async (granted) => {
        refs.hoverToggle.checked = granted;
        await Settings.set({ srHoverAssist: granted });
        refs.hoverHint.textContent = granted ? '' : 'Hover actions stay off: Chrome needs your permission to show the icon on pages.';
        if (granted) showSavedToast();
      }, () => { refs.hoverToggle.checked = false; });
    } else {
      Settings.set({ srHoverAssist: false }).then(async () => {
        await chrome.permissions.remove({ origins: ['<all_urls>'] }).catch(() => {});
        refs.hoverHint.textContent = '';
        // A provider outside the CORS-verified presets may have been relying on that broad access.
        const cfg = await CloudProvider.getConfig();
        if (needsHostAccess(cfg.id) && providerReady(cfg)) {
          let origin = null;
          try { origin = new URL(cfg.baseURL).origin + '/*'; } catch { /* invalid URL */ }
          if (origin && !(await chrome.permissions.contains({ origins: [origin] }))) {
            refs.hoverHint.textContent = `${cfg.displayName} needs access again: under AI provider, press ${cfg.keyless ? 'Connect' : 'Save'}.`;
          }
        }
        showSavedToast();
      });
    }
  });

  // On-device model download needs a click in a page, so it starts here.
  refs.btnDeviceSetup.addEventListener('click', setUpOnDevice);

  // Settings rows are divs; make them reachable and usable from the keyboard.
  refs.settingsPanel.querySelectorAll('.settings-row[data-action]').forEach((row) => {
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); }
    });
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
    const previous = await CloudProvider.getConfig();
    if (needsHostAccess(previous.id) && item.dataset.value !== previous.id) await releaseEndpointAccess(previous.baseURL);
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
  // Leaving the field saves only a real choice: an exact listed model, or any
  // name when the provider lists none. Text typed to filter the list is put
  // back; an unlisted name is saved deliberately with Enter.
  refs.cloudModelInput.addEventListener('change', async () => {
    const value = refs.cloudModelInput.value.trim();
    const list = modelLists[activeServiceId] || [];
    if (!value || (list.length && !list.includes(value))) {
      refs.cloudModelInput.value = refs.cloudModelInput.dataset.saved || '';
      return;
    }
    if (value !== refs.cloudModelInput.dataset.saved) await selectModel(value);
  });
  refs.customBaseURLInput.addEventListener('change', async () => {
    const previous = (await CloudProvider.getConfig('custom')).baseURL;
    if (previous && previous !== refs.customBaseURLInput.value.trim()) await releaseEndpointAccess(previous);
    await CloudProvider.setCustomBaseURL(refs.customBaseURLInput.value.trim());
    showSavedToast();
  });

  // Settings panel: model combobox over the provider's own list
  refs.cloudModelInput.addEventListener('focus', () => openModelMenu());
  refs.cloudModelInput.addEventListener('click', () => openModelMenu());
  refs.cloudModelInput.addEventListener('input', () => openModelMenu({ filter: true }));
  refs.cloudModelInput.addEventListener('keydown', (e) => {
    const open = !refs.modelMenu.classList.contains('hidden');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open) { openModelMenu(); return; }
      e.preventDefault();
      const max = modelFiltered.length - 1;
      modelActiveIndex = e.key === 'ArrowDown' ? Math.min(modelActiveIndex + 1, max) : Math.max(modelActiveIndex - 1, 0);
      refs.modelMenuList.querySelectorAll('.model-menu-item').forEach((n, i) => n.classList.toggle('active', i === modelActiveIndex));
      const active = refs.modelMenuList.querySelector('.model-menu-item.active');
      if (active) { active.scrollIntoView({ block: 'nearest' }); refs.cloudModelInput.setAttribute('aria-activedescendant', active.id); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = open && modelActiveIndex >= 0 ? modelFiltered[modelActiveIndex] : refs.cloudModelInput.value.trim();
      if (pick) selectModel(pick);
    } else if (e.key === 'Escape') {
      refs.cloudModelInput.value = refs.cloudModelInput.dataset.saved || '';
      closeModelMenu();
    }
  });
  refs.btnBrowseModels.addEventListener('click', (e) => {
    e.stopPropagation();
    if (refs.modelMenu.classList.contains('hidden')) { refs.cloudModelInput.focus(); openModelMenu(); } else closeModelMenu();
  });
  refs.modelMenuList.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the field
  refs.modelMenuList.addEventListener('click', (e) => {
    const item = e.target.closest('.model-menu-item');
    if (item) selectModel(item.dataset.model);
  });
  document.addEventListener('click', (e) => {
    if (!refs.modelMenu.contains(e.target) && e.target !== refs.cloudModelInput && !refs.btnBrowseModels.contains(e.target)) {
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
    if (!activeRun) refs.sendBtn.disabled = refs.ta.value.trim().length === 0;

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

  // Text sent from the page ("Open in Proofr panel"), and the note left when
  // the shortcut was pressed on a page Chrome blocks. Read once on load and
  // live while the panel stays open.
  await consumePanelHandoff();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.srPanelPrefill?.newValue || changes.srPanelNotice?.newValue)) consumePanelHandoff();
  });
  chrome.action.setBadgeText({ text: '' }).catch(() => {});

  if (SUPPORT_URL) {
    refs.supportRow.href = SUPPORT_URL;
    refs.supportRow.classList.remove('hidden');
  }

  refs.providerPill.addEventListener('click', (e) => {
    e.stopPropagation();
    refs.engineMenu.classList.contains('hidden') ? openEngineMenu() : closeEngineMenu();
  });
  refs.engineMenu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-choice]');
    if (item) chooseEngine(item.dataset.choice);
  });
  refs.engineMenu.addEventListener('keydown', (e) => {
    const items = [...refs.engineMenu.querySelectorAll('.engine-item')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[Math.min(i + 1, items.length - 1)].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[Math.max(i - 1, 0)].focus(); }
    if (e.key === 'Escape') { closeEngineMenu(); refs.providerPill.focus(); }
  });
  document.addEventListener('click', (e) => {
    if (!refs.engineMenu.contains(e.target) && !refs.providerPill.contains(e.target)) closeEngineMenu();
  });

  // Write | Progress
  refs.tabWrite.addEventListener('click', () => showTab('write'));
  refs.tabProgress.addEventListener('click', () => showTab('progress'));
  for (const tab of [refs.tabWrite, refs.tabProgress]) {
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const next = tab === refs.tabWrite ? refs.tabProgress : refs.tabWrite;
      showTab(next === refs.tabProgress ? 'progress' : 'write');
      next.focus();
    });
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.srInsights && !refs.progressPanel.classList.contains('hidden')) renderProgress();
  });
  refs.btnProgEmpty.addEventListener('click', () => toggleSettingsPanel(true));
  refs.btnTips.addEventListener('click', getTips);
  refs.progWords.addEventListener('click', (e) => {
    const b = e.target.closest('.prog-word-row');
    if (!b) return;
    const open = b.getAttribute('aria-expanded') !== 'true';
    b.setAttribute('aria-expanded', String(open));
    document.getElementById(b.getAttribute('aria-controls')).hidden = !open;
  });
  refs.btnAllWords.addEventListener('click', () => { progShowAll = !progShowAll; renderProgress(); });
  refs.btnClearInsights.addEventListener('click', async () => {
    await chrome.storage.local.remove(['srInsights', 'srTipsCache', 'srPracticeStats', 'srPracticePool', 'srPracticeSeen', 'srPracticeBest', 'srPracticeMode']);
    renderProgress();
  });
  refs.insightsToggle.addEventListener('change', async () => {
    await Settings.set({ srInsightsOn: refs.insightsToggle.checked });
    showSavedToast();
  });
  refs.coachToggle.addEventListener('change', async () => {
    await Settings.set({ srCoach: refs.coachToggle.checked });
    showSavedToast();
  });
  refs.soundToggle.addEventListener('change', async () => {
    await Settings.set({ srPracticeSound: refs.soundToggle.checked });
    showSavedToast();
  });
  refs.btnPractice.addEventListener('click', startPractice);
  refs.btnProgMixups.addEventListener('click', startPractice);
  refs.prTiles.addEventListener('click', (e) => { const b = e.target.closest('.pr-tile'); if (b && !b.disabled) beginPractice(b.dataset.mode); });
  // Arrow keys move between the tiles that can be played.
  refs.prTiles.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const tiles = [...refs.prTiles.querySelectorAll('.pr-tile:not(:disabled)')];
    tiles[(tiles.indexOf(document.activeElement) + step + tiles.length) % tiles.length]?.focus();
  });
  refs.btnPrMore.addEventListener('click', () => closeCheckpoint(true));
  refs.btnPrStop.addEventListener('click', () => closeCheckpoint(false));
  refs.prChoices.addEventListener('click', (e) => { const b = e.target.closest('.pr-choice'); if (b) onChoice(b.dataset.word); });
  refs.prSentence.addEventListener('click', (e) => { const b = e.target.closest('.pr-chip'); if (b) onChip(Number(b.dataset.j)); });
  refs.prType.addEventListener('submit', (e) => { e.preventDefault(); onTyped(); });
  refs.prContinue.addEventListener('click', onContinue);
  // Keyboard: 1-3 picks a choice, Enter continues, Escape closes.
  refs.practicePanel.addEventListener('pointerdown', () => { practiceByKey = false; });
  refs.practicePanel.addEventListener('keydown', (e) => {
    practiceByKey = true;
    // Checkpoint: Enter is "10 more" (unless "Done for now" has focus), Esc is done.
    if (!refs.prCheckpoint.hidden && (e.key === 'Escape' || (e.key === 'Enter' && e.target !== refs.btnPrStop))) { e.preventDefault(); closeCheckpoint(e.key === 'Enter'); return; }
    if (e.key === 'Escape') { e.preventDefault(); closePractice(); return; }
    if (practice.sheetOpen && e.key === 'Enter') { e.preventDefault(); onContinue(); return; }
    if (!refs.prChoices.hidden && /^[1-3]$/.test(e.key)) {
      const b = refs.prChoices.querySelectorAll('.pr-choice')[Number(e.key) - 1];
      if (b) { e.preventDefault(); onChoice(b.dataset.word); }
    }
  });
  // Start screen opened by mouse: focus stays on the page, so Enter is caught here.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target === document.body && !refs.practicePanel.classList.contains('hidden') && !refs.prChoose.hidden) {
      e.preventDefault();
      beginPractice(practice.pick);
    }
  });
  refs.btnPracticeBack.addEventListener('click', closePractice);
  refs.btnPracticeDone.addEventListener('click', closePractice);
  refs.btnPracticeAgain.addEventListener('click', startPractice);

  refs.btnChangeShortcut.addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
  // Back from rebinding: pick up the new key when the panel regains focus.
  window.addEventListener('focus', async () => {
    const before = shortcutText;
    await loadShortcut();
    if (before !== shortcutText && turns.length === 0) renderThread();
  });

  refs.btnUseCloud.addEventListener('click', () => {
    cloudChosen = true;
    refreshProviderPill();
  });

  if ((!deviceReady && !hasKey) || deviceNeedsSetup) {
    toggleSettingsPanel(true);
  } else {
    setTimeout(() => refs.ta.focus(), 100);
  }
});
