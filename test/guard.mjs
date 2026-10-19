// Node-only checks for the Proofread change guard (what blocks an in-place replace):
//   node test/guard.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';

globalThis.self = globalThis;
new Function(fs.readFileSync(process.env.CONSTANTS || new URL('../constants.js', import.meta.url), 'utf8'))();
assert.equal(typeof SR_changeGuard, 'function', 'SR_changeGuard is exported');

// True negatives: ordinary proofreads must replace in place.
const fine = [
  ['teh report are ready , i will send it tomorow.', 'The report is ready, I will send it tomorrow.'],
  ['Hi Maria, i dont think we can make it on friday at 3pm.', "Hi Maria, I don't think we can make it on Friday at 3pm."],
  ['The invoice for $1,250 is due on March 3rd, maybe sooner.', 'The invoice for $1,250 is due on March 3rd, maybe sooner.'],
  ['Thanks for you help yesterday, it realy made a diffrence for the team.', 'Thanks for your help yesterday; it really made a difference for the team.'],
  ['We might need to move the call to next week, I think.', 'We might need to move the call to next week, I think.'],
  ['Please let Jennife know that the meeting is at noon.', 'Please let Jennifer know that the meeting is at noon.'],
  ['thx c u', 'Thanks, see you.'], // short: share rule exempt
  ['', ''],
];
for (const [a, b] of fine) {
  const g = SR_changeGuard(a, b);
  assert.ok(g.ok, `should pass: ${JSON.stringify(b)} (${g.reasons.join('; ')})`);
  assert.deepEqual(g.reasons, []);
}

// True positives: meaning changes a proofread must not slip in.
const flag = (a, b, re) => {
  const g = SR_changeGuard(a, b);
  assert.ok(!g.ok, `should flag: ${JSON.stringify(b)}`);
  assert.ok(g.reasons.some((r) => re.test(r)), `${JSON.stringify(b)}: wanted ${re}, got ${g.reasons.join('; ')}`);
};
flag('I will not be able to attend the meeting on Monday.', 'I will be able to attend the meeting on Monday.', /not/);
flag("We can't ship this until the tests pass.", 'We can ship this once the tests pass.', /not/);
flag('Send it to the client.', 'Never send it to the client.', /not/);
flag('The total is $4,500 and it is due on the 12th.', 'The total is due soon.', /number 4/);
flag('Call me at 555 0199 tomorrow.', 'Call me tomorrow.', /number 555/);
flag('Please forward this to Priya and the finance team.', 'Please forward this to the finance team.', /name Priya/);
flag('Maybe we should push the launch to next month.', 'We should push the launch to next month.', /maybe/);
flag('I think the second option is cheaper for us.', 'The second option is cheaper for us.', /i think/);
flag('The draft is mostly done but needs a final read before we send it.',
  'Our proposal, now complete, is ready to go out to everyone immediately today.', /changed \d+% of the words/);
// Too long to diff: never replace silently.
const big = Array.from({ length: 2000 }, (_, k) => `w${k}`).join(' ');
flag(big, big.replace(/w/g, 'v'), /too long/);

console.log('guard: all checks passed');
