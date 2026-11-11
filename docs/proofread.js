// The website's proofreader: the extension's own Proofread (constants.js, kept
// identical to the extension's copy by store/package.sh) running on Chrome's
// built-in model inside this page. Nothing here talks to a server.
(() => {
  const $ = (id) => document.getElementById(id);
  const say = (t) => { $('status').textContent = t; };
  let fixed = '';

  const cant = (why) => {
    $('go').disabled = true;
    $('setup').hidden = true;
    say('');
    $('cant-why').textContent = why;
    $('cant').hidden = false;
  };

  const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // One span per change, deleted then inserted words, with the rule as its tooltip.
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
      const why = SR_changeReason(del, ins);
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
      const { text: out } = await SR_rewriteAuto(text, 'grammar', { engine: 'device' });
      fixed = out;
      const ops = SR_wordDiffForDisplay(text, out, 'grammar');
      const n = ops ? SR_diffCount(ops) : null;
      $('diff').innerHTML = ops ? diffHtml(ops) : escape(out);
      $('out').hidden = false;
      say(n === 0 ? 'Nothing to fix.' : n ? `Fixed ${n} thing${n === 1 ? '' : 's'}.` : 'Done.');
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
      say('Ready.');
    } catch (e) {
      $('setup').disabled = false;
      say(`Chrome couldn't set it up: ${e && e.message ? e.message : 'unknown error'}`);
    }
  }

  (async () => {
    if (typeof LanguageModel === 'undefined') {
      cant('This browser doesn\'t have Chrome\'s built-in AI. It needs a recent desktop version of Chrome.');
      return;
    }
    const state = await SR_deviceAvailability();
    if (state === 'available') { $('go').disabled = false; say('Ready. Runs on this computer.'); }
    else if (state === 'downloadable' || state === 'downloading') {
      // Chrome downloads the model only when asked, so the page asks first.
      $('setup').hidden = false;
      say('Chrome needs to download its built-in AI once before this works.');
    } else {
      cant('Chrome can\'t run its built-in AI on this computer. It needs enough memory and disk space, and Google sets the requirements.');
    }
  })();

  $('go').addEventListener('click', proofread);
  $('setup').addEventListener('click', setup);
  $('text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !$('go').disabled) proofread(); });
  $('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(fixed); say('Copied.'); } catch (_) { say('Couldn\'t copy. Select the text and copy it.'); }
  });
})();
