// Independent cross-check against ffmpeg (skipped when ffmpeg is not installed):
//  1. RMS level of synthetic signals: ffmpeg astats vs. renderer/level-worklet.js (the real file).
//  2. Silence timing: ffmpeg silencedetect vs. the detector fed with the worklet's 100 ms reports.
// Run: node --test dev/ffmpeg-validation.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { makeWav, SAMPLE_RATE } from './test-stream-server.js';
import { createDetector } from '../src/core/detector.js';

const have = spawnSync('ffmpeg', ['-version']).status === 0;
const opts = { skip: have ? false : 'ffmpeg not installed' };
const code = fs.readFileSync(new URL('../renderer/level-worklet.js', import.meta.url), 'utf8');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daw-ff-'));

// Runs the worklet over a 16-bit stereo WAV buffer, returns its 100 ms reports.
function worklet(wav) {
  let P;
  const reports = [];
  class AudioWorkletProcessor { constructor() { this.port = { postMessage: (m) => reports.push({ rms: Array.from(m.rms) }) }; } }
  vm.runInNewContext(code, { AudioWorkletProcessor, sampleRate: SAMPLE_RATE, registerProcessor: (_n, c) => (P = c), Math, Float64Array });
  const proc = new P();
  const frames = (wav.length - 44) / 4;
  for (let i = 0; i + 128 <= frames; i += 128) {
    const L = new Float32Array(128), R = new Float32Array(128);
    for (let k = 0; k < 128; k++) { L[k] = wav.readInt16LE(44 + (i + k) * 4) / 32768; R[k] = wav.readInt16LE(44 + (i + k) * 4 + 2) / 32768; }
    proc.process([[L, R]]);
  }
  return reports;
}

function ffmpegRms(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'astats=metadata=0', '-f', 'null', '-'], { encoding: 'utf8' });
  const overall = r.stderr.split('Overall')[1] || '';
  return Number(/RMS level dB:\s*(-?[\d.]+|-inf)/.exec(overall)[1]);
}

for (const peakDb of [-6, -20, -40, -60]) {
  test(`RMS of a 1 kHz sine at ${peakDb} dBFS peak: worklet vs ffmpeg astats`, opts, () => {
    const wav = makeWav([{ seconds: 3, peakDb }]);
    const file = path.join(dir, `s${-peakDb}.wav`);
    fs.writeFileSync(file, wav);
    const ref = ffmpegRms(file);
    const reports = worklet(wav);
    const ours = 10 * Math.log10(reports.reduce((s, r) => s + 10 ** (r.rms[0] / 10), 0) / reports.length);
    assert.ok(Math.abs(ours - ref) < 0.1, `worklet ${ours.toFixed(2)} vs ffmpeg ${ref}`);
    assert.ok(Math.abs(ours - (peakDb - 3.0103)) < 0.1, `theory ${peakDb - 3.0103}`);
  });
}

test('silence timing: tone 8 s / digital silence 10 s / tone 8 s — detector vs ffmpeg silencedetect', opts, () => {
  const wav = makeWav([{ seconds: 8, peakDb: -20 }, { seconds: 10, peakDb: null }, { seconds: 8, peakDb: -20 }]);
  const file = path.join(dir, 'gap.wav');
  fs.writeFileSync(file, wav);
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'silencedetect=noise=-50dB:d=3', '-f', 'null', '-'], { encoding: 'utf8' });
  const start = Number(/silence_start: ([\d.]+)/.exec(r.stderr)[1]);
  const dur = Number(/silence_duration: ([\d.]+)/.exec(r.stderr)[1]);

  const det = createDetector({ thresholdDb: -50, minSilenceMs: 3000, releaseMs: 2000 });
  const events = [];
  det.feed(-20, 0);
  const reports = worklet(wav);
  reports.forEach((rep, i) => events.push(...det.feed(Math.max(...rep.rms), (i + 1) * 100)));
  const alarm = events.find((e) => e.type === 'alarm');
  const rec = events.find((e) => e.type === 'recovered');
  assert.ok(alarm && rec, JSON.stringify(events));
  assert.ok(Math.abs(alarm.start / 1000 - start) < 0.2, `start ${alarm.start / 1000} vs ${start}`);
  assert.ok(Math.abs(rec.durationMs / 1000 - dur) < 0.25, `duration ${rec.durationMs / 1000} vs ${dur}`);
});
