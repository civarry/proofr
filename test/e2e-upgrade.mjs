// Update from the published 1.2.4 to the packaged build, in place: same
// profile and extension dir, files swapped, runtime.reload() (Chrome runs
// onInstalled with reason 'update', as for a store update).
// Checks: no leftover site access, the synced key moved to this device only,
// no welcome tab on update.
//
// usage: sh store/package.sh && PUPPETEER=<puppeteer esm entry> node test/e2e-upgrade.mjs [zip]
const { default: puppeteer } = await import(process.env.PUPPETEER || 'puppeteer');
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const version = JSON.parse(fs.readFileSync(path.join(repo, 'manifest.json'), 'utf8')).version;
const zip = path.resolve(process.argv[2] || path.join(repo, `store/proofr-${version}.zip`));
const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'proofr-upgrade-'));
execSync(`git -C "${repo}" archive 5d5a75e | tar -x -C "${ext}"`); // published 1.2.4

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const KEY = 'gsk_' + 'x'.repeat(50);

const b = await puppeteer.launch({ headless: false, pipe: true, enableExtensions: [ext], protocolTimeout: 60000 });
let swT = await b.waitForTarget(t => t.type() === 'service_worker');
let sw = await swT.worker();
await sw.evaluate((k) => chrome.storage.sync.set({ groqAPIKey: k }), KEY);
const before = await sw.evaluate(() => chrome.permissions.getAll());
check('1.2.4 starts with <all_urls>', before.origins.includes('<all_urls>'));

for (const f of fs.readdirSync(ext)) fs.rmSync(path.join(ext, f), { recursive: true, force: true });
execSync(`unzip -o -q "${zip}" -d "${ext}"`);
const oldT = swT;
sw.evaluate(() => chrome.runtime.reload()).catch(() => {});
swT = await b.waitForTarget(t => t !== oldT && t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'), { timeout: 30000 });
sw = await swT.worker();
await sleep(3000);

check('updated to packaged version', (await sw.evaluate(() => chrome.runtime.getManifest().version)) === version);
const after = await sw.evaluate(() => chrome.permissions.getAll());
check('no site access left after update (hover off)', after.origins.length === 0, JSON.stringify(after.origins));
const local = await sw.evaluate(() => chrome.storage.local.get(['groqAPIKey']));
const synced = await sw.evaluate(() => chrome.storage.sync.get(['groqAPIKey']));
check('synced key moved to local', local.groqAPIKey === KEY);
check('key removed from sync', !synced.groqAPIKey);
check('no welcome tab on update', !(await b.pages()).some(p => p.url().includes('welcome=1')));

await b.close();
fs.rmSync(ext, { recursive: true, force: true });
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  :: ' + r.detail : ''}`);
process.exit(results.every(r => r.ok) ? 0 : 1);
