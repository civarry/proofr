// The website's proofreader: the extension's own Proofread (constants.js, kept
// identical to the extension's copy by store/package.sh). Proofr's rules run
// in any browser; Chrome's built-in model adds sentence-level fixes where it
// can run. Nothing here talks to a server.
(() => {
  const $ = (id) => document.getElementById(id);
  const say = (t) => { $('status').textContent = t; };
  let fixed = '';
  let aiReady = false;

  // No built-in AI here: the rules still work, and the card says what's missing.
  const rulesOnly = (why) => {
    $('setup').hidden = true;
    $('go').disabled = false;
    say("Ready. Proofr's rules run on this computer.");
    $('cant-why').textContent = why;
    $('cant').hidden = false;
  };

  const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // One span per change, deleted then inserted words, with the rule as its tooltip.
  let reasons = [];
  const diffHtml = (ops) => {
    const groups = SR_diffGroups(ops);
    let html = '';
    for (let k = 0; k < ops.length; k++) {
      const g = groups[k];
      if (g < 0) { html += escape(ops[k].text); continue; }
      let del = '', ins = '';
      for (; k < ops.length && groups[k] === g; k++) {
        if (ops[k].type === 'del') del += ops[k].text; else ins += ops[k].text;
      }
      k--;
      const why = SR_changeReason(del, ins, reasons);
      html += `<span class="change"${why ? ` title="${escape(why)}"` : ''}>${del ? `<del>${escape(del)}</del>` : ''}${ins ? `<ins>${escape(ins)}</ins>` : ''}</span>`;
    }
    return html;
  };

  async function proofread() {
    const text = $('text').value.trim();
    if (!text) { say('Paste some text first.'); return; }
    $('go').disabled = true;
    say('Proofreading on this computer…');
    try {
      // Rules first, then Chrome's built-in AI when it can run, then the rules again.
      const res = await SR_proofreadHybrid(text, { runAI: aiReady ? (t) => SR_rewriteAuto(t, 'grammar', { engine: 'device' }) : null });
      const out = res.text;
      fixed = out;
      reasons = res.hits;
      const ops = SR_wordDiffForDisplay(text, out, 'grammar');
      const n = ops ? SR_diffCount(ops) : null;
      $('diff').innerHTML = ops ? diffHtml(ops) : escape(out);
      $('out').hidden = false;
      // Rules alone count their fixes ("alot" → "a lot" is one fix, two marks).
      const shown = !res.ai && res.ruleCount ? res.ruleCount : n;
      say(n === 0 ? 'No mistakes found' : n ? `${shown} fix${shown === 1 ? '' : 'es'}` : 'Done.');
    } catch (e) {
      say(e && e.message ? e.message : 'Something went wrong. Try again.');
    } finally {
      $('go').disabled = false;
    }
  }

  async function setup() {
    $('setup').disabled = true;
    say('Downloading Chrome\'s built-in AI. This happens once.');
    try {
      const session = await LanguageModel.create({
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
        monitor: (m) => m.addEventListener('downloadprogress', (e) => say(`Downloading Chrome's built-in AI… ${Math.round((e.loaded || 0) * 100)}%`)),
      });
      session.destroy();
      $('setup').hidden = true;
      $('go').disabled = false;
      aiReady = true;
      say('Ready.');
    } catch (e) {
      $('setup').disabled = false;
      say(`Chrome couldn't set it up: ${e && e.message ? e.message : 'unknown error'}`);
    }
  }

  (async () => {
    if (typeof LanguageModel === 'undefined') {
      rulesOnly('This browser doesn\'t have Chrome\'s built-in AI, so Proofr\'s own rules check your text: common mistakes like its and it\'s, a and an, and missing apostrophes. Fixes that need the whole sentence need a recent desktop version of Chrome.');
      return;
    }
    const state = await SR_deviceAvailability();
    if (state === 'available') { aiReady = true; $('go').disabled = false; say('Ready. Runs on this computer.'); }
    else if (state === 'downloadable' || state === 'downloading') {
      // Chrome downloads the model only when asked, so the page asks first.
      // Until then the rules work on their own.
      $('setup').hidden = false;
      $('go').disabled = false;
      say("Proofr's rules work now. For sentence-level fixes, Chrome needs to download its built-in AI once.");
    } else {
      rulesOnly('Chrome can\'t run its built-in AI on this computer (Google sets the memory and disk requirements), so Proofr\'s own rules check your text: common mistakes like its and it\'s, a and an, and missing apostrophes.');
    }
  })();

  $('go').addEventListener('click', proofread);
  $('setup').addEventListener('click', setup);
  $('text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !$('go').disabled) proofread(); });
  $('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(fixed); say('Copied.'); } catch (_) { say('Couldn\'t copy. Select the text and copy it.'); }
  });
})();
