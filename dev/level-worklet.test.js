// Runs renderer/level-worklet.js (the real file) in a stub of the AudioWorklet scope and checks
// the levels it reports against signals with known values.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SAMPLE_RATE = 48000;
const code = fs.readFileSync(new URL('../renderer/level-worklet.js', import.meta.url), 'utf8');

function load() {
  let Processor;
  const reports = [];
  class AudioWorkletProcessor {
    constructor() {
      this.port = { postMessage: (m) => reports.push(m) };
    }
  }
  vm.runInNewContext(code, { AudioWorkletProcessor, sampleRate: SAMPLE_RATE, registerProcessor: (_n, c) => (Processor = c), Math, Float64Array });
  return { proc: new Processor(), reports };
}

function feed(proc, seconds, gen, channels = 2) {
  const frames = Math.round(SAMPLE_RATE * seconds);
  for (let i = 0; i < frames; i += 128) {
    const input = Array.from({ length: channels }, (_, c) => Float32Array.from({ length: 128 }, (_, k) => gen(c, i + k)));
    proc.process([input]);
  }
}

const sine = (amp, hz = 1000) => (_c, n) => amp * Math.sin((2 * Math.PI * hz * n) / SAMPLE_RATE);

test('1 kHz sine at -20 dBFS peak reads -23.01 dBFS RMS (peak -20)', () => {
  const { proc, reports } = load();
  feed(proc, 1, sine(0.1));
  assert.ok(reports.length >= 9 && reports.length <= 10);
  for (const r of reports) {
    assert.ok(Math.abs(r.rms[0] - -23.01) < 0.05, `rms ${r.rms[0]}`);
    assert.ok(Math.abs(r.peak[0] - -20) < 0.05, `peak ${r.peak[0]}`);
  }
});

test('full-scale sine reads -3.01 dBFS RMS, full-scale square 0 dBFS', () => {
  let t = load();
  feed(t.proc, 0.5, sine(1));
  assert.ok(Math.abs(t.reports.at(-1).rms[0] - -3.01) < 0.05);
  t = load();
  feed(t.proc, 0.5, (_c, n) => (n % 48 < 24 ? 1 : -1));
  assert.ok(Math.abs(t.reports.at(-1).rms[0] - 0) < 0.01);
});

test('channels are measured independently', () => {
  const { proc, reports } = load();
  feed(proc, 0.5, (c, n) => (c === 0 ? 0.5 : 0.05) * Math.sin((2 * Math.PI * 1000 * n) / SAMPLE_RATE));
  const r = reports.at(-1);
  assert.ok(Math.abs(r.rms[0] - -9.03) < 0.05);
  assert.ok(Math.abs(r.rms[1] - -29.03) < 0.05);
});

test('digital silence and missing input read -120 dBFS', () => {
  let t = load();
  feed(t.proc, 0.5, () => 0);
  assert.deepEqual(Array.from(t.reports.at(-1).rms), [-120, -120]);
  t = load();
  for (let i = 0; i < 400; i++) t.proc.process([[]]);
  assert.ok(t.reports.length >= 1);
  assert.deepEqual(Array.from(t.reports.at(-1).rms), [-120, -120]);
});

test('block rate is 10 reports per second', () => {
  const { proc, reports } = load();
  feed(proc, 3, sine(0.1));
  assert.ok(reports.length >= 29 && reports.length <= 30, String(reports.length));
});
