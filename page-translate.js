// page-translate.js — full-page bilingual translation. NOT part of the
// always-on content scripts; injected on demand only when the user triggers
// "Translate this page" from the context menu (see ensurePageTranslateAssets
// in background.js). Inserts each translation as a sibling block right below
// the original (safer than true side-by-side columns or in-place replace —
// doesn't mutate the page's own DOM/listeners, survives arbitrary layouts).
(function () {
  if (window.__srPageTranslateLoaded) return;
  window.__srPageTranslateLoaded = true;

  const GROQ_BATCH_CHAR_LIMIT = 4000;
  const DEVICE_BATCH_CHAR_LIMIT = 1500; // several short on-device calls beat one huge one

  let injectedNodes = [];
  let running = false;
  let currentLang = null;
  let pill = null;

  function chunkBlocks(blocks, limit) {
    const chunks = [];
    let current = [];
    let size = 0;
    blocks.forEach((b, i) => {
      const item = { id: `b${i}`, text: b.text };
      if (size + item.text.length > limit && current.length) {
        chunks.push(current);
        current = [];
        size = 0;
      }
      current.push(item);
      size += item.text.length;
    });
    if (current.length) chunks.push(current);
    return chunks;
  }

  function insertTranslation(block, text) {
    const wrap = document.createElement('div');
    wrap.className = 'sr-page-translate-block';
    // block.text may contain "\n" from <br>-based paragraph spacing (see
    // dom-scan.js's directText) — textContent alone would collapse those
    // back to a single line, so build real <br> elements instead.
    if (typeof SR_DOM !== 'undefined' && SR_DOM.textToFragment) {
      wrap.appendChild(SR_DOM.textToFragment(text));
    } else {
      wrap.textContent = text;
    }
    block.el.insertAdjacentElement('afterend', wrap);
    injectedNodes.push(wrap);
  }

  function clearInjected() {
    injectedNodes.forEach((node) => node.remove());
    injectedNodes = [];
  }

  function sendBatch(items, targetLang) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'translatePageBatch', items, targetLang }, (response) => {
        if (chrome.runtime.lastError) resolve({ error: 'runtime', message: chrome.runtime.lastError.message });
        else resolve(response);
      });
    });
  }

  async function run(targetLang) {
    if (running) return;
    running = true;
    currentLang = targetLang;
    clearInjected();
    renderPill('Scanning page…');

    const blocks = (typeof SR_DOM !== 'undefined') ? SR_DOM.collectAllBlocks() : [];
    if (!blocks.length) {
      renderPill('Nothing on this page looks translatable.', true);
      running = false;
      return;
    }

    const onDevice = typeof SR_isOnDeviceLanguage === 'function' && SR_isOnDeviceLanguage(targetLang);
    const limit = onDevice ? DEVICE_BATCH_CHAR_LIMIT : GROQ_BATCH_CHAR_LIMIT;
    const chunks = chunkBlocks(blocks, limit);

    let done = 0;
    for (const chunk of chunks) {
      renderPill(`Translating… ${done}/${blocks.length}`);
      const response = await sendBatch(chunk, targetLang);
      if (!response || response.error) {
        const message = (response && response.message) || 'Translation failed.';
        renderPill(message, true);
        running = false;
        return;
      }
      response.results.forEach((r) => {
        const idx = Number(r.id.slice(1));
        if (blocks[idx]) insertTranslation(blocks[idx], r.text);
      });
      done += chunk.length;
    }
    renderPill(`Translated ${blocks.length} blocks · ${(typeof SR_fullLangName === 'function' ? SR_fullLangName(targetLang) : targetLang)}`);
    running = false;
  }

  function langOptionsHtml() {
    const list = (typeof SR_LANGUAGES_FULL !== 'undefined') ? SR_LANGUAGES_FULL : [{ code: 'en', name: 'English' }];
    return list.map((l) => `<option value="${l.code}">${l.name}</option>`).join('');
  }

  function renderPill(text, isError) {
    if (!pill) {
      pill = document.createElement('div');
      pill.className = 'sr-page-translate-pill';
      document.body.appendChild(pill);
    }
    pill.classList.toggle('sr-error', !!isError);
    pill.innerHTML = `
      <span class="sr-ptp-text"></span>
      <select class="sr-ptp-lang" aria-label="Translate to"></select>
      <button type="button" class="sr-ptp-close" aria-label="Turn off">✕</button>
    `;
    // Status text can carry a provider's error message, so it never goes through innerHTML.
    const label = pill.querySelector('.sr-ptp-text');
    label.textContent = text;
    label.title = text;
    const select = pill.querySelector('.sr-ptp-lang');
    select.innerHTML = langOptionsHtml();
    select.value = currentLang || 'en';
    select.addEventListener('change', (e) => run(e.target.value));
    pill.querySelector('.sr-ptp-close').addEventListener('click', stop);
  }

  function stop() {
    clearInjected();
    if (pill) { pill.remove(); pill = null; }
    running = false;
    window.__srPageTranslateLoaded = false;
  }

  function toggle() {
    if (pill) stop();
    else start();
  }

  function start() {
    chrome.storage.sync.get(['srTargetLang'], (r) => run(r.srTargetLang || 'en'));
  }

  window.SRPageTranslate = { toggle, stop, run };
  start();
})();
