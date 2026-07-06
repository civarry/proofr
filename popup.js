// === API Key storage ===
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
    const apiKey = await this.getAPIKey();
    return !!(apiKey && apiKey.trim().length > 0);
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

// === Usage stats (kept small, shown only as a quiet footer line) ===
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

// === Settings (engine + translate target) ===
class Settings {
  static async get() {
    try {
      const r = await chrome.storage.sync.get(['srEngine', 'srTargetLang']);
      return { engine: r.srEngine || 'auto', targetLang: r.srTargetLang || 'en' };
    } catch {
      return { engine: 'auto', targetLang: 'en' };
    }
  }
  static async set(patch) {
    try { await chrome.storage.sync.set(patch); } catch { /* ignore */ }
  }
}

// === DOM refs ===
const el = (id) => document.getElementById(id);
const refs = {};

// === Provider state (on-device AI vs Groq) ===
let deviceReady = false;
let rewriting = false;
let keyFieldMode = 'save'; // 'save' = empty editable input; 'change' = masked, showing a saved key

// Show a masked "saved" state when a key exists, so the field never looks empty/lost.
async function renderKeyField(hasKey) {
  if (hasKey) {
    const key = await APIKeyManager.getAPIKey();
    const last4 = key ? key.slice(-4) : '';
    refs.apiKeyInput.type = 'text';
    refs.apiKeyInput.readOnly = true;
    refs.apiKeyInput.value = `gsk_••••••••••••${last4}`;
    refs.btnSaveKey.textContent = 'Change';
    keyFieldMode = 'change';
  } else {
    refs.apiKeyInput.type = 'password';
    refs.apiKeyInput.readOnly = false;
    refs.apiKeyInput.value = '';
    refs.apiKeyInput.placeholder = 'gsk_…';
    refs.btnSaveKey.textContent = 'Save';
    keyFieldMode = 'save';
  }
}

// "Change" turns the masked field back into an editable one; "Save" validates + stores.
function onSaveClick() {
  if (keyFieldMode === 'change') {
    refs.apiKeyInput.type = 'password';
    refs.apiKeyInput.readOnly = false;
    refs.apiKeyInput.value = '';
    refs.apiKeyInput.placeholder = 'Enter a new key (gsk_…)';
    refs.btnSaveKey.textContent = 'Save';
    keyFieldMode = 'save';
    refs.apiKeyInput.focus();
    return;
  }
  saveKey();
}

async function refreshProviderState() {
  const availability = await SR_deviceAvailability();
  deviceReady = availability === 'available' || availability === 'downloadable' || availability === 'downloading';
  const hasKey = await APIKeyManager.hasAPIKey();
  const { engine } = await Settings.get();

  // Reflect the chosen engine in the selector, disabling on-device when it isn't available.
  refs.engineSelect.value = engine;
  const deviceOpt = refs.engineSelect.querySelector('option[value="device"]');
  if (deviceOpt) {
    deviceOpt.disabled = !deviceReady;
    deviceOpt.textContent = deviceReady ? 'On-device only' : 'On-device only (unavailable)';
  }

  // Which engine will actually run, given the preference + what's available.
  let activeLabel, runnable;
  if (engine === 'groq') {
    activeLabel = hasKey ? 'Groq' : 'Add key';
    runnable = hasKey;
  } else if (engine === 'device') {
    activeLabel = deviceReady ? 'On-device' : 'Unavailable';
    runnable = deviceReady;
  } else { // auto
    activeLabel = deviceReady ? 'On-device' : (hasKey ? 'Groq' : 'Add key');
    runnable = deviceReady || hasKey;
  }

  const pill = refs.keyPill;
  pill.classList.remove('connected', 'missing');
  pill.classList.add(runnable ? 'connected' : 'missing');
  refs.keyPillText.textContent = activeLabel;

  refs.btnClearKey.classList.toggle('hidden', !hasKey);
  refs.btnRewrite.disabled = !runnable;
  // The Groq key only matters for engines that use it — hide it under "On-device only".
  refs.keySection.classList.toggle('hidden', engine === 'device');
  await renderKeyField(hasKey);

  refs.engineHint.textContent = deviceReady
    ? 'On-device runs locally in EN, ES, FR, DE, JA — no key. For other languages, use Groq (needs a key).'
    : 'On-device AI isn’t available in this browser — Groq needs a key.';

  refs.keyHint.innerHTML = hasKey
    ? `Groq key saved — stored only in your browser. Use "Change" to replace it.`
    : deviceReady
      ? `Chrome’s built-in AI is on — no key needed. Add a <a href="https://console.groq.com/keys" target="_blank" rel="noopener">Groq key</a> to use the Groq engine.`
      : `Get a key from <a href="https://console.groq.com/keys" target="_blank" rel="noopener">console.groq.com</a>. Stored only in your browser.`;

  return { deviceReady, hasKey, runnable };
}

