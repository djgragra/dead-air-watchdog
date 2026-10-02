import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetector } from '../src/core/detector.js';

const T0 = 1_000_000;
// feeds `level` every 200 ms from `from` to `to` (exclusive) and returns all events
function run(det, level, from, to, step = 200) {
  const out = [];
  for (let t = from; t < to; t += step) out.push(...det.feed(typeof level === 'function' ? level(t) : level, T0 + t));
  return out;
}

const cfg = { thresholdDb: -50, minSilenceMs: 10_000, releaseMs: 2_000 };

test('loud audio stays ok, no events', () => {
  const d = createDetector(cfg);
  assert.deepEqual(run(d, -20, 0, 30_000), []);
  assert.equal(d.snapshot(T0 + 30_000).status, 'ok');
});

test('silence shorter than the minimum: counting, then back to ok without events', () => {
  const d = createDetector(cfg);
  run(d, -20, 0, 1000);
  assert.deepEqual(run(d, -80, 1000, 6000), []);
  assert.equal(d.snapshot(T0 + 5800).status, 'counting');
  assert.deepEqual(run(d, -20, 6000, 12000), []);
  assert.equal(d.snapshot(T0 + 11800).status, 'ok');
});

test('alarm fires when silence lasts the minimum; start is the first below-threshold sample', () => {
  const d = createDetector(cfg);
  run(d, -20, 0, 1000);
  const ev = run(d, -80, 1000, 20_000);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'alarm');
  assert.equal(ev[0].start, T0 + 1000);
  assert.equal(ev[0].at, T0 + 11_000);
  assert.equal(ev[0].cause, 'silence');
});

test('recovery needs releaseMs above the threshold; duration runs from start to the first good sample', () => {
  const d = createDetector(cfg);
  run(d, -20, 0, 1000);
  run(d, -80, 1000, 20_000);
  assert.deepEqual(run(d, -20, 20_000, 21_800), []); // 1.8 s: not yet
  const ev = run(d, -20, 21_800, 24_000);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'recovered');
  assert.equal(ev[0].start, T0 + 1000);
  assert.equal(ev[0].end, T0 + 20_000);
  assert.equal(ev[0].durationMs, 19_000);
});

test('a short blip above the threshold does not restart the countdown', () => {
  const d = createDetector(cfg);
  run(d, -20, 0, 1000);
  // silent, with a 600 ms blip at 5 s (shorter than releaseMs)
  const ev = run(d, (t) => (t >= 5000 && t < 5600 ? -20 : -80), 1000, 20_000);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].start, T0 + 1000);
});

test('a long blip (>= releaseMs) cancels the countdown', () => {
  const d = createDetector(cfg);
  run(d, -20, 0, 1000);
  const ev = run(d, (t) => (t >= 5000 && t < 7500 ? -20 : -80), 1000, 16_000);
  assert.equal(ev.length, 0); // second countdown started at 7.5 s, not due yet at 16 s
  assert.equal(d.snapshot(T0 + 15_800).status, 'counting');
  assert.equal(d.snapshot(T0 + 15_800).silenceStart, T0 + 7600);
});

test('null level (input delivers nothing) is dead air with cause "offline"', () => {
  const d = createDetector(cfg);
  run(d, -20, 0, 1000);
  const ev = run(d, null, 1000, 20_000);
  assert.equal(ev[0].cause, 'offline');
});

test('level exactly at the threshold is audio', () => {
  const d = createDetector(cfg);
  assert.deepEqual(run(d, -50, 0, 30_000), []);
});

test('snapshot reports remaining time while counting', () => {
  const d = createDetector(cfg);
  run(d, -20, 0, 1000);
  run(d, -80, 1000, 4000);
  const s = d.snapshot(T0 + 3800);
  assert.equal(s.status, 'counting');
  assert.equal(s.elapsedMs, 2800);
  assert.equal(s.remainingMs, 7200);
});

test('configure changes the threshold on the fly', () => {
  const d = createDetector(cfg);
  run(d, -45, 0, 5000);
  assert.equal(d.snapshot(T0 + 4800).status, 'ok');
  d.configure({ thresholdDb: -40 });
  run(d, -45, 5000, 6000);
  assert.equal(d.snapshot(T0 + 5800).status, 'counting');
});

test('abort closes an open alarm as interrupted and clears the state', () => {
  const d = createDetector(cfg);
  run(d, -20, 0, 1000);
  run(d, -80, 1000, 20_000);
  const open = d.abort(T0 + 25_000);
  assert.equal(open.type, 'aborted');
  assert.equal(open.start, T0 + 1000);
  assert.equal(open.durationMs, 24_000);
  assert.equal(d.snapshot(T0 + 25_000).status, 'idle');
  assert.equal(d.abort(T0 + 26_000), null);
});

test('after recovery a new silence is a new episode', () => {
  const d = createDetector(cfg);
  run(d, -80, 0, 12_000);
  run(d, -20, 12_000, 15_000);
  const ev = run(d, -80, 15_000, 30_000);
  assert.equal(ev.filter((e) => e.type === 'alarm').length, 1);
  assert.equal(ev[0].start, T0 + 15_000);
});

test('minSilenceMs 0 alarms on the first silent sample', () => {
  const d = createDetector({ ...cfg, minSilenceMs: 0 });
  const ev = d.feed(-90, T0);
  assert.equal(ev[0]?.type, 'alarm');
});
