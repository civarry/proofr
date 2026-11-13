// Check as I type inside frames (an editor or a "Try it" result shown in an
// iframe). Runs in every frame, and is tiny: the checker itself is only added
// to a frame once a text box in it gets focus, so ads and embeds never load it.
// The top page gets the checker from its own registration.
(() => {
  if (window === window.top || self.__srLiveFrame) return;
  self.__srLiveFrame = true;
  const box = (n) => !!n && (n.tagName === 'TEXTAREA' || (n.tagName === 'INPUT' && /^(text|search|)$/i.test(n.type)) || n.isContentEditable);
  let asked = false;
  const ask = (n) => {
    if (asked || self.SR_LIVE || !box(n)) return;
    asked = true;
    document.removeEventListener('focusin', onFocus, true);
    try { chrome.runtime.sendMessage({ action: 'liveFrameNeeded' }); } catch (_) { /* extension reloaded */ }
  };
  const onFocus = (e) => ask(e.composedPath()[0]);
  document.addEventListener('focusin', onFocus, true);
  ask(document.activeElement);
})();
