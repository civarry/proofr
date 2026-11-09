// Proofr's dialog, note and hover menu live in the page, so a site's own CSS can
// reach them. A docs site's `button + button { margin-left: 16px }` knocked the
// tone grid out of line. Every Proofr element must have the same size, position
// and key styles on a hostile page as on a clean one.
//
// usage: PUPPETEER=<puppeteer esm entry> node test/e2e-page-css.mjs [extDir]
//        REAL_URL=<https page> also runs the dialog on that real site.
//        SHOTS=<dir> saves a screenshot of each page's dialog.
const { default: puppeteer } = await import(process.env.PUPPETEER || 'puppeteer');
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const src = path.resolve(process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), '..'));
const PORT = 8773;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

// The kind of rule real sites ship: bare tags, then the same behind a class,
// which outranks a single-class rule of Proofr's.
const ELEMENT_RULES = (b) => `
${b}button { margin: 8px; padding: 20px; min-width: 140px; min-height: 50px; float: left; text-transform: uppercase; letter-spacing: 2px; word-spacing: 4px; text-indent: 3px; box-shadow: 0 0 5px red; text-shadow: 1px 1px red; font-size: 22px; line-height: 3; border: 4px solid red; border-radius: 20px; background: red; color: white; text-align: right; font-weight: 900; font-style: italic; text-decoration: underline; opacity: .8; transform: scale(1.1); position: relative; top: 5px; }
${b}button + button { margin-left: 16px; }
${b}p, ${b}div, ${b}span, ${b}h2, ${b}kbd, ${b}label { margin: 9px; padding: 7px; float: none; line-height: 2; letter-spacing: 1px; word-spacing: 3px; text-transform: uppercase; text-indent: 2px; font-size: 20px; font-weight: 900; color: red; border-radius: 9px; }
${b}svg { width: 60px; height: 60px; margin: 5px; }
${b}select { margin: 6px; padding: 12px; min-height: 60px; font-size: 20px; }
`;
const PAGES = {
  clean: '',
  'bare tag rules': `* { box-sizing: border-box; } ${ELEMENT_RULES('')}`,
  'rules behind a class': `*, *::before { box-sizing: border-box; } ${ELEMENT_RULES('.site ')}`,
  'the docs-site rule alone': 'button + button { margin-left: 16px; }',
};
const html = (css) => `<!doctype html><meta charset="utf-8"><title>css</title><style>${css}</style>
<body class="site"><main style="width:900px"><h1>Page</h1>
<p id="para" style="all:revert;display:block;font:16px/1.5 sans-serif;width:800px">This is a paragraph of page text that is long enough to get hover actions, with teh mistake in it for the proofread.</p>
<textarea id="box" style="all:revert;display:block;width:500px;height:60px">teh box text is here for the note</textarea>
</main></body>`;

const server = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.url.startsWith('/page/')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html(PAGES[decodeURIComponent(req.url.slice(6))] ?? '')); }
  if (req.url === '/v1/models') { res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] })); }
  if (req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const sent = JSON.stringify(JSON.parse(body).messages);
      const out = sent.includes('box text') ? 'the box text is here for the note' : 'This is a paragraph of page text that is long enough to get hover actions, with the mistake in it for the proofread.';
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: out } }] }));
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT);

const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'proofr-css-'));
fs.cpSync(src, ext, { recursive: true, filter: (p) => !/\/(\.git|market-research|store|screenshots|store-screenshots|node_modules|v2shots|test)(\/|$)/.test(p) });
const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ ...manifest, host_permissions: ['<all_urls>'] }, null, 2));

