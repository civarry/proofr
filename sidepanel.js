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
  const { srInsightsOn, srCoach } = await chrome.storage.sync.get(['srInsightsOn', 'srCoach']);
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
    const { text: rewritten, provider: providerId } = await SR_rewriteAuto(turn.inputText, turn.mode, {
      provider,
      engine,
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
    turn.where = providerId === 'device' ? 'On this computer'
      : (typeof SR_isLocalURL === 'function' && SR_isLocalURL(provider.baseURL)) ? 'On your computer or network'
      : `Sent to ${SR_providerDisplayLabel(providerId)}`;
    turn.latencyMs = Math.round(performance.now() - start);
    turn.status = 'done';
    delete turn.errorMessage;
    delete turn.statusText;
    await StatsManager.updateStats(turn.mode);
    if (turn.mode === 'grammar') recordInsights(turn.inputText, rewritten);
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
  const ops = (turn.mode === 'grammar' && typeof SR_wordDiff === 'function') ? SR_wordDiff(turn.inputText, turn.outputText) : null;
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
// Tips send the word list, and nothing else, to whichever AI is set up, and
// only when asked.
const FOCUS_COPY = {
  apostrophe: 'Apostrophes in contractions',
  spelling: 'Words you often misspell',
  grammar: 'Word choice and agreement',
  capitalization: 'Capital letters',
  punctuation: 'Punctuation',
  other: 'Your most common fixes',
};
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
  closeEngineMenu();
  if (progress) renderProgress();
}

const fmt = (n) => Number(n || 0).toLocaleString();

// Line through the weeks that have a rate; weeks with no words are gaps in x.
function sparkSvg(weeks) {
  const pts = weeks.map((w, i) => (w.per100 == null ? null : { i, v: w.per100 })).filter(Boolean);
  if (pts.length < 2) return '';
  const max = Math.max(...pts.map((p) => p.v), 1);
  const x = (i) => 8 + (i * 304) / (weeks.length - 1);
  const y = (v) => 56 - (v / max) * 48;
  const line = pts.map((p) => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return `<line class="axis" x1="0" y1="63" x2="320" y2="63"/><polyline class="line" points="${line}"/><circle class="dot" cx="${x(last.i).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="4"/>`;
}

function pairHtml(p) {
  return `<span class="from">${escapeHtml(p.from)}</span> <span aria-hidden="true">→</span><span class="visually-hidden"> to </span> <span class="to">${escapeHtml(p.to)}</span>`;
}

// Practice needs pairs it can build sentences from; returns the kind to focus
// on and whether a round can be built for it.
function pickFocus(view) {
  const counts = {};
  for (const p of view.working) counts[p.kind] = (counts[p.kind] || 0) + p.n;
  const kind = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  if (!kind) return null;
  const words = view.working.filter((p) => p.kind === kind).slice(0, 3).map((p) => p.to);
  const canPractice = typeof SR_buildPractice === 'function' && SR_buildPractice(view, 3, 0).length > 0;
  return { kind, words, canPractice };
}

async function renderProgress() {
  if (typeof SR_insightsView !== 'function') return null;
  const { srInsights } = await chrome.storage.local.get(['srInsights']);
  const { srInsightsOn } = await chrome.storage.sync.get(['srInsightsOn']);
  const view = SR_insightsView(srInsights, Date.now());
  progressView = view;
  const empty = !view.total.proofreads;
  refs.progEmpty.hidden = !empty;
  refs.progBody.hidden = empty;
  refs.btnProgEmpty.hidden = srInsightsOn !== false;
  if (empty) {
    refs.progEmptyTitle.textContent = srInsightsOn === false ? 'Progress is turned off' : 'Nothing here yet';
    refs.progEmptyText.textContent = srInsightsOn === false
      ? 'Turn on "Learn from my proofreads" and Proofr will keep the words it fixes for you, on this computer.'
      : 'Proofread something you wrote. The words Proofr fixes for you show up here, and so does how your mistake rate changes week to week.';
    return view;
  }

  // Rate, trend, chart
  const rate = view.week.per100;
  refs.progRate.textContent = rate == null ? '-' : rate.toFixed(1);
  const t = view.trend;
  refs.progTrend.className = `prog-trend${t != null && t < 0 ? ' down' : ''}`;
  refs.progTrend.textContent = rate == null ? 'Proofread something this week to see your rate.'
    : t == null ? 'A trend shows once you have proofread 200 words in each of two weeks.'
      : t < 0 ? `↓ ${Math.abs(t).toFixed(1)} fewer than last week`
        : t > 0 ? `↑ ${t.toFixed(1)} more than last week` : 'Same as last week';
  const spark = sparkSvg(view.weeks);
  refs.progSpark.innerHTML = spark;
  refs.progSpark.hidden = !spark;
  refs.progAxis.hidden = !spark;
  const rated = view.weeks.filter((w) => w.per100 != null);
  refs.progSpark.setAttribute('aria-label', rated.length ? `Mistakes per 100 words by week: ${rated.map((w) => w.per100).join(', ')}` : '');
  refs.progBasis.textContent = `Based on ${fmt(view.total.proofreads)} proofread${view.total.proofreads === 1 ? '' : 's'}, ${fmt(view.total.words)} words. The rate also moves when you switch AI, since each one catches different things.`;

  // Focus
  const focus = pickFocus(view);
  refs.progFocus.hidden = !focus;
  if (focus) {
    refs.progFocusTitle.textContent = FOCUS_COPY[focus.kind] || FOCUS_COPY.other;
    const list = focus.words.map((w) => `<b>${escapeHtml(w)}</b>`).join(', ');
    refs.progFocusText.innerHTML = focus.canPractice
      ? `Most of your recent fixes are words like ${list}. Two minutes of practice, using your own mistakes.`
      : `Most of your recent fixes are like ${list}. Watch for these the next time you write.`;
    refs.btnPractice.hidden = !focus.canPractice;
  }

  // Mastered / Still working on
  refs.progMasteredCard.hidden = !view.mastered.length;
  refs.progMastered.innerHTML = view.mastered.slice(0, 5).map((p) =>
    `<div class="prog-row"><span class="prog-icon ok" aria-hidden="true">${ICON_CHECK}</span><span class="word">${escapeHtml(p.to)}</span><span class="meta">clean for ${p.daysClean} days</span></div>`).join('');
  refs.progWorkingCard.hidden = !view.working.length;
  refs.progWorking.innerHTML = view.working.slice(0, 5).map((p) => {
    const rule = typeof SR_ruleFor === 'function' ? SR_ruleFor(p) : null;
    return `<div class="prog-row"><div>${pairHtml(p)}${rule ? `<div class="rule">${escapeHtml(rule)}</div>` : ''}</div><span class="meta">${p.n}×</span></div>`;
  }).join('');
  return view;
}

// Tips: the connected provider, else Chrome's on-device model (from this
// click, so a first-time download is allowed). The list is fenced as data
// and the reply checked like any other (SR_cleanOutput).
async function getTips() {
  const view = await renderProgress();
  if (!view || !view.working.length && !view.mastered.length) return;
  const pairs = [...view.working, ...view.mastered].slice(0, 15);
  const kinds = view.kinds;
  const prompt = SR_buildTipsPrompt(pairs, kinds);
  refs.btnTips.disabled = true;
  refs.insTipsStatus.textContent = 'Looking at your list…';
  refs.insTips.hidden = true;
  try {
    const provider = await CloudProvider.getConfig();
    const { engine } = await Settings.get();
    const deviceNow = (await SR_deviceAvailability()) === 'available';
    let text;
    if (providerReady(provider) && (engine === 'cloud' || !deviceNow)) {
      text = await SR_callCloud(provider, prompt, 0.4, 600);
    } else {
      const LM = SR_deviceModel();
      if (!LM) throw new Error('Connect an AI provider in Settings to get tips.');
      const session = await LM.create({ expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] });
      try { text = await session.prompt(SR_joinPrompt(prompt)); } finally { try { session.destroy(); } catch { /* ignore */ } }
    }
    refs.insTips.textContent = SR_cleanOutput(text, { fence: prompt.fence });
    refs.insTips.hidden = false;
    refs.insTipsStatus.textContent = '';
  } catch (error) {
    refs.insTipsStatus.textContent = error.message || 'Couldn\'t get tips right now. Try again.';
  } finally {
    refs.btnTips.disabled = false;
  }
}

// === Practice ===
// A round of 3 sentences from SR_buildPractice, checked on this computer.
const practice = { items: [], i: 0, right: 0, total: 0, checked: false };

function startPractice() {
  const view = progressView;
  if (!view || typeof SR_buildPractice !== 'function') return;
  const items = SR_buildPractice(view, 3, Math.floor(Math.random() * 1e6));
  if (!items.length) return;
  Object.assign(practice, { items, i: 0, right: 0, total: 0, checked: false });
  refs.progressPanel.classList.add('hidden');
  refs.practicePanel.classList.remove('hidden');
  showPracticeItem();
}

function showPracticeItem() {
  const item = practice.items[practice.i];
  refs.practiceTitle.textContent = `Practice · ${practice.i + 1} of ${practice.items.length}`;
  refs.practiceCard.hidden = false;
  refs.practiceDone.hidden = true;
  refs.practiceResult.hidden = true;
  refs.practicePrompt.textContent = item.prompt;
  refs.practiceInput.value = item.prompt;
  refs.practiceInput.readOnly = false;
  refs.btnPracticeCheck.textContent = 'Check';
  refs.btnPracticeSkip.hidden = false;
  practice.checked = false;
  refs.practiceInput.focus();
  refs.practiceInput.setSelectionRange(item.prompt.length, item.prompt.length);
}

function checkPractice() {
  if (practice.checked) { nextPractice(); return; }
  const item = practice.items[practice.i];
  const res = SR_checkPractice(item, refs.practiceInput.value);
  practice.checked = true;
  practice.right += res.right.length;
  practice.total += res.right.length + res.missed.length;
  const n = res.right.length + res.missed.length;
  refs.practiceScore.textContent = `${res.right.length} of ${n} right`;
  refs.practiceList.innerHTML = [
    ...res.right.map((to) => `<div class="prog-row"><span class="prog-icon ok" aria-hidden="true">${ICON_CHECK}</span><span class="word">${escapeHtml(to)}</span></div>`),
    ...res.missed.map((m) => `<div class="prog-row"><span class="prog-icon miss" aria-hidden="true">!</span><div>${pairHtml(m)}${m.rule ? `<div class="rule">${escapeHtml(m.rule)}</div>` : ''}</div></div>`),
  ].join('');
  refs.practiceResult.hidden = false;
  refs.practiceInput.readOnly = true;
  refs.btnPracticeSkip.hidden = true;
  refs.btnPracticeCheck.textContent = practice.i + 1 < practice.items.length ? 'Next sentence' : 'Finish';
  refs.btnPracticeCheck.focus();
}

function nextPractice() {
  if (practice.i + 1 < practice.items.length) { practice.i++; showPracticeItem(); return; }
  refs.practiceTitle.textContent = 'Practice';
  refs.practiceCard.hidden = true;
  refs.practiceResult.hidden = true;
  refs.practiceDone.hidden = false;
  refs.practiceDoneTitle.textContent = practice.total ? `${practice.right} of ${practice.total} fixed` : 'Round done';
  refs.practiceDoneText.textContent = practice.total && practice.right === practice.total
    ? 'All of them. Your progress shows in your real writing: the rate on the Progress tab.'
    : 'The ones you missed come back in your next round. Your progress shows in your real writing: the rate on the Progress tab.';
  refs.btnPracticeAgain.focus();
}

function closePractice() {
  refs.practicePanel.classList.add('hidden');
  showTab('progress');
}

// === One-time rating ask ===
// Shown once, under a successful result, after 5 successful rewrites (the
// same rewriteStats counter every surface increments). Same ask for everyone,
// no reward, never blocks anything; either choice retires it for good.
const RATE_AFTER = 10; // after real use, not after a first try

async function maybeShowRatePrompt() {
  const last = turns[turns.length - 1];
  if (!last || last.status !== 'done') return;
  const { rewriteStats, srRateAsked } = await chrome.storage.local.get(['rewriteStats', 'srRateAsked']);
  if (srRateAsked || !rewriteStats || rewriteStats.totalRewrites < RATE_AFTER) return;
  if (refs.thread.querySelector('.rate-line')) return;
  const line = document.createElement('div');
  line.className = 'rate-line';
  line.innerHTML = `<span>Finding Proofr useful? A rating helps other people find it.</span>
    <a href="${SR_REVIEWS_URL}" target="_blank" rel="noopener" data-rate="go">Rate it</a>
    <button type="button" data-rate="later">Not now</button>`;
  line.addEventListener('click', async (e) => {
    const choice = e.target.closest('[data-rate]');
    if (!choice) return;
    await chrome.storage.local.set({ srRateAsked: true });
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
    'mark', 'providerPill', 'providerPillText', 'engineMenu', 'btnClearHistory', 'btnSettings', 'btnSettingsBack',
    'settingsPanel', 'savedToast', 'setupCard', 'deviceSetupCard', 'btnDeviceSetup', 'deviceSetupStatus',
    'hoverToggle', 'hoverHint', 'engineSeg', 'engineHint',
    'cloudOffer', 'btnUseCloud', 'panelNotice', 'supportRow', 'shortcutValue', 'btnChangeShortcut', 'weekLine',
    'tabWrite', 'tabProgress', 'progressPanel', 'progEmpty', 'progEmptyTitle', 'progEmptyText', 'btnProgEmpty', 'progBody',
    'progRate', 'progTrend', 'progSpark', 'progAxis', 'progBasis', 'progFocus', 'progFocusTitle', 'progFocusText', 'btnPractice',
    'progMasteredCard', 'progMastered', 'progWorkingCard', 'progWorking',
    'btnTips', 'insTipsStatus', 'insTips', 'btnClearInsights', 'insightsToggle', 'coachToggle',
    'practicePanel', 'btnPracticeBack', 'practiceTitle', 'practiceCard', 'practicePrompt', 'practiceInput',
    'btnPracticeCheck', 'btnPracticeSkip', 'practiceResult', 'practiceScore', 'practiceList',
    'practiceDone', 'practiceDoneTitle', 'practiceDoneText', 'btnPracticeAgain', 'btnPracticeDone',
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
  refs.btnClearInsights.addEventListener('click', async () => {
    await chrome.storage.local.remove(['srInsights']);
    refs.insTips.hidden = true;
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
  refs.btnPractice.addEventListener('click', startPractice);
  refs.btnPracticeCheck.addEventListener('click', checkPractice);
  refs.btnPracticeSkip.addEventListener('click', nextPractice);
  refs.practiceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); checkPractice(); }
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