function toggleKeyPanel(forceOpen) {
  const panel = refs.keyPanel;
  const open = forceOpen !== undefined ? forceOpen : panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !open);
  if (open) {
    // Reset to the true saved/empty state each time the panel opens.
    APIKeyManager.hasAPIKey().then((has) => {
      renderKeyField(has);
      if (!has) setTimeout(() => refs.apiKeyInput.focus(), 30);
    });
  }
}

async function saveKey() {
  const key = refs.apiKeyInput.value.trim();
  if (!key) { showNotice('Enter your Groq API key first.', 'error'); return; }
  if (!SR_isValidApiKey(key)) {
    showNotice('That key looks off — it should start with "gsk_" and be 40+ characters.', 'error');
    return;
  }

  refs.btnSaveKey.disabled = true;
  refs.btnSaveKey.textContent = 'Checking…';
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${key}` },
    });
    if (!res.ok) {
      showNotice('Groq rejected that key. Double-check and try again.', 'error');
      return;
    }
    await APIKeyManager.setAPIKey(key);
    refs.apiKeyInput.value = '';
    clearNotice();
    await refreshProviderState();
    toggleKeyPanel(false);
  } catch (error) {
    showNotice('Could not reach Groq to verify the key. Check your connection.', 'error');
  } finally {
    refs.btnSaveKey.disabled = false;
    // On success, renderKeyField already set the label to "Change"; only restore on failure.
    if (keyFieldMode !== 'change') refs.btnSaveKey.textContent = 'Save';
  }
}

async function clearKey() {
  await APIKeyManager.clearAPIKey();
  await refreshProviderState();
  clearResult();
  showNotice(deviceReady ? 'Groq key removed — still using on-device AI.' : 'API key removed.', 'info');
}

// === Tone selector ===
function populateTones() {
  refs.tone.innerHTML = SR_TONES
    .map(t => `<option value="${t.id}">${t.name}</option>`)
    .join('');
  onToneChange();
}

function populateLanguages() {
  refs.translateLang.innerHTML = SR_LANGUAGES
    .map(l => `<option value="${l.code}">${l.name}</option>`)
    .join('');
}

function onToneChange() {
  const tone = SR_getTone(refs.tone.value);
  refs.toneDesc.innerHTML = `<b>${tone.name}</b> — ${tone.desc}`;
  refs.langRow.classList.toggle('hidden', tone.id !== 'translate');
}

// === Notices ===
// action (optional): { label, onClick } renders a one-tap button inside the notice.
function showNotice(message, type, action) {
  refs.notice.className = `notice ${type}`;
  refs.notice.textContent = message;
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'notice-action';
    btn.textContent = action.label;
    btn.addEventListener('click', action.onClick);
    refs.notice.appendChild(btn);
  }
}
function clearNotice() {
  refs.notice.className = 'notice hidden';
  refs.notice.textContent = '';
}

// === Result ===
function clearResult() {
  refs.result.classList.add('hidden');
  refs.resultBox.textContent = '';
}

async function runRewrite() {
  if (rewriting) return;
  const text = refs.srcText.value.trim();
  if (!text) { showNotice('Type or paste some text to rewrite.', 'error'); refs.srcText.focus(); return; }

  const hasKey = await APIKeyManager.hasAPIKey();
  const { engine } = await Settings.get();
  const targetLang = refs.translateLang.value || 'en';
  const runnable = engine === 'groq' ? hasKey : engine === 'device' ? deviceReady : (deviceReady || hasKey);
  if (!runnable) {
    showNotice('Add a Groq key to start rewriting — or switch the engine to Auto/On-device.', 'error');
    toggleKeyPanel(true);
    return;
  }

  const tone = refs.tone.value;
  clearNotice();

  // Enter loading state
  rewriting = true;
  refs.btnRewrite.disabled = true;
  refs.btnRedo.disabled = true;
  refs.btnRewrite.textContent = tone === 'translate' ? 'Translating…' : 'Rewriting…';
  refs.result.classList.remove('hidden');
  refs.resultLabel.textContent = tone === 'translate'
    ? `Translate → ${SR_langName(targetLang)}`
    : `${SR_getToneName(tone)} rewrite`;
  refs.resultBox.textContent = '';
  refs.resultBox.classList.add('loading');
  refs.resultBox.textContent = tone === 'translate' ? 'Translating your text…' : 'Rewriting your text…';

  try {
    const apiKey = await APIKeyManager.getAPIKey();
    const onStatus = (msg) => { if (refs.resultBox.classList.contains('loading')) refs.resultBox.textContent = msg; };
    const { text: rewritten, provider } = await SR_rewriteAuto(text, tone, { apiKey, engine, targetLang, onStatus });
    refs.resultBox.classList.remove('loading');
    refs.resultBox.textContent = rewritten;
    const engineName = provider === 'device' ? 'on-device' : 'Groq';
    refs.resultLabel.textContent = tone === 'translate'
      ? `Translate → ${SR_langName(targetLang)} · ${engineName}`
      : `${SR_getToneName(tone)} · ${engineName}`;
    resetCopyButton();
    await StatsManager.updateStats(tone);
    updateStatLine();
  } catch (error) {
    refs.resultBox.classList.remove('loading');
    clearResult();
    // On-device was the only engine (no key) and it failed — most often an unsupported
    // language. Point the user at the one real fix: add a Groq key.
    if (!hasKey) {
      showNotice(
        'On-device AI couldn’t rewrite this — it only supports EN/ES/FR/DE/JA. Add a Groq key for other languages.',
        'error',
        { label: 'Add key', onClick: () => toggleKeyPanel(true) }
      );
    } else {
      showNotice(error.message || 'Something went wrong. Try again.', 'error');
    }
  } finally {
    rewriting = false;
    refs.btnRewrite.disabled = false;
    refs.btnRedo.disabled = false;
    refs.btnRewrite.textContent = 'Rewrite';
  }
}

function resetCopyButton() {
  refs.btnCopy.textContent = 'Copy';
  refs.btnCopy.classList.remove('done');
}

async function copyResult() {
  const text = refs.resultBox.textContent;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  refs.btnCopy.textContent = 'Copied';
  refs.btnCopy.classList.add('done');
  setTimeout(resetCopyButton, 1600);
}

// === Footer stat line ===
async function updateStatLine() {
  const stats = await StatsManager.getStats();
  refs.statLine.textContent = stats.totalRewrites > 0
    ? `${stats.totalRewrites} rewrite${stats.totalRewrites === 1 ? '' : 's'} so far`
    : 'Proofr v1.2';
}

// === Info overlays ===
function openOverlay(html) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="overlay-card">${html}
    <button class="btn-rewrite" data-close="1" type="button">Close</button></div>`;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.dataset.close) overlay.remove();
  });
  document.body.appendChild(overlay);
}

