// The background stays alive (and its on-device sessions warm) after an
// on-device proofread, and only then:
//   PUPPETEER=/path/to/puppeteer.js node test/e2e-warm.mjs
// Chrome stops an idle extension background after ~30s, unless a debugger is
// attached, so the test detaches while it waits. Marker: a stand-in
// LanguageModel planted in the background; if the background restarted, the
// marker is gone. Control first: no on-device use → it must be gone.
const { default: puppeteer } = await import(process.env.PUPPETEER || 'puppeteer');
import path from 'node:path';

const ext = path.resolve(process.argv[2] || '.');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

const browser = await puppeteer.launch({ headless: false, pipe: true, enableExtensions: [ext], protocolTimeout: 120000 });
const swTarget = () => browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 60000 });
const extId = new URL((await swTarget()).url()).host;
// A stopped background has no target; a message from an extension page wakes it, as real use does.
const page = await browser.newPage();
await page.goto(`chrome-extension://${extId}/welcome.html`);
const wake = () => page.evaluate(() => chrome.runtime.sendMessage({ action: 'hasCloudKey' }).catch(() => null));

// A fresh debugger session per step, detached right after (puppeteer's
// worker handle goes stale once detached).
async function inBackground(expression) {
  const cdp = await (await swTarget()).createCDPSession();
  try {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  } finally { await cdp.detach().catch(() => {}); }
}
async function plant(withDeviceUse) {
  await inBackground(`(async () => {
    const session = () => ({ async prompt() { return 'The report is ready.'; }, async clone() { return session(); }, destroy() {} });
    self.LanguageModel = { __marker: true, async availability() { return 'available'; }, async create() { return session(); } };
    if (${withDeviceUse}) {
      const status = await aiStatus();
      status.settings = { ...status.settings, engine: 'device' };
      await rewriteNow('teh report is ready', 'grammar', status, 'en');
    }
    return true;
  })()`);
}
async function markerAfter(ms) {
  await sleep(ms);
  await wake();
  return inBackground('!!(self.LanguageModel && self.LanguageModel.__marker)');
}

// Control: no on-device use, so nothing keeps it alive.
await plant(false);
const control = await markerAfter(45000);
check('control: an idle background is stopped after ~30s', control === false, `marker ${control ? 'survived' : 'gone'}`);

// After an on-device proofread, it stays alive and warm.
await plant(true);
const warm = await markerAfter(45000);
check('after an on-device proofread, the background stays warm past 30s', warm === true, `marker ${warm ? 'survived' : 'gone'}`);

await browser.close();
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  :: ' + r.detail : ''}`);
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
