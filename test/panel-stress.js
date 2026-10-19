// Drives Proofr's real side panel: types each text into the composer, sends
// it, and waits for the result, like a person would. Paste into the side
// panel's console (right-click inside the panel → Inspect → Console).
//   RUNS: how many (default 200). ENGINE: 'device' (default, free, on this
//   computer) or 'cloud' (your provider; mind its rate limits).
// It restores your engine setting and "Learn from my proofreads" when done,
// so test sentences never land in your Progress.
(async (RUNS = 200, ENGINE = 'device') => {
  const SUBJECTS = ['the report', 'our team', 'the client', 'my manager', 'the new intern', 'the budget', 'the vendor', 'the design', 'the launch', 'the survey'];
  const WHEN = ['before friday', 'by tomorow', 'after lunch', 'next week', 'on monday', 'before the meeting', 'by end of day', 'this afternoon', 'in the morning', 'before the deadline'];
  const BROKEN = [
    (s, w) => `${s} was suppose to be ready ${w} but i dont think its finished`,
    (s, w) => `can you check if ${s} are ready ${w}? their still waiting on it`,
    (s, w) => `i recieved the notes about ${s} and will reply ${w}, thanks for you help`,
    (s, w) => `we was hoping ${s} would be approved ${w} but its been delayed`,
    (s, w) => `${s} have alot of open questions, lets go over them ${w}`,
    (s, w) => `i should of sent ${s} earlier, i will fix it ${w}`,
    (s, w) => `there going to review ${s} ${w} and send feedback`,
  ];
  const CASUAL = [
    (s, w) => `hey, quick one: ${s} is slipping, can we talk ${w}? lmk`,
    (s, w) => `so ${s} is kinda a mess rn, gonna need a hand ${w}`,
    (s, w) => `fyi ${s} got pushed, not my call, sorry. we'll sort it ${w}`,
    (s, w) => `ok so ${s} needs a decision ${w} or we lose the slot`,
  ];
  const MODES = ['grammar', 'grammar', 'professional', 'grammar', 'friendly', 'grammar', 'short', 'simple'];
  const runs = Array.from({ length: RUNS }, (_, i) => {
    const mode = MODES[i % MODES.length];
    const s = SUBJECTS[i % 10], w = WHEN[(i * 3 + Math.floor(i / 10)) % 10];
    // Unique text each time (nothing from the cache), with no stray numbers for the change guard.
    const tail = ['', ' please', ' asap', ' if possible', ' thanks', ' for now', ' as well'][Math.floor(i / 10) % 7];
    return { mode, text: (mode === 'grammar' ? BROKEN[i % 7](s, w) : CASUAL[i % 4](s, w)) + tail + (i >= 70 ? ` round ${'abcdefghij'[Math.floor(i / 70) % 10]}${'klmnopqrst'[i % 10]}` : '') };
  });

  const saved = await chrome.storage.sync.get(['srEngine', 'srInsightsOn']);
  await chrome.storage.sync.set({ srEngine: ENGINE, srInsightsOn: false });
  if (typeof showTab === 'function') showTab('write');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const t0 = performance.now();
  console.log(`Proofr panel stress: ${RUNS} rewrites on ${ENGINE}. Watch the panel.`);
  try {
    for (const [i, run] of runs.entries()) {
      currentMode = run.mode;
      updateModeTag();
      refs.ta.value = run.text;
      refs.ta.dispatchEvent(new Event('input', { bubbles: true }));
      const before = turns.length ? turns[turns.length - 1].id : null;
      const start = performance.now();
      await sendMessage();
      // Wait for this turn to finish (the panel clears activeRun when done).
      await sleep(50);
      while (activeRun) await sleep(50);
      const turn = turns[turns.length - 1];
      const ok = turn && turn.id !== before && turn.status === 'done';
      results.push({ i: i + 1, mode: run.mode, ok, ms: Math.round(performance.now() - start), where: turn && turn.where, error: ok ? undefined : (turn && turn.errorMessage) });
      if ((i + 1) % 10 === 0) console.log(`${i + 1}/${RUNS} done, ${results.filter((r) => r.ok).length} ok`);
    }
  } finally {
    const restore = {};
    const remove = [];
    for (const k of ['srEngine', 'srInsightsOn']) (k in saved ? (restore[k] = saved[k]) : remove.push(k));
    if (Object.keys(restore).length) await chrome.storage.sync.set(restore);
    if (remove.length) await chrome.storage.sync.remove(remove);
  }
  const okMs = results.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
  const q = (p) => okMs[Math.min(okMs.length - 1, Math.floor(p * okMs.length))];
  const summary = { runs: RUNS, ok: okMs.length, failed: RUNS - okMs.length, medianMs: q(0.5), slowest5pctMs: q(0.95), totalSeconds: Math.round((performance.now() - t0) / 1000), engine: [...new Set(results.map((r) => r.where))] };
  console.table(results.filter((r) => !r.ok));
  console.log('Summary', summary);
  window.__panelStress = { summary, results };
  return summary;
})();