const InfoOverlays = {
  showPrivacyPolicy() {
    openOverlay(`
      <h3>Privacy</h3>
      <p>Your <strong>API key</strong> and <strong>usage counts</strong> live only in your browser storage — nothing is sent to us.</p>
      <p>With <strong>on-device AI</strong>, your text is rewritten locally and never leaves your computer.</p>
      <p>If Groq is used instead, the selected text goes directly to Groq over HTTPS, governed by their privacy policy. No copies of your text are kept by this extension either way.</p>
    `);
  },
  showSupport() {
    openOverlay(`
      <h3>Help</h3>
      <p><strong>How it rewrites:</strong> if your Chrome has built-in AI, everything runs on-device with no key. Otherwise it uses Groq with your API key. The pill up top shows which is active.</p>
      <p><strong>Not working?</strong></p>
      <ul>
        <li>Check the pill reads "On-device AI" or "Groq connected".</li>
        <li>No built-in AI? Add a Groq key, or update Chrome — built-in AI needs a recent Chrome on supported hardware.</li>
        <li>On a webpage, select text first, then right-click → Proofr.</li>
        <li>Some sites block extensions — try another page.</li>
      </ul>
      <p><strong>Shortcut:</strong> <strong>Ctrl+Shift+R</strong> rewrites the current selection in a Professional tone.</p>
      <p>Questions? <a href="mailto:cjcarito15@gmail.com">cjcarito15@gmail.com</a> · <a href="https://github.com/civarry" target="_blank" rel="noopener">github.com/civarry</a></p>
    `);
  },
};

