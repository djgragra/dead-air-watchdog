import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrozenDetector } from '../src/core/frozen.js';

const T0 = 1_000_000_000;
function run(d, level, from, to, step = 250, thr = -50) {
  const out = [];
  for (let t = from; t < to; t += step) out.push(...d.feed(typeof level === 'function' ? level(t) : level, T0 + t, thr));
  return out;
}
const cfg = { frozenMs: 20_000, toleranceDb: 1 };
// something like a programme: the level moves by several dB all the time
const programme = (t) => -25 + 6 * Math.sin(t / 700) + 3 * Math.sin(t / 130);

test('frozen: a programme that moves never fires', () => {
  const d = createFrozenDetector(cfg);
  assert.deepEqual(run(d, programme, 0, 120_000), []);
});

test('frozen: a steady level for the whole time fires once; the start is where it began', () => {
  const d = createFrozenDetector(cfg);
  run(d, programme, 0, 10_000);
  const ev = run(d, -20, 10_000, 60_000);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'alarm');
  // the tone started at 10 s; it is judged at 30 s, the start reported is the start of the frozen window
  assert.ok(ev[0].at >= T0 + 30_000 - 1000 && ev[0].at <= T0 + 31_000, `fired at ${ev[0].at - T0}`);
  assert.ok(ev[0].start >= T0 + 10_000 - 1000 && ev[0].start <= T0 + 11_000);
  assert.equal(d.snapshot(T0 + 60_000).alarm, true);
});

test('frozen: small variations inside the tolerance are still frozen; larger ones are not', () => {
  const small = createFrozenDetector(cfg);
  assert.equal(run(small, (t) => -20 + 0.3 * Math.sin(t / 50), 0, 30_000).length, 1);
  const big = createFrozenDetector(cfg);
  assert.deepEqual(run(big, (t) => -20 + 3 * Math.sin(t / 1000), 0, 60_000), []);
});

test('frozen: the level moving again ends the alarm with "recovered"', () => {
  const d = createFrozenDetector(cfg);
  run(d, -20, 0, 30_000);
  const ev = run(d, programme, 30_000, 40_000);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'recovered');
  assert.equal(d.snapshot(T0 + 40_000).alarm, false);
  assert.deepEqual(run(d, programme, 40_000, 100_000), [], 'and it does not fire again on a programme');
});

test('frozen: silence or no data restart the search and end an open alarm with "ended" (not "recovered")', () => {
  const d = createFrozenDetector(cfg);
  run(d, -20, 0, 25_000);
  const ev = run(d, -80, 25_000, 25_500);
  assert.equal(ev[0].type, 'ended');
  assert.equal(d.snapshot(T0 + 26_000).alarm, false);
  // a steady level must last the whole time again
  assert.deepEqual(run(d, -20, 26_000, 40_000), []);
  const d2 = createFrozenDetector(cfg);
  run(d2, -20, 0, 15_000);
  d2.feed(null, T0 + 15_250, -50);
  assert.deepEqual(run(d2, -20, 15_500, 30_000), [], 'no data in the middle: the 20 s start again');
});

test('frozen: a hole in the samples longer than two seconds restarts the search', () => {
  const d = createFrozenDetector(cfg);
  run(d, -20, 0, 15_000);
  assert.deepEqual(run(d, -20, 18_000, 30_000), []);
});
