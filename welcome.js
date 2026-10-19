// welcome.js — the tab opened on first install (background.js onInstalled).
// Built around one real first proofread, plus the two things that decide
// whether Proofr gets used again: a pinned toolbar icon and a working AI.

const $ = (id) => document.getElementById(id);
let windowId = null; // cached so sidePanel.open can run synchronously inside a click

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

function markDone(stepId, done) {
  $(stepId).classList.toggle('done', !!done);
}

function openPanel() {
  if (windowId == null) return;
  chrome.sidePanel.open({ windowId }).catch(() => {});
}

// === Step 1: pinned? ===
async function refreshPin(settings) {
  const s = settings || await chrome.action.getUserSettings().catch(() => null);
  if (!s) { $('pinStatus').textContent = ''; return; }
  $('pinStatus').textContent = s.isOnToolbar ? '✓ Pinned. You can always find Proofr in the toolbar.' : 'Not pinned yet.';
  $('pinStatus').className = `status ${s.isOnToolbar ? 'ok' : ''}`;
  markDone('stepPin', s.isOnToolbar);
}

// === Step 2: which AI can run ===
function sendMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => resolve(chrome.runtime.lastError ? null : response));
    } catch { resolve(null); }
  });
}

async function refreshAI() {
  const [availability, ready] = await Promise.all([
    SR_deviceAvailability(),
    sendMessage({ action: 'hasCloudKey' }).then((r) => !!(r && r.hasKey)),
  ]);
  const actions = $('aiActions');
  actions.innerHTML = '';
  const button = (label, solid, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ${solid ? 'btn-solid' : 'btn-outline'}`;
    b.textContent = label;
    b.addEventListener('click', onClick);
    actions.appendChild(b);
    return b;
  };

  if (availability === 'available') {
    $('aiText').textContent = 'On-device AI is ready. Proofr runs on this computer, so your text stays here, with no account or key.';
    markDone('stepAI', true);
  } else if (ready) {
    $('aiText').textContent = 'Connected to your AI provider. You can change it any time in the Proofr panel.';
    markDone('stepAI', true);
  } else if (availability === 'downloadable' || availability === 'downloading') {
    $('aiText').textContent = 'Your Chrome can run Proofr privately on this computer. It needs a one-time download of Chrome\'s AI model, which is large.';
    button('Set up on-device AI', true, setUpOnDevice);
    button('Use a cloud provider instead', false, openPanel);
    markDone('stepAI', false);
  } else {
    $('aiText').innerHTML = 'This Chrome can\'t run on-device AI. Connect an AI provider instead: <b>Groq</b> has a free tier and takes about a minute, and <b>Ollama</b> or <b>LM Studio</b> run on your own computer with no key.';
    button('Connect a provider', true, openPanel);
    markDone('stepAI', false);
  }
  $('btnTry').disabled = !(availability === 'available' || ready);
  $('tryStatus').textContent = $('btnTry').disabled ? 'Finish step 2 first.' : '';
}

// The model download needs a click on a page; this is that click.
async function setUpOnDevice(e) {
  const LM = SR_deviceModel();
  if (!LM) return;
  e.currentTarget.disabled = true;
  $('aiStatus').className = 'status';
  $('aiStatus').textContent = 'Starting download…';
  try {
    const session = await LM.create({
      monitor(m) {
        m.addEventListener('downloadprogress', (ev) => {
          $('aiStatus').textContent = `Downloading Chrome's AI model… ${Math.round((ev.loaded || 0) * 100)}%`;
        });
      },
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
    });
    try { session.destroy && session.destroy(); } catch { /* ignore */ }
    $('aiStatus').textContent = '';
  } catch (error) {
    $('aiStatus').className = 'status bad';
    $('aiStatus').textContent = `Couldn't set up on-device AI: ${error.message || error}. Connect a provider instead.`;
  }
  await refreshAI();
}

// === Step 3: a real first proofread, with the changes marked ===
function renderDiff(before, after) {
  const ops = typeof SR_wordDiff === 'function' ? SR_wordDiff(before, after) : null;
  if (!ops) return escapeHtml(after);
  return ops.map((op) => {
    if (op.type === 'ins') return `<ins class="diff-ins">${escapeHtml(op.text)}</ins>`;
    if (op.type === 'del') return `<del class="diff-del">${escapeHtml(op.text)}</del>`;
    return escapeHtml(op.text);
  }).join('');
}

async function tryProofread() {
  const text = $('tryText').value.trim();
  if (!text) return;
  $('btnTry').disabled = true;
  $('tryStatus').textContent = 'Proofreading…';
  const response = await sendMessage({ action: 'hoverRewrite', text, tone: 'grammar', targetLang: 'en' });
  $('btnTry').disabled = false;
  if (!response || response.error) {
    $('tryStatus').textContent = (response && response.message) || 'Something went wrong. Try again.';
    return;
  }
  const fixes = (typeof SR_wordDiff === 'function' && typeof SR_diffCount === 'function')
    ? SR_diffCount(SR_wordDiff(text, response.text) || []) : null;
  $('tryStatus').textContent = fixes == null ? 'Done.' : fixes === 0 ? 'No changes needed.' : `Fixed ${fixes} thing${fixes === 1 ? '' : 's'}.`;
  $('tryResult').innerHTML = renderDiff(text, response.text);
  $('tryResult').classList.remove('hidden');
  markDone('stepTry', true);
}

// === Step 4: the real shortcut, or how to set one ===
async function refreshShortcut() {
  const commands = await chrome.commands.getAll().catch(() => []);
  const cmd = commands.find((c) => c.name === 'proofread-selection');
  const openShortcuts = (e) => { e.preventDefault(); chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); };
  if (cmd && cmd.shortcut) {
    // Chrome reports it in the platform's notation (⌥⇧P on a Mac).
    document.querySelectorAll('.sc').forEach((k) => { k.textContent = cmd.shortcut; });
    $('changeShortcut').addEventListener('click', openShortcuts);
  } else {
    // Chrome skips a suggested key that another extension already uses.
    $('shortcutLine').innerHTML = 'Chrome didn\'t assign Proofr\'s keyboard shortcut on this computer. <a href="#" id="setShortcut">Set one</a> to proofread a selection from the keyboard.';
    $('setShortcut').addEventListener('click', openShortcuts);
    document.querySelectorAll('.lede .sc').forEach((k) => { k.textContent = 'your shortcut'; });
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  if (typeof SR_LOGO_SVG !== 'undefined') $('mark').innerHTML = SR_LOGO_SVG;
  $('undoKey').textContent = /Mac/i.test(navigator.platform) ? '⌘Z' : 'Ctrl+Z';
  chrome.windows.getCurrent().then((w) => { windowId = w.id; }).catch(() => {});

  $('btnTry').addEventListener('click', tryProofread);
  $('btnPanel').addEventListener('click', openPanel);

  await Promise.all([refreshPin(), refreshAI(), refreshShortcut()]);

  // Pinning happens in Chrome's own UI; tick the step off as soon as it does.
  if (chrome.action.onUserSettingsChanged) chrome.action.onUserSettingsChanged.addListener(refreshPin);
  // A provider connected from the panel unlocks step 3 here. Only settings
  // changes count: a finished proofread also writes (usage stats) and must
  // not reset the result shown in step 3.
  chrome.storage.onChanged.addListener((changes) => {
    if (Object.keys(changes).some((k) => /^(srCloud|srEngine|groqAPIKey)/.test(k))) refreshAI();
  });
});
