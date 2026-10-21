// The rating ask: when it shows and what each choice stores.
//   node test/rating.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';

globalThis.self = globalThis;
new Function(fs.readFileSync(process.env.CONSTANTS || new URL('../constants.js', import.meta.url), 'utf8'))();

const at = (n) => ({ totalRewrites: n });
// Not before real use; the same count on every surface.
assert.equal(SR_rateDue(at(9), undefined), false);
assert.equal(SR_rateDue(at(10), undefined), true);
assert.equal(SR_rateDue(null, undefined), false);
// "Rate it" ends it for good (Chrome can't tell us someone rated, so the click counts).
assert.equal(SR_rateAfter('rate', at(10), undefined), true);
assert.equal(SR_rateDue(at(500), true), false);
// "Not now" asks once more, 30 rewrites later, and says so honestly the second time.
const later = SR_rateAfter('later', at(12), undefined);
assert.deepEqual(later, { again: 42 });
assert.equal(SR_rateDue(at(41), later), false);
assert.equal(SR_rateDue(at(42), later), true);
assert.equal(SR_rateDecline(undefined), 'Not now');
assert.equal(SR_rateDecline(later), 'No thanks');
// The second ask is the last, whichever button.
assert.equal(SR_rateAfter('later', at(42), later), true);
assert.equal(SR_rateAfter('rate', at(42), later), true);
// Stored junk never shows it in a loop.
assert.equal(SR_rateDue(at(100), { again: 'x' }), false);

console.log('rating: all checks passed');
