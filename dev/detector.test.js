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

// speech: 250 ms windows, a second of talk and half a second of pause below the threshold, over and over
const speech = (t) => (t % 1500 < 1000 ? -25 : -70);

test('speech with pauses shorter than the release time is audio: no alarm while the programme goes on', () => {
  const d = createDetector({ thresholdDb: -50, minSilenceMs: 30_000, releaseMs: 2_000 });
  const ev = run(d, speech, 0, 120_000, 250);
  assert.deepEqual(ev, []);
});

test('speech with a yellow delay of 2 s: the traffic light never leaves green', () => {
  const d = createDetector({ thresholdDb: -50, minSilenceMs: 30_000, releaseMs: 2_000, yellowDelayMs: 2_000 });
  let yellow = 0;
  for (let t = 0; t < 120_000; t += 250) {
    d.feed(speech(t), T0 + t);
    if (d.snapshot(T0 + t).yellow) yellow++;
  }
  assert.equal(yellow, 0);
});

test('an alarm that is open ends when speech comes back, even with pauses between the words', () => {
  const d = createDetector(cfg);
  run(d, -20, 0, 1000);
  run(d, -80, 1000, 20_000);
  const ev = run(d, speech, 20_000, 30_000, 250);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'recovered');
  assert.equal(ev[0].start, T0 + 1000);
});

test('a rare short noise is still not audio: the countdown goes on', () => {
  const d = createDetector({ ...cfg, minSilenceMs: 30_000 });
  const ev = run(d, (t) => (t % 3000 < 250 ? -20 : -80), 0, 40_000, 250); // 250 ms of noise every 3 s
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'alarm');
});

test('yellowDelayMs: the traffic light stays green until the silence has lasted that long; the alarm is unchanged', () => {
  const d = createDetector({ ...cfg, yellowDelayMs: 2_000 });
  run(d, -20, 0, 1000);
  run(d, -80, 1000, 2800);
  assert.equal(d.snapshot(T0 + 2800).status, 'counting');
  assert.equal(d.snapshot(T0 + 2800).yellow, false);
  run(d, -80, 2800, 3200);
  assert.equal(d.snapshot(T0 + 3200).yellow, true);
  const ev = run(d, -80, 3200, 20_000);
  assert.equal(ev[0].type, 'alarm');
  assert.equal(ev[0].at, T0 + 11_000);
});

test('yellowDelayMs 0 (the default of the detector) is yellow at once; a delay longer than the alarm time is capped', () => {
  const d = createDetector(cfg);
  run(d, -20, 0, 1000);
  run(d, -80, 1000, 1400);
  assert.equal(d.snapshot(T0 + 1200).yellow, true);
  const e = createDetector({ ...cfg, yellowDelayMs: 60_000 });
  run(e, -20, 0, 1000);
  run(e, -80, 1000, 11_400);
  assert.equal(e.snapshot(T0 + 11_200).status, 'alarm');
  assert.equal(e.snapshot(T0 + 11_200).yellow, true);
});

test('blips are still reported for a drop shorter than the yellow delay', () => {
  const d = createDetector({ ...cfg, yellowDelayMs: 2_000, blips: true });
  run(d, -20, 0, 1000);
  run(d, -80, 1000, 1600);
  const ev = run(d, -20, 1600, 5000);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'blip');
});

test('yellowDelayMs: an input that delivers no data is yellow at once (it is not the pause of a speaker)', () => {
  const d = createDetector({ ...cfg, yellowDelayMs: 2_000 });
  run(d, -20, 0, 1000);
  d.feed(null, T0 + 1000, 'nodata');
  assert.equal(d.snapshot(T0 + 1000).yellow, true);
});
