// Every HTML-escaping helper escapes quotes too, so a value placed inside an
// attribute (a model id from a provider's /models list, a model's answer)
// can't close the attribute and add its own:
//   node test/escape.mjs
// Each helper is pulled from its file and run without a DOM: one that leans
// on textContent → innerHTML (which leaves quotes alone) fails here.
import fs from 'node:fs';
import assert from 'node:assert/strict';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const nasty = `x" onmouseover="alert(1)" a='b' <img src=x> & done`;
const expected = 'x&quot; onmouseover=&quot;alert(1)&quot; a=&#39;b&#39; &lt;img src=x&gt; &amp; done';

const helpers = {
  'sidepanel.js': /function escapeHtml\(s\) \{[\s\S]*?\n\}/,
  'welcome.js': /function escapeHtml\(s\) \{[\s\S]*?\n\}/,
  'hover-assist.js': /function escapeHtml\(s\) \{[\s\S]*?\n {0,4}\}/,
  'content.js': /escapeHtml\(\w+\) \{[\s\S]*?\n {4}\}/,
};
for (const [file, re] of Object.entries(helpers)) {
  const src = read(file).match(re);
  assert.ok(src, `${file}: escapeHtml found`);
  const body = src[0].replace(/^(?:function )?escapeHtml/, 'function escapeHtml');
  let fn;
  try { fn = new Function(`${body}; return escapeHtml;`)(); } catch (e) { assert.fail(`${file}: ${e.message}`); }
  let out;
  try { out = fn(nasty); } catch (e) { assert.fail(`${file}: escapeHtml needs a DOM (${e.message}); it must escape quotes itself`); }
  assert.equal(out, expected, `${file}: quotes, angle brackets and & are all escaped`);
  assert.equal(fn(null), '', `${file}: null is empty`);
  assert.equal(fn(undefined), '', `${file}: undefined is empty`);
  assert.equal(fn(42), '42', `${file}: numbers become text`);
}

// hover-assist builds its buttons with the helper, not raw labels.
assert.match(read('hover-assist.js'), /\$\{escapeHtml\(label\)\}/, 'hover labels are escaped');
console.log('escape: all checks passed');
