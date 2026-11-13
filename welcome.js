// welcome.js — the tab opened on first install (background.js onInstalled).
// Built around one real first proofread, plus the two things that decide
// whether Proofr gets used again: a pinned toolbar icon and, optionally, an AI.
// Proofread works on every computer with Proofr's own rules; an AI adds
// sentence-level fixes.

const $ = (id) => document.getElementById(id);
let windowId = null; // cached so sidePanel.open can run synchronously inside a click
let aiReady = false; // an AI can answer the "Try it here" proofread

function escapeHtml(s) {
  // Quotes too: values go inside attributes (model ids from a provider's list).
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s ?? '').replace(/[&<>"']/g, (c) => map[c]);
}

// A step finished while you watch gets a short pop on its number; steps
// already done when the page opens just show green.
let pageReady = false;
function markDone(stepId, done) {
  const step = $(stepId);
  const was = step.classList.contains('done');
  step.classList.toggle('done', !!done);
  if (done && !was && pageReady) { step.classList.remove('just'); void step.offsetWidth; step.classList.add('just'); }
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
    $('aiText').innerHTML = 'Proofread already works on this computer with Proofr\'s own rules, which fix common mistakes like <i>its</i> and <i>it\'s</i>. For rewriting styles and fixes that need the whole sentence, you can connect an AI provider: <b>Groq</b> has a free tier and takes about a minute, and <b>Ollama</b> or <b>LM Studio</b> run on your own computer with no key.';
    button('Connect a provider (optional)', false, openPanel);
    markDone('stepAI', false);
  }
  aiReady = availability === 'available' || ready;
  $('btnTry').disabled = false;
  $('tryStatus').textContent = '';
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
  const ops = typeof SR_wordDiffForDisplay === 'function' ? SR_wordDiffForDisplay(before, after, 'grammar') : null;
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
  // Rules first, then the AI when one is set up, then the rules again (the
  // same order as a Proofread anywhere else).
  let failed = null;
  const askAI = async (t) => {
    const r = await sendMessage({ action: 'hoverRewrite', text: t, tone: 'grammar', targetLang: 'en' });
    if (!r || r.error) { failed = (r && r.message) || 'Something went wrong. Try again.'; throw new Error(failed); }
    return r;
  };
  let response;
  try {
    response = await SR_proofreadHybrid(text, { runAI: aiReady ? askAI : null });
  } catch (_) {
    $('btnTry').disabled = false;
    $('tryStatus').textContent = failed || 'Something went wrong. Try again.';
    return;
  }
  $('btnTry').disabled = false;
  const fixes = (typeof SR_wordDiffForDisplay === 'function' && typeof SR_diffCount === 'function')
    ? SR_diffCount(SR_wordDiffForDisplay(text, response.text, 'grammar') || []) : null;
  // The same short count as the note on a page; rules alone count their fixes.
  const n = !response.ai && response.ruleCount ? response.ruleCount : fixes;
  $('tryStatus').textContent = fixes == null ? 'Done.'
    : fixes === 0 ? (response.text === text ? 'No mistakes found' : 'Spacing fixed')
    : `${n} fix${n === 1 ? '' : 'es'}${response.ai ? '' : ' · on this computer, no AI needed'}`;
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

// === Step 5: Check as I type, with Chrome's permission asked from this click ===
async function refreshLive() {
  const on = (await chrome.storage.sync.get(['srLiveCheck'])).srLiveCheck === true;
  $('btnLive').textContent = on ? 'Turn off Check as I type' : 'Turn on Check as I type';
  $('btnLive').setAttribute('aria-pressed', String(on));
  $('liveStatus').textContent = on ? 'On. Try it in any text box.' : '';
  $('liveStatus').className = on ? 'status ok' : 'status';
  markDone('stepLive', on);
}
async function toggleLive() {
  const on = (await chrome.storage.sync.get(['srLiveCheck'])).srLiveCheck === true;
  if (on) {
    await chrome.storage.sync.set({ srLiveCheck: false });
    if (!(await chrome.storage.sync.get(['srHoverAssist'])).srHoverAssist) await chrome.permissions.remove({ origins: ['<all_urls>'] }).catch(() => {});
  } else {
    const granted = await chrome.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
    if (granted) await chrome.storage.sync.set({ srLiveCheck: true });
    else { $('liveStatus').textContent = 'Stays off: Chrome needs your permission to read text boxes on pages.'; $('liveStatus').className = 'status bad'; return; }
  }
  await refreshLive();
}

// === Step 6: School in one click, instead of finding it in Settings ===
async function refreshSchool() {
  const on = (await chrome.storage.sync.get(['srSchool'])).srSchool === true;
  $('btnSchool').textContent = on ? 'Turn off School' : 'Turn on School';
  $('btnSchool').setAttribute('aria-pressed', String(on));
  $('schoolStatus').textContent = on ? 'School is on. Change it any time in Settings, under Proofread.' : '';
  $('schoolStatus').className = on ? 'status ok' : 'status';
  markDone('stepSchool', on);
}
async function toggleSchool() {
  const on = (await chrome.storage.sync.get(['srSchool'])).srSchool === true;
  await chrome.storage.sync.set(on ? { srSchool: false } : { srSchool: true, srCoach: false });
  await refreshSchool();
}

document.addEventListener('DOMContentLoaded', async () => {
  if (typeof SR_LOGO_SVG !== 'undefined') $('mark').innerHTML = SR_LOGO_SVG;
  $('undoKey').textContent = /Mac/i.test(navigator.platform) ? '⌘Z' : 'Ctrl+Z';
  chrome.windows.getCurrent().then((w) => { windowId = w.id; }).catch(() => {});

  $('btnTry').addEventListener('click', tryProofread);
  $('btnPanel').addEventListener('click', openPanel);
  $('btnSchool').addEventListener('click', toggleSchool);
  $('btnLive').addEventListener('click', toggleLive);

  await Promise.all([refreshPin(), refreshAI(), refreshShortcut(), refreshSchool(), refreshLive()]);
  pageReady = true;

  // Pinning happens in Chrome's own UI; tick the step off as soon as it does.
  if (chrome.action.onUserSettingsChanged) chrome.action.onUserSettingsChanged.addListener(refreshPin);
  // A provider connected from the panel unlocks step 3 here. Only settings
  // changes count: a finished proofread also writes (usage stats) and must
  // not reset the result shown in step 3.
  chrome.storage.onChanged.addListener((changes) => {
    if (Object.keys(changes).some((k) => /^(srCloud|srEngine|groqAPIKey)/.test(k))) refreshAI();
  });
});