// Runs in the page: every element under a root, its box relative to the root,
// and the styles a site most often changes.
const snapshot = (selector) => {
  const root = document.querySelector(selector);
  if (!root) return null;
  const r0 = root.getBoundingClientRect();
  const props = ['marginLeft', 'marginTop', 'paddingLeft', 'paddingTop', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textTransform', 'textIndent', 'float', 'boxShadow', 'textShadow', 'borderRadius', 'borderTopWidth', 'backgroundColor', 'color', 'minWidth', 'minHeight', 'textAlign', 'opacity', 'transform', 'boxSizing'];
  return [root, ...root.querySelectorAll('*')].filter((el) => el.getClientRects().length).map((el) => {
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      id: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${String(el.className.baseVal ?? el.className).split(' ')[0]}`,
      x: Math.round(b.x - r0.x), y: Math.round(b.y - r0.y), w: Math.round(b.width), h: Math.round(b.height),
      s: Object.fromEntries(props.map((p) => [p, cs[p]])),
    };
  });
};
const differences = (base, other) => {
  if (!base || !other) return [`${base ? 'hostile' : 'clean'} page: not on screen`];
  const out = [];
  if (base.length !== other.length) out.push(`${base.length} elements on clean, ${other.length} here`);
  base.forEach((a, i) => {
    const b = other[i];
    if (!b) return;
    for (const k of ['x', 'y', 'w', 'h']) if (Math.abs(a[k] - b[k]) > 1) out.push(`${a.id} ${k} ${a[k]} -> ${b[k]}`);
    for (const k of Object.keys(a.s)) if (a.s[k] !== b.s[k]) out.push(`${a.id} ${k} ${a.s[k]} -> ${b.s[k]}`);
  });
  return out;
};

const browser = await puppeteer.launch({ headless: false, pipe: true, enableExtensions: [ext], protocolTimeout: 60000, args: ['--window-size=1280,1000'] });
try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
  const sw = await swTarget.worker();
  await sw.evaluate(async (base) => {
    await chrome.storage.sync.set({ srCloudService: 'custom', srCloudCustomBaseURL: base, srCloudModel_custom: 'mock-model', srEngine: 'cloud', srHoverAssist: true, srCoach: false });
    await syncHoverScripts();
  }, `http://localhost:${PORT}/v1`);

  const menu = (text, frameId = 0) => sw.evaluate(async (t, f) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await handleMenuClick({ menuItemId: 'sr:grammar', selectionText: t, frameId: f }, tab);
  }, text, frameId);
  const open = async (url) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 900 });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    await sleep(500);
    return page;
  };

  const snaps = {};
  for (const name of Object.keys(PAGES)) {
    const s = (snaps[name] = {});
    const url = `http://localhost:${PORT}/page/${encodeURIComponent(name)}`;

    // The dialog, on page text, in each view it has.
    let page = await open(url);
    await menu('This is a paragraph of page text that is long enough to get hover actions, with teh mistake in it for the proofread.');
    await sleep(700);
    s.dialog = await page.evaluate(snapshot, '#smart-rewrite-modal .sr-modal-container');
    if (process.env.SHOTS) { fs.mkdirSync(process.env.SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.SHOTS, `${name.replace(/\W+/g, '-')}.png`) }); }
    await page.evaluate(() => document.querySelector('.sr-seg-btn[data-view="original"]').click());
    await sleep(150);
    s.dialogOriginal = await page.evaluate(snapshot, '#smart-rewrite-modal .sr-modal-container');
    await page.close();

    // The note next to a text box, after an in-place fix.
    page = await open(url);
    await page.evaluate(() => { const t = document.getElementById('box'); t.focus(); t.select(); });
    await menu('teh box text is here for the note');
    await sleep(700);
    s.note = await page.evaluate(snapshot, '#sr-toast');
    await page.close();

    // The hover icon, then its menu.
    page = await open(url);
    const box = await (await page.$('#para')).boundingBox();
    await page.mouse.move(box.x + 30, box.y + 8);
    await sleep(100);
    await page.mouse.move(box.x + 60, box.y + 10);
    await sleep(500);
    s.hoverIcon = await page.evaluate(snapshot, '.sr-hover-icon');
    await page.evaluate(() => document.querySelector('.sr-hover-icon')?.click());
    await sleep(400);
    s.hoverMenu = await page.evaluate(snapshot, '.sr-hover-popover');
    await page.close();
  }

  // SNAP_OUT saves the clean page's measurements; BASELINE compares against a saved
  // set, to show a CSS change didn't move anything on a normal site.
  if (process.env.SNAP_OUT) fs.writeFileSync(process.env.SNAP_OUT, JSON.stringify(snaps.clean));
  if (process.env.BASELINE) {
    const base = JSON.parse(fs.readFileSync(process.env.BASELINE, 'utf8'));
    for (const part of Object.keys(base)) {
      const d = differences(base[part], snaps.clean[part]);
      check(`${part} on a clean page is unchanged from the baseline`, d.length === 0, `${d.length} differences: ${d.slice(0, 8).join('; ')}`);
    }
  }
  for (const name of Object.keys(PAGES).filter((n) => n !== 'clean')) {
    for (const part of Object.keys(snaps.clean)) {
      const d = differences(snaps.clean[part], snaps[name][part]);
      check(`${part} on "${name}" matches the clean page`, d.length === 0, `${d.length} differences: ${d.slice(0, 5).join('; ')}`);
    }
  }
  for (const part of Object.keys(snaps.clean)) check(`${part} was measured on the clean page`, snaps.clean[part] && snaps.clean[part].length > 0);

  // The tone grid itself: four equal columns, every chip inside the dialog.
  for (const name of Object.keys(PAGES)) {
    const chips = (snaps[name].dialog || []).filter((e) => e.id.includes('.sr-chip') && e.id.startsWith('button'));
    const dialogW = (snaps[name].dialog || [{}])[0].w;
    const lefts = [...new Set(chips.map((c) => c.x))];
    check(`tone grid on "${name}": 12 chips, 4 columns, none past the edge`, chips.length === 12 && lefts.length === 4 && chips.every((c) => c.x + c.w <= dialogW), `${chips.length} chips, lefts ${lefts}`);
  }

  if (process.env.REAL_URL) {
    const page = await open(process.env.REAL_URL);
    await sleep(1500);
    await menu('Information about command-line tools and client libraries is here, with teh mistake.');
    await sleep(900);
    const real = await page.evaluate(snapshot, '#smart-rewrite-modal .sr-modal-container');
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'real-site.png') });
    const chips = (real || []).filter((e) => e.id.includes('.sr-chip') && e.id.startsWith('button'));
    const lefts = [...new Set(chips.map((c) => c.x))];
    check(`real site ${process.env.REAL_URL}: 4 aligned columns`, chips.length === 12 && lefts.length === 4, `${chips.length} chips, lefts ${lefts}`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
  fs.rmSync(ext, { recursive: true, force: true });
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  :: ${r.detail}`}`);
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