// === Wire up ===
document.addEventListener('DOMContentLoaded', async () => {
  ['logo','keyPill','keyPillText','keyPanel','engineSelect','engineHint','keySection','apiKeyInput','btnSaveKey','btnClearKey','keyHint',
   'srcText','tone','toneDesc','langRow','translateLang','btnRewrite','notice','result','resultLabel',
   'resultBox','btnCopy','btnRedo','statLine'].forEach(id => refs[id] = el(id));

  if (typeof SR_LOGO_SVG !== 'undefined') refs.logo.innerHTML = SR_LOGO_SVG;

  populateTones();
  populateLanguages();
  const { engine, targetLang } = await Settings.get();
  refs.translateLang.value = targetLang;
  const { deviceReady: hasDevice, hasKey } = await refreshProviderState();
  await updateStatLine();

  refs.keyPill.addEventListener('click', () => toggleKeyPanel());
  refs.btnSaveKey.addEventListener('click', onSaveClick);
  refs.btnClearKey.addEventListener('click', clearKey);
  refs.apiKeyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') onSaveClick(); });
  refs.apiKeyInput.addEventListener('input', clearNotice);

  refs.engineSelect.addEventListener('change', async () => {
    await Settings.set({ srEngine: refs.engineSelect.value });
    await refreshProviderState();
  });
  refs.translateLang.addEventListener('change', () => Settings.set({ srTargetLang: refs.translateLang.value }));

  refs.tone.addEventListener('change', onToneChange);
  refs.btnRewrite.addEventListener('click', runRewrite);
  refs.btnRedo.addEventListener('click', runRewrite);
  refs.btnCopy.addEventListener('click', copyResult);

  // Cmd/Ctrl+Enter from the textarea triggers a rewrite
  refs.srcText.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runRewrite(); }
  });

  document.querySelectorAll('[data-action]').forEach(node => {
    node.addEventListener('click', (e) => {
      e.preventDefault();
      const fn = InfoOverlays[node.dataset.action];
      if (fn) fn();
    });
  });

  // No provider at all? Open the key panel so the first thing a user sees is how to start.
  // If on-device AI is ready, there's nothing to set up — go straight to the textarea.
  if (!hasDevice && !hasKey) {
    toggleKeyPanel(true);
  } else {
    setTimeout(() => refs.srcText.focus(), 100);
  }
});
