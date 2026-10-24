// The right-click menu is rebuilt on install and on every Chrome start. When
// the two overlap (an update applied at startup, a reload while developing),
// each build must still leave one copy of every item, with no "duplicate id"
// errors. Runs the menu section of background.js against a fake
// chrome.contextMenus that rejects a duplicate id the way Chrome does.
//   node test/context-menu.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';

globalThis.self = globalThis;
new Function(fs.readFileSync(new URL('../constants.js', import.meta.url), 'utf8'))();

const src = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const section = src.slice(src.indexOf('const MENU_TOP'), src.indexOf('chrome.runtime.onInstalled'));
assert.ok(section.includes('buildContextMenus'), 'found the menu section of background.js');

const items = new Map();
const errors = [];
const tick = () => new Promise((r) => setTimeout(r, 1));
const chrome = {
  runtime: { lastError: undefined },
  commands: { getAll: async () => { await tick(); return [{ name: 'proofread-selection', shortcut: 'Alt+Shift+P' }]; } },
  contextMenus: {
    // Chrome runs calls in the order they're made; the promise settles later.
    removeAll: async () => { items.clear(); await tick(); },
    create(props, cb) {
      // Chrome reports a duplicate through runtime.lastError, after the call.
      const dup = items.has(props.id);
      if (!dup) items.set(props.id, props);
      setTimeout(() => {
        if (dup) chrome.runtime.lastError = { message: `Cannot create item with duplicate id ${props.id}` };
        if (cb) cb(); else if (dup) errors.push(`Unchecked runtime.lastError: ${chrome.runtime.lastError.message}`);
        chrome.runtime.lastError = undefined;
      }, 0);
      return props.id;
    },
  },
};
const warnings = [];
const console = { ...globalThis.console, warn: (...a) => warnings.push(a.join(' ')) };
const build = new Function('chrome', 'console', `${section}; return buildContextMenus;`)(chrome, console);

await build();
await tick();
const expected = items.size;
assert.ok(expected > 10, `one build creates the menu (${expected} items)`);

// install + startup at once, and a third for good measure
items.clear();
await Promise.all([build(), build(), build()]);
await tick(); await tick();
assert.deepEqual(errors, [], 'no duplicate-id errors when builds overlap');
assert.deepEqual(warnings, [], 'nothing warned');
assert.equal(items.size, expected, 'each item exists once');

console.log('context-menu: ok');
