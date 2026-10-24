// Appearance: Light, Dark, or Auto (the computer's setting), from Settings.
// Sets a data attribute that the dark palette keys off. Loaded in <head> of
// the extension's own pages, so the right colors are there on the first
// paint (the last choice is cached in localStorage for that); content.js
// calls it for Proofr's dialog and notes on web pages.
function SR_watchTheme(root, attr, cache) {
  const media = matchMedia('(prefers-color-scheme: dark)');
  let choice = 'auto';
  if (cache) { try { choice = localStorage.getItem('srTheme') || 'auto'; } catch (_) { /* no storage: Auto */ } }
  const apply = () => root.setAttribute(attr, choice === 'light' || choice === 'dark' ? choice : (media.matches ? 'dark' : 'light'));
  const set = (value) => {
    choice = value || 'auto';
    if (cache) { try { localStorage.setItem('srTheme', choice); } catch (_) { /* ignore */ } }
    apply();
  };
  apply();
  media.addEventListener('change', apply);
  try {
    chrome.storage.sync.get(['srTheme']).then((r) => set(r.srTheme)).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => { if (area === 'sync' && changes.srTheme) set(changes.srTheme.newValue); });
  } catch (_) { /* extension context gone: keep what's applied */ }
}

if (location.protocol === 'chrome-extension:') SR_watchTheme(document.documentElement, 'data-theme', true);
