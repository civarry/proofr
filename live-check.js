// Check as you type: underlines the mistakes Proofr's rules find in the text
// box you're typing in, and a card on hover fixes one with a click. Only the
// rules run here (constants.js, on this computer); nothing is sent anywhere.
// Registered on every page only while the "Check as I type" setting is on.
(() => {
  if (self.SR_LIVE) return;

  const WAIT_MS = 350; // after the last keystroke
  const MAX_CHARS = 20000;
  const FIX_INK = '#D2453B';
  const HINT_INK = '#1D64D8';

  let on = true;
  let school = false;
  let el = null; // the box being checked
  let marks = []; // { hit, rects: [DOMRect-like], kind }
  let timer = 0;
  let cardFor = null;
  let hideTimer = 0;
  let hasText = false;
  const dismissed = new WeakMap(); // el -> Set of "from→to"

  // --- What counts as a text box worth checking ---
  const deepActive = () => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  };
  const isField = (n) => !!n && (n.tagName === 'TEXTAREA' || (n.tagName === 'INPUT' && /^(text|search|)$/i.test(n.type)));
  const isRich = (n) => !!n && n.isContentEditable;
  // spellcheck="false" marks code editors, usernames and the like: left alone.
  const checkable = (n) => (isField(n) || isRich(n)) && n.spellcheck !== false && !n.closest('#sr-live-host, #smart-rewrite-modal, #sr-toast')
    && !n.readOnly && !n.disabled;
  const editorRoot = (n) => {
    let r = n;
    while (r.parentElement && r.parentElement.isContentEditable) r = r.parentElement;
    return r;
  };

  // --- Our own layer, in a shadow root so the page's CSS can't reach it ---
  const host = document.createElement('div');
  host.id = 'sr-live-host';
  host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483646;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host { --card: #FFFFFF; --ink: #23221E; --soft: #5E5B53; --line: #E6E3DC; --accent: #1D64D8; --accent-fg: #FFFFFF; --fix: ${FIX_INK}; --hint: ${HINT_INK}; }
    :host([data-theme="dark"]) { --card: #24231F; --ink: #EDEBE5; --soft: #C2BEB3; --line: #34322C; --accent: #7EA8F8; --accent-fg: #0F1B33; --fix: #F08A7E; --hint: #7EA8F8; }
    .u { position: fixed; height: 2px; border-radius: 999px; pointer-events: none; }
    .u.fix { background: var(--fix); }
    .u.hint { background: var(--hint); }
    .mirror { position: fixed; visibility: hidden; overflow: hidden; pointer-events: none; }
    .card { position: fixed; pointer-events: auto; width: max-content; max-width: 320px; box-sizing: border-box;
      padding: 12px 14px; background: var(--card); color: var(--ink); border: 1px solid var(--line); border-radius: 12px;
      box-shadow: 0 8px 24px rgba(0,0,0,.16); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
    .card[hidden] { display: none; }
    .head { font-size: 12px; font-weight: 600; color: var(--soft); margin-bottom: 4px; }
    .change { font-size: 15px; margin-bottom: 4px; word-break: break-word; }
    .from { color: var(--fix); text-decoration: line-through; }
    .to { font-weight: 650; }
    .why { font-size: 13px; color: var(--soft); margin-bottom: 10px; }
    .row { display: flex; gap: 8px; }
    button { font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; padding: 7px 12px; border-radius: 8px; cursor: pointer; }
    .use { background: var(--accent); color: var(--accent-fg); border: 1px solid transparent; }
    .skip { background: transparent; color: var(--ink); border: 1px solid var(--line); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    /* Beside the box: one capsule as tall as the text, Proofr's face at the top.
       The face shows how the text is doing; a dot marks each lower line with a
       mistake (a click on it opens that fix); a click anywhere else proofreads
       the whole box. */
    .handle { position: fixed; width: 22px; padding: 0; box-sizing: border-box; border: none; border-radius: 999px;
      background: transparent; pointer-events: auto; cursor: pointer; }
    .handle[hidden] { display: none; }
    /* The body is one SVG outline, so it can morph: circle, a bud with a waist,
       the capsule. Every shape has the same commands (see bodyPath). */
    .body { position: absolute; left: 0; top: 0; width: 22px; height: 100%; overflow: visible; pointer-events: none;
      filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.22)); }
    .body path { fill: var(--accent); }
    /* A faint band beside the line the cursor is on: the capsule as a map of the box. */
    .band { position: absolute; left: 2px; top: 0; width: 18px; border-radius: 8px; background: rgba(255,255,255,.07);
      opacity: 0; pointer-events: none; }
    .handle.long .band.on { opacity: 1; }
    .face { position: absolute; left: 0; top: 0; width: 22px; height: 22px; border-radius: 50%; color: var(--accent-fg); }
    .pin { position: absolute; left: 0; width: 22px; height: 14px; }
    .pin::after { content: ""; position: absolute; left: 8px; top: 4px; width: 6px; height: 6px; border-radius: 50%;
      background: var(--accent-fg); opacity: .9; transition: transform 120ms cubic-bezier(0, 0, 0, 1); }
    .pin.hint::after { opacity: .55; }
    .pin:not(.out):hover::after { transform: scale(1.5); }
    .look, .blink, .cheek, .puff, .eye { transform-box: fill-box; transform-origin: center; }
    /* The face's drawing area reaches past the 22px face (same units, so the
       face sits where it did): Chrome doesn't paint animated SVG parts outside
       an SVG's area, and the z's, stars, mittens and orbit live out there. */
    .face svg { position: absolute; left: -10px; top: -14px; width: 42px; height: 42px; pointer-events: none; transform-origin: 21px 25px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; overflow: visible; }
    /* A soft, round face: eyes low and wide apart, a small mouth, pink cheeks.
       Every eye and mouth is one move and two curves, so one expression melts
       into the next. A dot eye is the same path shrunk to a point, drawn thick. */
    .eye.l { d: path("M6 11.25C6.4 10 7 9.5 7.5 9.5C8 9.5 8.6 10 9 11.25C8.6 10 8 9.5 7.5 9.5C7 9.5 6.4 10 6 11.25"); }
    .eye.r { d: path("M13 11.25C13.4 10 14 9.5 14.5 9.5C15 9.5 15.6 10 16 11.25C15.6 10 15 9.5 14.5 9.5C14 9.5 13.4 10 13 11.25"); }
    .mouth { d: path("M9.5 13.4C10 14.5 10.5 14.85 11 14.85C11.5 14.85 12 14.5 12.5 13.4"); }
    .cheek { fill: #FFA3B8; stroke: none; }
    .handle[data-mood="typing"] .eye, .handle[data-mood="spotted"] .eye { stroke-width: 3; }
    .handle[data-mood="typing"] .eye.l { d: path("M7.9 10.75C7.93 10.75 7.97 10.75 8 10.75C8.03 10.75 8.07 10.75 8.1 10.75C8.07 10.75 8.03 10.75 8 10.75C7.97 10.75 7.93 10.75 7.9 10.75"); }
    .handle[data-mood="typing"] .eye.r { d: path("M14.9 10.75C14.93 10.75 14.97 10.75 15 10.75C15.03 10.75 15.07 10.75 15.1 10.75C15.07 10.75 15.03 10.75 15 10.75C14.97 10.75 14.93 10.75 14.9 10.75"); }
    .handle[data-mood="typing"] .mouth { d: path("M10.1 13.9C10.4 14.3 10.7 14.45 11 14.45C11.3 14.45 11.6 14.3 11.9 13.9"); }
    .handle[data-mood="typing"] .cheek { transform: scale(.77); }
    .handle[data-mood="spotted"] .eye.l { d: path("M7.4 10.75C7.43 10.75 7.47 10.75 7.5 10.75C7.53 10.75 7.57 10.75 7.6 10.75C7.57 10.75 7.53 10.75 7.5 10.75C7.47 10.75 7.43 10.75 7.4 10.75"); }
    .handle[data-mood="spotted"] .eye.r { d: path("M14.4 10.75C14.43 10.75 14.47 10.75 14.5 10.75C14.53 10.75 14.57 10.75 14.6 10.75C14.57 10.75 14.53 10.75 14.5 10.75C14.47 10.75 14.43 10.75 14.4 10.75"); }
    .handle[data-mood="spotted"] .mouth { d: path("M9.4 13.3C9.55 14.6 10.9 14.6 11 13.55C11.1 14.6 12.45 14.6 12.6 13.3"); }
    .handle[data-mood="spotted"] .cheek { transform: scale(.87); }
    .handle[data-mood="flustered"] .eye.l { d: path("M6.3 9.5C7 9.9 7.8 10.3 8.7 10.75C7.8 11.2 7 11.6 6.3 12C7 11.6 7.8 11.2 8.7 10.75C7.8 10.3 7 9.9 6.3 9.5"); }
    .handle[data-mood="flustered"] .eye.r { d: path("M15.7 9.5C15 9.9 14.2 10.3 13.3 10.75C14.2 11.2 15 11.6 15.7 12C15 11.6 14.2 11.2 13.3 10.75C14.2 10.3 15 9.9 15.7 9.5"); }
    .handle[data-mood="flustered"] .mouth { d: path("M9.8 13.6C10.2 14.55 10.6 14.85 11 14.85C11.4 14.85 11.8 14.55 12.2 13.6"); }
    .handle[data-mood="flustered"] .cheek { transform: scale(1.18); }
    /* More moods. thinking: you clicked it and the box is being proofread (eyes up,
       a dot orbits). dozing: an empty box. sparkle: a long text with no mistakes.
       caps: Caps Lock text like hELLO (it covers its ears). A wink when pointed at. */
    .handle[data-mood="thinking"] .eye { stroke-width: 3; }
    .handle[data-mood="thinking"] .eye.l { d: path("M7.4 10.4C7.43 10.4 7.47 10.4 7.5 10.4C7.53 10.4 7.57 10.4 7.6 10.4C7.57 10.4 7.53 10.4 7.5 10.4C7.47 10.4 7.43 10.4 7.4 10.4"); }
    .handle[data-mood="thinking"] .eye.r { d: path("M14.4 10.4C14.43 10.4 14.47 10.4 14.5 10.4C14.53 10.4 14.57 10.4 14.6 10.4C14.57 10.4 14.53 10.4 14.5 10.4C14.47 10.4 14.43 10.4 14.4 10.4"); }
    .handle[data-mood="thinking"] .mouth { d: path("M10.2 14.2C10.5 14.2 10.8 14.2 11 14.2C11.2 14.2 11.5 14.2 11.8 14.2"); }
    .handle[data-mood="thinking"] .cheek { transform: scale(.85); }
    .handle[data-mood="dozing"] .eye.l { d: path("M6 10.9C6.5 11.5 7 11.7 7.5 11.7C8 11.7 8.5 11.5 9 10.9C8.5 11.5 8 11.7 7.5 11.7C7 11.7 6.5 11.5 6 10.9"); }
    .handle[data-mood="dozing"] .eye.r { d: path("M13 10.9C13.5 11.5 14 11.7 14.5 11.7C15 11.7 15.5 11.5 16 10.9C15.5 11.5 15 11.7 14.5 11.7C14 11.7 13.5 11.5 13 10.9"); }
    .handle[data-mood="dozing"] .mouth { d: path("M10.4 14.2C10.4 13.5 11.6 13.5 11.6 14.2C11.6 14.9 10.4 14.9 10.4 14.2"); }
    .handle[data-mood="dozing"] .cheek { transform: scale(.8); }
    .handle[data-mood="sparkle"] .eye { stroke-width: .8; }
    .handle[data-mood="sparkle"] .eye.l { d: path("M7.5 8.1C7.88 10.22 7.88 10.22 10 10.6C7.88 10.98 7.88 10.98 7.5 13.1C7.12 10.98 7.12 10.98 5 10.6C7.12 10.22 7.12 10.22 7.5 8.1"); }
    .handle[data-mood="sparkle"] .eye.r { d: path("M14.5 8.1C14.88 10.22 14.88 10.22 17 10.6C14.88 10.98 14.88 10.98 14.5 13.1C14.12 10.98 14.12 10.98 12 10.6C14.12 10.22 14.12 10.22 14.5 8.1"); }
    .handle[data-mood="sparkle"] .cheek { transform: scale(1.1); }
    .handle[data-mood="caps"] .eye.l { d: path("M6.3 9.5C7 9.9 7.8 10.3 8.7 10.75C7.8 11.2 7 11.6 6.3 12C7 11.6 7.8 11.2 8.7 10.75C7.8 10.3 7 9.9 6.3 9.5"); }
    .handle[data-mood="caps"] .eye.r { d: path("M15.7 9.5C15 9.9 14.2 10.3 13.3 10.75C14.2 11.2 15 11.6 15.7 12C15 11.6 14.2 11.2 13.3 10.75C14.2 10.3 15 9.9 15.7 9.5"); }
    .handle[data-mood="caps"] .mouth { d: path("M9.3 14.1C9.9 13.4 10.4 13.4 11 14.1C11.6 14.8 12.1 14.8 12.7 14.1"); }
    .handle[data-wink] .eye.r { d: path("M13 10.9C13.5 11.5 14 11.7 14.5 11.7C15 11.7 15.5 11.5 16 10.9C15.5 11.5 15 11.7 14.5 11.7C14 11.7 13.5 11.5 13 10.9"); stroke-width: 1.5; }
    .eye { fill: currentColor; }
    /* The extras around the face. */
    .hand { fill: #FFFFFF; stroke: var(--accent); stroke-width: .9; }
    .hands g { transform-box: fill-box; transform-origin: center bottom; transform: translateY(7px) scale(.2); opacity: 0;
      transition: transform 320ms cubic-bezier(.34, 1.56, .64, 1), opacity 160ms ease; }
    .handle[data-mood="caps"] .hands g { transform: none; opacity: 1; }
    .orbit { transform-box: view-box; transform-origin: 11px 11px; opacity: 0; transition: opacity 200ms ease; }
    .sat { fill: var(--accent); stroke: var(--accent-fg); stroke-width: .9; }
    .sat.trail { opacity: .45; }
    .handle[data-mood="thinking"] .orbit { opacity: 1; animation: spin 900ms linear infinite; }
    .tw { fill: var(--accent); stroke: none; transform-box: fill-box; transform-origin: center; transform: scale(0); }
    .handle[data-mood="sparkle"] .tw { animation: twinkle 1600ms ease-in-out infinite; }
    .handle[data-mood="sparkle"] .tw + .tw { animation-delay: 800ms; }
    .handle[data-mood="sparkle"] .eye { animation: shine 1800ms ease-in-out infinite; }
    .z { fill: var(--accent); stroke: none; font: 800 7.5px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; opacity: 0; }
    .handle[data-mood="dozing"] .z { animation: float-z 2400ms ease-out infinite; }
    .handle[data-mood="dozing"] .z + .z { animation-delay: 1200ms; }
    .sweat { fill: #A9D4FF; stroke: var(--accent-fg); stroke-width: .7; transform-box: fill-box; transform-origin: center top; transform: scale(0); }
    .handle[data-mood="flustered"] .sweat { animation: drip 2600ms cubic-bezier(.4, 0, .2, 1) infinite; }
    .handle[data-look="plain"] .face { display: none; }
    .segs circle { fill: var(--accent); transform-box: fill-box; transform-origin: center; }
    /* What the bar means, the moment you point at it (a title shows only after a second). */
    .tip { position: fixed; pointer-events: none; white-space: nowrap; padding: 6px 10px; border-radius: 8px;
      background: var(--ink); color: var(--card); font: 600 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      box-shadow: 0 4px 12px rgba(0,0,0,.18); }
    .tip[hidden] { display: none; }
    .tip.enter { animation: card-in 120ms cubic-bezier(0, 0, 0, 1) both; }

    /* Motion: each one says what just happened, and none under reduced motion.
       Enter 180ms / exit 120ms with the same curves as Proofr's dialog and notes. */
    .u { transform-origin: left center; }
    .u.new { animation: draw-in 180ms cubic-bezier(0, 0, 0, 1) both; }          /* a mistake was found */
    .u.done { background: #2E9A5B; animation: shrink-away 240ms cubic-bezier(0.3, 0, 1, 1) both; transform-origin: center; } /* fixed */
    .u.gone { animation: fade-out 140ms cubic-bezier(0.3, 0, 1, 1) both; }      /* dismissed */
    .wash { position: fixed; border-radius: 4px; background: rgba(46, 154, 91, .28); pointer-events: none; animation: wash 700ms cubic-bezier(0.3, 0, 1, 1) both; }
    .card.enter { animation: card-in 140ms cubic-bezier(0, 0, 0, 1) both; }
    .card.leave { animation: fade-out 120ms cubic-bezier(0.3, 0, 1, 1) both; }
    .handle { transition: top 180ms cubic-bezier(0, 0, 0, 1); }                /* follows the text; the body's shape morphs in script */
    .face { transition: color 240ms ease; }
    .pin.new::after { animation: pin-in 260ms cubic-bezier(.34, 1.56, .64, 1) var(--d, 0ms) both; } /* a line got a mistake */
    .pin.out::after { animation: pin-out 180ms cubic-bezier(0.3, 0, 1, 1) both; }                  /* that line's mistake went */
    @keyframes pin-in { from { transform: scale(0); } to { transform: none; } }
    @keyframes pin-out { to { transform: scale(0); opacity: 0; } }
    .face path { transition: d 260ms cubic-bezier(0.4, 0, 0.2, 1), stroke-width 260ms cubic-bezier(0.4, 0, 0.2, 1); } /* the face changes expression */
    .cheek { transition: transform 260ms cubic-bezier(0.4, 0, 0.2, 1); }
    .look { transition: transform 200ms cubic-bezier(.2, 0, 0, 1); }           /* eyes ease toward the cursor or a dot */
    .band { transition: transform 160ms cubic-bezier(.2, 0, 0, 1), opacity 160ms ease; }
    .face svg.breathe { animation: breathe 3000ms ease-in-out infinite; }      /* idle: alive, barely */
    @keyframes breathe { 50% { transform: scale(1.03); } }
    @keyframes draw-in { from { transform: scaleX(0); } to { transform: scaleX(1); } }
    @keyframes shrink-away { from { transform: scaleX(1); opacity: 1; } to { transform: scaleX(0); opacity: 0; } }
    @keyframes fade-out { to { opacity: 0; } }
    @keyframes wash { 0% { opacity: 0; } 20% { opacity: 1; } 100% { opacity: 0; } }
    @keyframes card-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes twinkle { 0%, 100% { transform: scale(0) rotate(0deg); } 45% { transform: scale(1) rotate(45deg); } 70% { transform: scale(.85) rotate(60deg); } }
    @keyframes shine { 0%, 100% { transform: none; } 50% { transform: scale(1.22); } }
    @keyframes float-z { 0% { opacity: 0; transform: translate(0, 0); } 25% { opacity: 1; } 100% { opacity: 0; transform: translate(3px, -7px); } }
    @keyframes drip { 0% { transform: scale(0); } 18% { transform: scale(1.1); } 30% { transform: scale(1); } 75% { transform: translateY(2.5px) scaleY(1.1); opacity: 1; } 95%, 100% { transform: translateY(4px) scale(.6); opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
  </style><div class="layer"></div><div class="fx"></div><button type="button" class="handle" hidden data-mood="happy" data-look="caterpillar"><svg class="body" aria-hidden="true"><path class="shape"/><g class="segs"></g></svg><span class="band"></span><span class="face"><svg viewBox="-10 -14 42 42" aria-hidden="true"><g class="orbit" aria-hidden="true"><circle class="sat" cx="11" cy="-3.6" r="1.8"/><circle class="sat trail" cx="16.2" cy="-1.8" r="1.1"/></g><path class="sweat" d="M19.6 2.2C19.6 2.2 21.4 4.5 21.4 5.6C21.4 6.6 20.6 7.3 19.6 7.3C18.6 7.3 17.8 6.6 17.8 5.6C17.8 4.5 19.6 2.2 19.6 2.2Z"/><path class="tw" d="M21.5 -5C21.9 -2.6 22.1 -2.4 24.5 -2C22.1 -1.6 21.9 -1.4 21.5 1C21.1 -1.4 20.9 -1.6 18.5 -2C20.9 -2.4 21.1 -2.6 21.5 -5Z"/><path class="tw" d="M-.5 -.5C-.2 1.2 0 1.4 1.7 1.7C0 2 -.2 2.2 -.5 3.9C-.8 2.2 -1 2 -2.7 1.7C-1 1.4 -.8 1.2 -.5 -.5Z"/><text class="z" x="17" y="1.5">z</text><text class="z" x="19.5" y="-3">z</text><g class="look"><g class="blink"><path class="eye l"/><path class="eye r"/></g></g><path class="mouth"/><g class="puff"><ellipse class="cheek" cx="5.1" cy="13.4" rx="1.7" ry="1.05"/></g><g class="puff"><ellipse class="cheek" cx="16.9" cy="13.4" rx="1.7" ry="1.05"/></g><g class="hands"><g><ellipse class="hand" cx="1.4" cy="10.4" rx="2.3" ry="3.1"/></g><g><ellipse class="hand" cx="20.6" cy="10.4" rx="2.3" ry="3.1"/></g></g></svg></span><span class="pins"></span></button><div class="tip" hidden role="tooltip"></div><div class="card" hidden role="dialog" aria-label="Proofr suggestion">
    <div class="head"></div><div class="change"><span class="from"></span> → <span class="to"></span></div>
    <div class="why"></div><div class="row"><button type="button" class="use">Fix it</button><button type="button" class="skip">Dismiss</button></div></div>`;
  const layer = root.querySelector('.layer');
  const handle = root.querySelector('.handle');
  const face = root.querySelector('.face');
  const pins = root.querySelector('.pins');
  const shape = root.querySelector('.body path');
  const band = root.querySelector('.band');
  const faceSvg = face.querySelector('svg');
  const lookG = face.querySelector('.look');
  const blinkG = face.querySelector('.blink');
  const puffs = [...face.querySelectorAll('.puff')];
  // Motion run from script isn't covered by the stylesheet's reduced-motion
  // rule, so each piece asks first.
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // --- The body's outline ---
  // One path for every shape: from the top, four curves down the right side,
  // then the same four mirrored back up the left. Same commands every time, so
  // any shape morphs into any other.
  const K = 6.075; // a quarter circle of radius 11
  function bodyPath(right) {
    const f = (n) => Math.round(n * 100) / 100;
    const pt = ([x, y]) => `${f(x)} ${f(y)}`;
    const mir = ([x, y]) => [22 - x, y];
    const ends = [[11, 0], ...right.map((sg) => sg[2])];
    let d = 'M11 0';
    for (const [a, b, e] of right) d += `C${pt(a)} ${pt(b)} ${pt(e)}`;
    for (let i = right.length - 1; i >= 0; i--) d += `C${pt(mir(right[i][1]))} ${pt(mir(right[i][0]))} ${pt(mir(ends[i]))}`;
    return `path("${d}Z")`;
  }
  // The capsule (a circle when H is 22): round ends, straight 22px sides.
  function capsule(H) {
    H = Math.max(H, 22);
    const m = H / 2, third = (a, b) => [a + (b - a) / 3, b - (b - a) / 3];
    const [a2, b2] = third(11, m), [a3, b3] = third(m, H - 11);
    return bodyPath([[[11 + K, 0], [22, 11 - K], [22, 11]], [[22, a2], [22, b2], [22, m]],
      [[22, a3], [22, b3], [22, H - 11]], [[22, H - 11 + K], [11 + K, H], [11, H]]]);
  }
  // A bud: the face with a small blob pushing out under it, joined by a waist
  // 16px wide (never a thin neck).
  const BUD = bodyPath([[[11 + K, 0], [22, 11 - K], [22, 11]], [[22, 15.5], [19, 20.5], [19, 22.5]],
    [[19, 24.5], [20, 26.5], [20, 29]], [[20, 33], [15.5, 36], [11, 36]]]);
  let bodyH = 0, bodyAnim = null;
  function setBody(H, how) {
    const to = capsule(H);
    const from = getComputedStyle(shape).d; // where it is now, even mid-morph
    if (bodyAnim) bodyAnim.cancel();
    bodyAnim = null;
    shape.style.d = to;
    bodyH = H;
    if (how === 'snap' || calm() || !from || from === 'none') return;
    const io = 'cubic-bezier(0.4, 0, 0.2, 1)';
    const frames = how === 'bud'
      // Squash, bud, then the blob slides to the last line and settles with a spring.
      ? [{ d: from, easing: io }, { d: BUD, offset: 0.32, easing: io }, { d: capsule(H + 4), offset: 0.72, easing: io },
        { d: capsule(H - 1.2), offset: 0.88, easing: io }, { d: to }]
      : how === 'absorb'
        // The lower part pulls up through a waist and the face takes it in.
        ? [{ d: from, easing: io }, { d: BUD, offset: 0.45, easing: io }, { d: to }]
        : [{ d: from, easing: io }, { d: capsule(H + 3), offset: 0.6, easing: io }, { d: capsule(H - 1), offset: 0.82, easing: io }, { d: to }];
    bodyAnim = shape.animate(frames, { duration: how === 'bud' ? 420 : how === 'absorb' ? 320 : 340 });
  }

  // --- The face ---
  // One move at a time on the face; a new one replaces the last cleanly.
  let faceAnim = null;
  function faceMove(frames, opts) {
    if (calm() || !faced()) return;
    if (faceAnim) faceAnim.cancel();
    faceAnim = face.animate(frames, opts);
  }
  const SPRING = 'cubic-bezier(.34, 1.56, .64, 1)';
  const squash = () => faceMove([{ transform: 'none' }, { transform: 'translateY(2px) scale(1.12, .84)', offset: 0.35 }, { transform: 'none' }], { duration: 280, easing: 'cubic-bezier(0, 0, 0, 1)' });
  const pop = () => faceMove([{ transform: 'none' }, { transform: 'scale(1.18)', offset: 0.45 }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(0, 0, 0, 1)' });
  const hop = () => faceMove([{ transform: 'none', easing: 'cubic-bezier(.2, 0, 0, 1)' }, { transform: 'translateY(-2px)', offset: 0.35, easing: SPRING }, { transform: 'none' }], { duration: 420 });
  const gulp = () => faceMove([{ transform: 'none' }, { transform: 'translateY(-0.9px) scaleY(1.08)', offset: 0.5 }, { transform: 'none' }], { duration: 300, delay: 120, easing: 'ease-in-out' });
  const wiggle = () => faceMove([{ transform: 'none' }, { transform: 'translateX(1px)' }, { transform: 'translateX(-1px)' }, { transform: 'translateX(1px)' }, { transform: 'translateX(-1px)' }, { transform: 'none' }], { duration: 460, easing: 'ease-in-out' });
  function puff() {
    if (calm()) return;
    for (const g of puffs) g.animate([{ transform: 'none' }, { transform: 'scale(1.2)', offset: 0.4 }, { transform: 'none' }], { duration: 320, easing: 'ease-in-out' });
  }

  // Focused while you type, then how the text is doing; a quick smile when
  // you fix one.
  let typingNow = false, cheerUntil = 0, cheerTimer = 0, placedText = null, moodAt = 0, blinkAnim = null;
  // Which look sits beside the box: 'caterpillar' (the default), 'capsule', or
  // 'plain' (no face, no character motion).
  let lookStyle = 'caterpillar';
  const faced = () => lookStyle !== 'plain';
  // working: the whole box is being proofread (from a click on the face).
  // empty: an empty box, where the face dozes. lines: lines of text seen.
  let working = false, workingText = null, workTimer = 0, empty = false, textLines = 0;
  function setMood() {
    const n = marks.filter((m) => m.kind === 'fix').length;
    const caps = marks.some((m) => m.hit.id === 'caps-lock');
    const longText = textLines >= 3 || (lastText || '').length >= 160;
    const mood = working ? 'thinking' : empty ? 'dozing' : Date.now() < cheerUntil ? 'happy' : typingNow ? 'typing'
      : caps ? 'caps' : n === 0 ? (longText ? 'sparkle' : 'happy') : n >= 4 ? 'flustered' : 'spotted';
    if (mood === handle.dataset.mood) return;
    const was = handle.dataset.mood;
    handle.dataset.mood = mood;
    moodAt = Date.now();
    if (blinkAnim) { blinkAnim.cancel(); blinkAnim = null; } // never blink through a morph
    if (!handle.hidden && faced()) {
      if (mood === 'flustered') wiggle();
      if (mood === 'caps') cover();
      if (was === 'dozing' && mood !== 'dozing') hop(); // woke up
      if (mood === 'sparkle') hop();
    }
    lookSoon();
  }
  // Caps Lock: the mittens come up over its ears and press twice.
  function cover() {
    if (calm()) return;
    root.querySelectorAll('.hand').forEach((h, i) => h.animate([{ transform: 'none' }, { transform: 'scale(.88, 1.08)', offset: 0.3 }, { transform: 'none', offset: 0.55 }, { transform: 'scale(.9, 1.06)', offset: 0.75 }, { transform: 'none' }],
      { duration: 520, delay: 220 + i * 40, easing: 'ease-in-out' }));
  }
  // Pointed at: a wink and a little tilt, then back.
  let winkAt = 0;
  function wink() {
    if (!faced() || calm() || handle.hidden || Date.now() - winkAt < 1500) return;
    const mood = handle.dataset.mood;
    if (mood === 'thinking' || mood === 'dozing' || mood === 'caps') return;
    winkAt = Date.now();
    handle.dataset.wink = '1';
    setTimeout(() => { delete handle.dataset.wink; }, 420);
    faceMove([{ transform: 'none' }, { transform: 'rotate(-9deg)', offset: 0.35, easing: SPRING }, { transform: 'none' }], { duration: 560 });
  }
  // A click on the face proofreads the whole box: eyes up and a dot orbiting
  // until the result lands (the text changes or Proofr's note appears).
  const noteWatch = new MutationObserver(() => { if (document.getElementById('sr-toast')) doneWorking(); });
  function startWorking() {
    working = true;
    workStart = Date.now();
    workingText = lastText;
    clearTimeout(workTimer);
    workTimer = setTimeout(doneWorking, 10000);
    noteWatch.observe(document.documentElement, { childList: true, subtree: true });
    setMood();
  }
  let workStart = 0;
  function doneWorking() {
    if (!working) return;
    // Long enough to see that the click was taken, even when the rules finish at once.
    const wait = 700 - (Date.now() - workStart);
    if (wait > 0) { clearTimeout(workTimer); workTimer = setTimeout(doneWorking, wait); return; }
    working = false;
    clearTimeout(workTimer);
    noteWatch.disconnect();
    setMood();
  }

  // Blink now and then (sometimes twice), only when calm and not mid-morph.
  let blinkTimer = 0;
  function blink() {
    blinkTimer = setTimeout(blink, 3000 + Math.random() * 3000);
    const mood = handle.dataset.mood;
    if (calm() || handle.hidden || !faced() || (mood !== 'happy' && mood !== 'spotted') || Date.now() - moodAt < 400) return;
    const open = { transform: 'scaleY(1)' }, shut = { transform: 'scaleY(.1)' };
    blinkAnim = Math.random() < 0.2
      ? blinkG.animate([open, { ...shut, offset: 0.2 }, { ...open, offset: 0.41 }, { ...open, offset: 0.59 }, { ...shut, offset: 0.79 }, open], { duration: 340, easing: 'ease-in-out' })
      : blinkG.animate([open, { ...shut, offset: 0.45 }, open], { duration: 140, easing: 'ease-in-out' });
  }
  blinkTimer = setTimeout(blink, 3000 + Math.random() * 3000);

  // Breathing: after 2s with nothing happening, a slow swell; typing stops it.
  let idleTimer = 0;
  function stir() {
    faceSvg.classList.remove('breathe');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!calm() && !handle.hidden && faced()) faceSvg.classList.add('breathe'); }, 2000);
  }

  // Where the eyes look: at the cursor while you type, at a dot you point at,
  // otherwise ahead. One update per frame.
  let lookFrame = 0, hoverPin = null;
  function lookSoon() { if (!lookFrame) lookFrame = requestAnimationFrame(look); }
  function look() {
    lookFrame = 0;
    if (!el || handle.hidden) return;
    const f = face.getBoundingClientRect(), fx = f.left + 11, fy = f.top + 11;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    let tx = 0, ty = 0;
    const caret = caretPoint();
    if (handle.dataset.mood === 'thinking') ty = -1.2;
    else if (hoverPin) {
      const p = hoverPin.getBoundingClientRect();
      ty = clamp((p.top + 7 - fy) / 20, 0, 1.5);
    } else if (handle.dataset.mood === 'typing' && caret) {
      const dx = caret.x - fx, dy = caret.y - fy;
      tx = Math.sign(dx || 1) * clamp(0.5 + Math.abs(dx) / 400, 0.5, 1);
      ty = Math.abs(dy) < 6 ? 0 : clamp(dy / 40, -1, 1);
    }
    lookG.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px)`;
    // The band beside the cursor's line.
    const long = handle.classList.contains('long');
    if (long && caret && placed && caret.y >= placed.y0 && caret.y <= placed.y1) {
      const h = Math.min(Math.max(caret.h, 14), 28);
      band.style.height = `${h}px`;
      band.style.transform = `translateY(${(caret.y - placed.y0 - h / 2).toFixed(1)}px)`;
      band.classList.add('on');
    } else band.classList.remove('on');
  }
  // The cursor's place on screen: just after the character before it.
  function caretPoint() {
    if (!el) return null;
    if (isField(el)) {
      const v = el.value, pos = el.selectionEnd;
      if (pos == null || !v) return null;
      let s0 = pos - 1, e0 = pos, after = true;
      if (s0 < 0 || v[s0] === '\n') { s0 = pos; e0 = pos + 1; after = false; if (e0 > v.length || v[s0] === '\n') return null; }
      const qs = fieldRects(el, [{ start: s0, end: e0 }])[0].filter((q) => q.height > 0);
      const q = after ? qs[qs.length - 1] : qs[0];
      return q ? { x: after ? q.right : q.left, y: (q.top + q.bottom) / 2, h: q.height } : null;
    }
    const sel = (el.getRootNode().getSelection ? el.getRootNode() : window).getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0).cloneRange();
    if (!el.contains(r.endContainer)) return null;
    r.collapse(false);
    let qs = [...r.getClientRects()];
    if (qs.length) return { x: qs[0].left, y: (qs[0].top + qs[0].bottom) / 2, h: qs[0].height };
    if (r.endContainer.nodeType === 3 && r.endOffset > 0) {
      r.setStart(r.endContainer, r.endOffset - 1);
      qs = [...r.getClientRects()];
      const q = qs[qs.length - 1];
      if (q) return { x: q.right, y: (q.top + q.bottom) / 2, h: q.height };
    }
    return null;
  }
  document.addEventListener('selectionchange', () => { if (el) lookSoon(); });
  const fx = root.querySelector('.fx');
  const tip = root.querySelector('.tip'); // short-lived motion that outlives a redraw
  let shown = new Set(); // underlines already drawn in this box: only new ones animate
  let lastCount = -1;
  const restart = (node, cls) => { node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls); };
  const keyOf = (m, nth) => `${m.kind}|${m.hit.from}→${m.hit.to}#${nth}`;
  const card = root.querySelector('.card');
  const attach = () => { if (!host.isConnected) (document.body || document.documentElement).appendChild(host); };
  if (typeof SR_watchTheme === 'function') SR_watchTheme(host, 'data-theme');

  // --- Text, and where each character is on screen ---
  // A rich box's text is its text nodes, with a line break at each block, and
  // a map from text position back to [node, offset].
  const BLOCK = /^(DIV|P|LI|UL|OL|H[1-6]|BLOCKQUOTE|PRE|TR|TABLE|SECTION|ARTICLE)$/;
  function richText(box) {
    let text = '';
    const map = [];
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 1) {
        if ((n.tagName === 'BR' || BLOCK.test(n.tagName)) && text && !text.endsWith('\n')) { text += '\n'; map.push(null); }
        continue;
      }
      for (let i = 0; i < n.data.length; i++) { text += n.data[i]; map.push([n, i]); }
    }
    return { text, map };
  }
  const readText = (box) => (isField(box) ? { text: box.value, map: null } : richText(box));

  function richRange(map, start, end) {
    let a = start, b = end - 1;
    while (a <= b && !map[a]) a++;
    while (b >= a && !map[b]) b--;
    if (a > b) return null;
    const range = document.createRange();
    range.setStart(map[a][0], map[a][1]);
    range.setEnd(map[b][0], map[b][1] + 1);
    return range;
  }

  // A text field draws its own text, so a hidden copy with the same styles is
  // laid out at the same place, and the copy's spans give the rectangles.
  const COPY = ['boxSizing', 'width', 'height', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'borderStyle', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontStyle', 'fontVariant', 'fontWeight',
    'fontStretch', 'fontSize', 'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent', 'letterSpacing',
    'wordSpacing', 'tabSize', 'direction'];
  function fieldRects(box, hits) {
    const cs = getComputedStyle(box);
    const r = box.getBoundingClientRect();
    const mirror = document.createElement('div');
    mirror.className = 'mirror';
    for (const p of COPY) mirror.style[p] = cs[p];
    mirror.style.left = `${r.left}px`;
    mirror.style.top = `${r.top}px`;
    const area = box.tagName === 'TEXTAREA';
    mirror.style.whiteSpace = area ? 'pre-wrap' : 'pre';
    mirror.style.overflowWrap = area ? 'break-word' : 'normal';
    const inner = document.createElement('div'); // scrolled like the field
    inner.style.cssText = `position: relative; top: ${-box.scrollTop}px; left: ${-box.scrollLeft}px;`;
    if (!area) { inner.style.height = '100%'; inner.style.display = 'flex'; inner.style.alignItems = 'center'; }
    const line = document.createElement('span');
    let at = 0;
    const spans = [];
    for (const h of hits) {
      line.append(box.value.slice(at, h.start));
      const s = document.createElement('span');
      s.textContent = box.value.slice(h.start, h.end);
      line.append(s);
      spans.push(s);
      at = h.end;
    }
    line.append(box.value.slice(at) || '​');
    inner.append(line);
    mirror.append(inner);
    root.append(mirror);
    const out = spans.map((s) => [...s.getClientRects()]);
    mirror.remove();
    return out;
  }

  // The part of the box you can see: the box cut down by every container that
  // clips it (an editor often grows inside a smaller scrolling frame) and by
  // the window.
  function viewRect(box) {
    const b = box.getBoundingClientRect();
    let top = Math.max(b.top, 0), bottom = Math.min(b.bottom, innerHeight);
    let left = Math.max(b.left, 0), right = Math.min(b.right, innerWidth);
    for (let n = box.parentElement || box.getRootNode().host; n && n !== document.documentElement; n = n.parentElement || (n.getRootNode() && n.getRootNode().host)) {
      const cs = getComputedStyle(n);
      if (cs.overflowY !== 'visible' || cs.overflowX !== 'visible') {
        const c = n.getBoundingClientRect();
        if (cs.overflowY !== 'visible') { top = Math.max(top, c.top); bottom = Math.min(bottom, c.bottom); }
        if (cs.overflowX !== 'visible') { left = Math.max(left, c.left); right = Math.min(right, c.right); }
      }
      if (cs.position === 'fixed') break;
    }
    return { top, bottom, left, right };
  }
  // A scrolled-away word gets no line.
  const visibleIn = (box) => {
    const b = viewRect(box);
    return (q) => q.right > b.left && q.left < b.right && q.bottom > b.top + 1 && q.top < b.bottom - 1;
  };

  // --- Checking ---
  // Where the cursor is, as a text position (null when unknown).
  function caretAt(map) {
    if (isField(el)) return el.selectionEnd;
    const sel = (el.getRootNode().getSelection ? el.getRootNode() : window).getSelection();
    if (!sel || !sel.rangeCount || sel.focusNode.nodeType !== 3) return null;
    for (let i = 0; i < map.length; i++) {
      if (!map[i] || map[i][0] !== sel.focusNode) continue;
      if (map[i][1] === sel.focusOffset) return i;
      if (map[i][1] === sel.focusOffset - 1) return i + 1;
    }
    return null;
  }

  // typing: checked as each key lands, so the lines stay under their words
  // instead of blinking off; the word being typed waits until you pause.
  function check(typing) {
    if (!typing) clearTimeout(timer);
    typingNow = !!typing; // the face looks at the text while you type
    if (!on || !el || !el.isConnected) { clear(); return; }
    const { text, map } = readText(el);
    lastText = text;
    if (working && text !== workingText) doneWorking();
    if (!text.trim() && faced() && el.tagName !== 'INPUT') { doze(); return; }
    if (!text.trim() || text.length > MAX_CHARS) { clear(); return; }
    hasText = true;
    empty = false;
    const skip = dismissed.get(el) || new Set();
    const fixes = SR_ruleCheck(text, { atStart: true }).filter((h) => !skip.has(`${h.from}→${h.to}`));
    const taken = (h) => fixes.some((f) => h.start < f.end && h.end > f.start);
    const hints = school ? SR_ruleCheck(text, { kind: 'hint' }).filter((h) => !taken(h) && !skip.has(`${h.from}→${h.to}`)) : [];
    let all = [...fixes, ...hints].sort((a, b) => a.start - b.start);
    if (typing) {
      const caret = caretAt(map);
      if (caret != null) all = all.filter((h) => !(h.start <= caret && h.end >= caret));
    }
    const seen = {};
    marks = all.map((hit) => {
      const m = { hit, text, kind: hit.kind === 'hint' ? 'hint' : 'fix', range: map ? richRange(map, hit.start, hit.end) : null };
      const pair = `${m.kind}${hit.from}→${hit.to}`;
      m.key = keyOf(m, seen[pair] = (seen[pair] || 0) + 1);
      return m;
    });
    draw();
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => check(false), WAIT_MS); };
  // An empty box you're in: the face dozes beside its first line until you type.
  function doze() {
    marks = [];
    layer.textContent = '';
    hasText = true;
    empty = true;
    draw();
  }

  function placeHandle() {
    if (!el || !el.isConnected || !hasText) { handle.hidden = true; return; }
    attach();
    const r = el.getBoundingClientRect();
    const { top, bottom } = viewRect(el);
    if (bottom - top < 16 || r.right < 0 || r.left > innerWidth) { handle.hidden = true; return; }
    const n = marks.filter((m) => m.kind === 'fix').length;
    const appearing = handle.hidden;
    if (appearing) handle.style.transition = 'none'; // arrives in place, not from the last box
    handle.hidden = false;
    if (appearing) stir();
    handle.classList.toggle('clean', n === 0);
    // No number on it: always Proofr blue, and the face says how the text is
    // doing. The count is in the label and for screen readers.
    // Fewer mistakes than at the last pause: a fix (the text changed) gets
    // ^ ^, a hop and a cheek puff; a Dismiss (same text) just a pop. While you
    // type the word at the cursor isn't checked, so counts mid-typing don't count.
    const settledNow = !typingNow && lastText !== null;
    const edited = settledNow && lastText !== placedText;
    if (settledNow) placedText = lastText;
    if (settledNow && !appearing && lastCount > 0 && n < lastCount) {
      if (edited) { // you fixed one: ^ ^, a little hop and a cheek puff
        hop();
        puff();
        ripple(80);
        cheerUntil = Date.now() + 900;
        clearTimeout(cheerTimer);
        cheerTimer = setTimeout(setMood, 920);
      } else pop(); // dismissed: just the pop
    }
    if (settledNow) lastCount = n;
    handle.setAttribute('aria-label', empty ? 'Proofr: start typing and mistakes are underlined as you go' : n ? `Proofread this text box: ${n} mistake${n === 1 ? '' : 's'} underlined` : 'Proofread this text box: no mistakes underlined');
    handle.dataset.tip = empty ? 'Start typing. I\'ll check as you go.' : n ? `${n} mistake${n === 1 ? '' : 's'}. Click to fix the whole box.` : 'No mistakes found. Click to proofread the whole box.';
    if (!tip.hidden) showTip();
    // As tall as the text, not the box: a circle beside one line, growing with
    // each line written (and only the lines you can see).
    const ext = textExtent();
    let y0 = Math.max(top, ext ? ext.top : r.top), y1 = Math.min(bottom, ext ? ext.bottom : r.top + 22);
    const long = y1 - y0 >= 30;
    if (!long) { const mid = (y0 + y1) / 2; y0 = mid - 11; y1 = mid + 11; } // one line: just the face
    placed = { y0, y1 };
    // One line to more: the face squashes and buds, and the bud fills down to
    // the last line. Back to one: the capsule is pulled up into the face.
    // More lines while long: the capsule just grows, with a spring. Scrolling:
    // it follows exactly.
    const H = y1 - y0;
    const fresh = appearing || restyling;
    textLines = ext ? ext.lines.length : 0;
    budding = false;
    const turned = long !== handle.classList.contains('long');
    handle.classList.toggle('long', long);
    if (lookStyle === 'caterpillar') {
      // The caterpillar: the body stays the head, and each line below gets a
      // segment of its own (drawSegs).
      if (bodyH !== 22 || fresh) setBody(22, fresh || scrolling ? 'snap' : 'spring');
      let how = fresh || scrolling ? 'snap' : 'grow';
      if (turned && !fresh) {
        if (long) { squash(); how = 'bud'; budding = true; } else { how = 'absorb'; gulp(); }
      }
      drawSegs(ext, y0, y1, how);
    } else {
      if (segEls.size) { segs.textContent = ''; segEls = new Map(); }
      const plain = lookStyle === 'plain';
      if (turned && !fresh) {
        if (plain) setBody(H, 'spring');
        else if (long) { squash(); setBody(H, 'bud'); budding = true; }
        else { setBody(H, 'absorb'); gulp(); }
      } else if (fresh || scrolling || Math.abs(H - bodyH) < 8) {
        if (Math.abs(H - bodyH) > 0.25 || fresh) setBody(H, 'snap');
      } else setBody(H, 'spring');
    }
    setMood();
    // Just outside the box's left edge; inside its right edge when there's no room.
    const left = r.left >= 30 ? r.left - 28 : Math.min(r.right + 6, innerWidth - 26);
    handle.style.left = `${left}px`;
    handle.style.top = `${y0}px`;
    handle.style.height = `${y1 - y0}px`;
    if (appearing) { void handle.offsetWidth; handle.style.transition = ''; }
  }

  // --- The caterpillar's segments ---
  // One round segment per line below the first (the head sits beside the
  // first), a little smaller at the tail. Each is kept while its line is
  // there, so scrolling moves it with the line instead of redrawing it.
  const segs = root.querySelector('.segs');
  let segEls = new Map(), restyling = false;
  const NS = 'http://www.w3.org/2000/svg';
  function drawSegs(ext, y0, y1, how) {
    const lines = ext ? ext.lines : [];
    const step = lines.length > 1 ? Math.max(12, Math.min(40, lines[1].c - lines[0].c)) : 24;
    const r = Math.max(6, Math.min(10.5, step * 0.45));
    const shown = lines.filter((l) => l.c - y0 >= 22 + r * 0.6 && l.c <= y1 + 1);
    const next = new Map();
    const born = [];
    shown.forEach((l, i) => {
      const key = Math.round((l.c - ext.top) / step);
      const cy = l.c - y0, rad = i === shown.length - 1 && shown.length > 1 ? r * 0.8 : r;
      let c = segEls.get(key);
      if (!c) {
        c = document.createElementNS(NS, 'circle');
        c.setAttribute('cx', '11');
        segs.append(c);
        born.push(c);
      }
      c.setAttribute('cy', cy.toFixed(1));
      c.setAttribute('r', rad.toFixed(2));
      c.dataset.cy = cy;
      next.set(key, c);
    });
    const gone = [...segEls].filter(([k]) => !next.has(k)).map(([, c]) => c);
    segEls = next;
    const still = calm() || how === 'snap';
    // Leaving: pulled back up into the head (back to one line), or shrinking away.
    gone.reverse().forEach((c, i) => {
      if (still) { c.remove(); return; }
      const up = `translate(0px, ${(11 - Number(c.dataset.cy)).toFixed(1)}px) scale(.3)`;
      c.animate([{ transform: 'none', opacity: 1 }, { transform: how === 'absorb' ? up : 'scale(0)', opacity: 0 }],
        { duration: how === 'absorb' ? 300 : 220, delay: how === 'absorb' ? i * 35 : 0, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' })
        .finished.then(() => c.remove(), () => c.remove());
    });
    if (still) return;
    // Arriving: budding out of the head one after another, or popping in under
    // the last line; a ripple runs down the body when a line is added.
    born.forEach((c, i) => {
      const from = how === 'bud' ? `translate(0px, ${(11 - Number(c.dataset.cy)).toFixed(1)}px) scale(.35)` : 'scale(0)';
      c.animate([{ transform: from }, { transform: 'none' }], { duration: 420, delay: how === 'bud' ? 90 + i * 45 : 0, easing: SPRING, fill: 'backwards' });
    });
    if (born.length && how === 'grow') ripple(120);
  }
  // A wave down the segments, one after another.
  function ripple(delay = 0) {
    if (calm() || lookStyle !== 'caterpillar') return;
    [...segs.children].forEach((c, i) => c.animate([{ transform: 'none' }, { transform: 'translateX(1.8px)' }, { transform: 'translateX(-1.4px)' }, { transform: 'translateX(.6px)' }, { transform: 'none' }],
      { duration: 460, delay: delay + i * 60, easing: 'ease-in-out', composite: 'add' }));
  }
  // Now and then while calm, the caterpillar stretches: a slow ripple.
  let rippleTimer = setTimeout(function idleRipple() {
    rippleTimer = setTimeout(idleRipple, 6000 + Math.random() * 3000);
    const mood = handle.dataset.mood;
    if (!handle.hidden && segEls.size && !typingNow && ['happy', 'spotted', 'sparkle'].includes(mood)) ripple();
  }, 7000);
  // The look changed in Settings: redraw in the new one, without motion.
  function restyle() {
    segs.textContent = '';
    segEls = new Map();
    if (!el || handle.hidden) return;
    restyling = true;
    draw();
    restyling = false;
  }
  // Top of the first line to the bottom of the last.
  function textExtent() {
    let rects;
    if (isField(el)) {
      if (!el.value) return null;
      rects = fieldRects(el, [{ start: 0, end: el.value.length }])[0];
    } else {
      const range = document.createRange();
      range.selectNodeContents(el);
      rects = [...range.getClientRects()];
    }
    rects = rects.filter((q) => q.height > 0);
    if (!rects.length) return null;
    // Each line once: rectangles whose middles are within a few pixels are one line.
    const lines = [];
    for (const q of [...rects].sort((a, b) => a.top - b.top)) {
      const c = (q.top + q.bottom) / 2;
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.c - c) < Math.max(4, q.height / 3)) continue;
      lines.push({ c, h: q.height });
    }
    return { top: Math.min(...rects.map((q) => q.top)), bottom: Math.max(...rects.map((q) => q.bottom)), lines };
  }

  // A dot on the capsule beside each lower line with a mistake (the face covers
  // the first line); a click on it opens that line's first fix. Each dot is
  // kept while its mistake is there, so it slides with its line; a new one
  // pops in, and one whose mistake went shrinks away.
  let placed = null, pinEls = new Map(), budding = false, scrolling = false;
  function drawPins() {
    const next = new Map();
    if (placed && !handle.hidden) {
      const lines = new Map();
      for (const m of marks) {
        const q = m.rects && m.rects[0];
        if (!q) continue;
        const at = (q.top + q.bottom) / 2 - placed.y0;
        if (at < 24 || at > placed.y1 - placed.y0 - 5) continue;
        const k = Math.round(at / 6);
        const had = lines.get(k);
        if (!had || (had.kind === 'hint' && m.kind === 'fix')) lines.set(k, { m, at, kind: m.kind });
      }
      let i = 0;
      for (const { m, at, kind } of [...lines.values()].sort((x, y) => x.at - y.at)) {
        let p = pinEls.get(m.key);
        if (!p) {
          p = document.createElement('span');
          p.className = 'pin new';
          // While the capsule buds, the dots arrive one after another, top down.
          p.style.setProperty('--d', `${budding ? 220 + i * 40 : 0}ms`);
          p.addEventListener('click', (e) => { e.stopPropagation(); tip.hidden = true; showCard(p.mark); });
          p.addEventListener('mouseenter', () => { hoverPin = p; lookSoon(); });
          p.addEventListener('mouseleave', () => { if (hoverPin === p) hoverPin = null; lookSoon(); });
          pins.append(p);
        }
        p.mark = m;
        p.classList.toggle('hint', kind === 'hint');
        p.classList.toggle('fix', kind === 'fix');
        p.style.top = `${at - 7}px`;
        next.set(m.key, p);
        i++;
      }
    }
    for (const [k, p] of pinEls) {
      if (next.has(k)) continue;
      if (hoverPin === p) hoverPin = null;
      if (calm() || handle.hidden) { p.remove(); continue; }
      p.classList.remove('new');
      p.classList.add('out');
      setTimeout(() => p.remove(), 200);
    }
    pinEls = next;
  }

  function draw() {
    layer.textContent = '';
    placeHandle();
    if (!el || !marks.length) { drawPins(); return; }
    attach();
    const shows = visibleIn(el);
    const rects = isField(el) ? fieldRects(el, marks.map((m) => m.hit)) : marks.map((m) => (m.range ? [...m.range.getClientRects()] : []));
    marks.forEach((m, i) => {
      m.rects = rects[i].filter((q) => q.width > 0 && shows(q));
      for (const q of m.rects) {
        const u = document.createElement('div');
        u.className = `u ${m.kind}${shown.has(m.key) ? '' : ' new'}`;
        u.dataset.key = m.key;
        u.style.left = `${q.left}px`;
        u.style.top = `${q.bottom - 1}px`;
        u.style.width = `${q.width}px`;
        layer.append(u);
      }
    });
    shown = new Set(marks.filter((m) => m.rects.length).map((m) => m.key));
    drawPins();
  }
  // Lift a mark's lines out of the layer so their exit plays through the redraw.
  function retire(m, cls) {
    for (const u of layer.querySelectorAll('.u')) {
      if (u.dataset.key !== m.key) continue;
      u.classList.remove('new');
      u.classList.add(cls);
      fx.append(u);
      setTimeout(() => u.remove(), 300);
    }
    shown.delete(m.key);
  }
  // A soft green wash over the words just fixed, fading as you look.
  function wash(start, end) {
    if (!el) return;
    const rects = isField(el) ? fieldRects(el, [{ start, end }])[0]
      : (() => { const r = richRange(readText(el).map, start, end); return r ? [...r.getClientRects()] : []; })();
    for (const q of rects) {
      if (!q.width) continue;
      const w = document.createElement('div');
      w.className = 'wash';
      Object.assign(w.style, { left: `${q.left - 2}px`, top: `${q.top}px`, width: `${q.width + 4}px`, height: `${q.height}px` });
      fx.append(w);
      setTimeout(() => w.remove(), 760);
    }
  }

  function clear() {
    marks = [];
    hasText = false;
    lastCount = -1;
    layer.textContent = '';
    handle.hidden = true;
    pins.textContent = '';
    pinEls = new Map();
    segs.textContent = '';
    segEls = new Map();
    empty = false;
    working = false; // leaving the box: stop at once
    clearTimeout(workTimer);
    noteWatch.disconnect();
    hoverPin = null;
    band.classList.remove('on');
    faceSvg.classList.remove('breathe');
    clearTimeout(idleTimer);
    tip.hidden = true;
    hideCard(true);
  }

  // --- The card ---
  function showCard(m) {
    clearTimeout(hideTimer);
    if (cardFor === m) return;
    cardFor = m;
    const q = m.rects[0];
    card.querySelector('.head').textContent = m.kind === 'hint' ? 'For formal writing' : 'Proofr';
    card.querySelector('.from').textContent = m.hit.from;
    card.querySelector('.to').textContent = m.hit.to;
    card.querySelector('.why').textContent = m.hit.why;
    card.querySelector('.use').textContent = m.kind === 'hint' ? 'Use it' : 'Fix it';
    card.classList.remove('leave');
    const wasHidden = card.hidden;
    card.hidden = false;
    if (wasHidden) restart(card, 'enter');
    const cw = card.offsetWidth, ch = card.offsetHeight;
    const left = Math.max(8, Math.min(q.left, innerWidth - cw - 8));
    const below = q.bottom + 6;
    card.style.left = `${left}px`;
    card.style.top = `${below + ch > innerHeight - 8 ? Math.max(8, q.top - ch - 6) : below}px`;
  }
  function hideCard(now) {
    clearTimeout(hideTimer);
    const go = () => { card.hidden = true; card.classList.remove('leave', 'enter'); cardFor = null; };
    if (now || card.hidden) { go(); return; }
    hideTimer = setTimeout(() => { restart(card, 'leave'); hideTimer = setTimeout(go, 120); }, 250);
  }
  // The pointer is over a word when it's inside the word's box (a little taller
  // than the text, so the line under it counts too).
  const markAt = (x, y) => marks.find((m) => (m.rects || []).some((q) => x >= q.left && x <= q.right && y >= q.top - 2 && y <= q.bottom + 4));
  document.addEventListener('mousemove', (e) => {
    if (!marks.length) return;
    if (e.composedPath().includes(card)) { clearTimeout(hideTimer); return; }
    const m = markAt(e.clientX, e.clientY);
    if (m) showCard(m); else if (cardFor) hideCard(false);
  }, { passive: true, capture: true });

  // Clicking the card must not take focus from the box being edited.
  card.addEventListener('mousedown', (e) => e.preventDefault());
  card.querySelector('.skip').addEventListener('click', () => {
    if (!cardFor || !el) return;
    if (!dismissed.has(el)) dismissed.set(el, new Set());
    dismissed.get(el).add(`${cardFor.hit.from}→${cardFor.hit.to}`);
    retire(cardFor, 'gone');
    hideCard(true);
    check();
  });
  card.querySelector('.use').addEventListener('click', () => { if (cardFor) apply(cardFor); });
  function showTip() {
    tip.textContent = handle.dataset.tip || '';
    const wasHidden = tip.hidden;
    tip.hidden = false;
    const h = handle.getBoundingClientRect();
    const above = h.top - tip.offsetHeight - 6;
    tip.style.left = `${Math.max(8, Math.min(h.left, innerWidth - tip.offsetWidth - 8))}px`;
    tip.style.top = `${above >= 8 ? above : h.bottom + 6}px`;
    if (wasHidden) restart(tip, 'enter');
  }
  handle.addEventListener('mouseenter', (e) => { showTip(); if (!e.target.closest || !e.target.closest('.pin')) wink(); });
  handle.addEventListener('mouseleave', () => { tip.hidden = true; });
  handle.addEventListener('mousedown', (e) => e.preventDefault()); // keep the cursor in the box
  handle.addEventListener('click', () => {
    tip.hidden = true;
    if (!el) return;
    el.focus();
    hideCard(true);
    if (empty) return; // nothing to proofread yet
    startWorking();
    try { chrome.runtime.sendMessage({ action: 'liveProofreadBox' }); } catch (_) { doneWorking(); /* extension reloaded */ }
  });

  // Put the fix in through the same path as Proofread (write-back.js), which
  // knows each editor's way in, and only if the text is still what was checked.
  async function apply(m) {
    const box = el;
    hideCard(true);
    if (!box || readText(box).text !== m.text) { check(); return; }
    retire(m, 'done');
    box.focus();
    if (isField(box)) {
      box.setSelectionRange(m.hit.start, m.hit.end);
    } else {
      if (!m.range) return;
      const sel = (box.getRootNode().getSelection ? box.getRootNode() : window).getSelection();
      sel.removeAllRanges();
      sel.addRange(m.range);
    }
    const id = `live-${Date.now()}`;
    const went = self.SR_WB && self.SR_WB.capture(id, m.hit.from) ? await self.SR_WB.insert(id, m.hit.to) : null;
    check();
    if (went && el === box) wash(m.hit.start, m.hit.start + m.hit.to.length);
  }

  // --- Following the box you're in ---
  // A change can arrive without an "input" event: an editor with its own model
  // (Lexical, Slate, Draft) puts pasted text in itself, a site sets a field's
  // value from code, and Proofread's own result goes in as a paste. So a rich
  // box is watched for any change to its text, and a field's value is compared
  // once a second while you're in it. Without this the count beside the box
  // went stale after the box was fixed.
  let lastText = null;
  const watcher = new MutationObserver(() => { if (el && readText(el).text !== lastText) changed(); });
  let poll = 0;
  function changed() {
    hideCard(true);
    stir();
    lookSoon();
    if (readLength(el) <= 5000) { cancelAnimationFrame(typingFrame); typingFrame = requestAnimationFrame(() => check(true)); } else { layer.textContent = ''; placeHandle(); }
    schedule();
  }
  function follow(target) {
    const box = target && checkable(target) ? (isRich(target) ? editorRoot(target) : target) : null;
    if (box === el) return;
    el = box;
    clear();
    shown = new Set();
    lastText = null;
    watcher.disconnect();
    clearInterval(poll);
    if (!el) return;
    if (isRich(el)) watcher.observe(el, { childList: true, characterData: true, subtree: true });
    else poll = setInterval(() => { if (el && el.isConnected && el.value !== lastText) changed(); }, 1000);
    schedule();
  }
  document.addEventListener('focusin', () => follow(deepActive()), true);
  document.addEventListener('focusout', () => setTimeout(() => {
    const now = deepActive();
    if (!now || !el || (now !== el && !el.contains(now))) follow(now);
  }, 0), true);
  document.addEventListener('input', (e) => {
    const t = e.composedPath()[0];
    if (!el || !(t === el || (el.contains && el.contains(t)))) return;
    // Each key: the lines follow the text at once (a long box waits for the pause).
    changed();
  }, true);
  let typingFrame = 0;
  function readLength(box) { return isField(box) ? box.value.length : (box.textContent || '').length; }
  // Moving the page or the box moves the words: redraw where they are now.
  let frame = 0;
  const redraw = () => {
    if (!el || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      hideCard(true);
      // Scrolling: the capsule and its dots move with the text, no easing.
      scrolling = true;
      handle.style.transition = 'none';
      draw();
      void handle.offsetWidth;
      handle.style.transition = '';
      scrolling = false;
      lookSoon();
    });
  };
  addEventListener('scroll', redraw, { capture: true, passive: true });
  addEventListener('resize', redraw, { passive: true });

  // --- Settings ---
  const settings = (s) => {
    if ('srLiveCheck' in s) on = s.srLiveCheck !== false;
    if ('srSchool' in s) school = s.srSchool === true;
    if ('srLiveLook' in s) {
      const next = ['caterpillar', 'capsule', 'plain'].includes(s.srLiveLook) ? s.srLiveLook : 'caterpillar';
      if (next !== lookStyle) { lookStyle = next; handle.dataset.look = next; restyle(); }
    }
  };
  try {
    chrome.storage.sync.get(['srLiveCheck', 'srSchool', 'srLiveLook']).then((s) => { settings(s); follow(deepActive()); });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      const s = {};
      for (const k of ['srLiveCheck', 'srSchool', 'srLiveLook']) if (changes[k]) s[k] = changes[k].newValue;
      if (Object.keys(s).length) { settings(s); if (on) check(); else clear(); }
    });
  } catch (_) { /* extension reloaded: this copy stays quiet */ }

  // For tests: what's underlined now, and where.
  self.SR_LIVE = {
    marks: () => marks.map((m) => ({ from: m.hit.from, to: m.hit.to, kind: m.kind, id: m.hit.id, rects: (m.rects || []).map((q) => ({ left: Math.round(q.left), top: Math.round(q.top), right: Math.round(q.right), bottom: Math.round(q.bottom) })) })),
    card: () => (card.hidden ? null : { from: card.querySelector('.from').textContent, to: card.querySelector('.to').textContent, why: card.querySelector('.why').textContent, head: card.querySelector('.head').textContent }),
    root,
    checkNow: check,
  };
})();
