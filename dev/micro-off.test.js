// 26.10.11: micro-silences can be switched off, for all inputs (General) or for one input.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, sanitizeSettings, microSilencesOn, DEFAULT_SETTINGS } from '../src/store.js';
import { createMonitor, TICK_MS } from '../src/monitor.js';

const mkInput = (id, name, extra = {}) => ({ id, name, type: 'stream', streamUrl: `http://${id}.example.org/live`, thresholdDb: -50, minSilenceSec: 10, ...extra });

function setup(settings) {
  const clock = { t: 1_800_000_000_000 };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daw-m-'));
  const store = createStore({ file: path.join(dir, 'd.json'), now: () => clock.t });
  store.updateSettings(settings);
  const m = createMonitor({
    store,
    engine: { sync: () => {}, stop: () => {} },
    dispatch: () => {},
    alarmSound: () => {},
    publish: { status: () => {}, events: () => {}, levels: () => {} },
    now: () => clock.t,
    host: 'test-host',
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
    setTimeoutFn: () => ({}),
    clearTimeoutFn: () => {}
  });
  const advance = (ms, level) => {
    for (let n = 0; n < ms / TICK_MS; n++) {
      clock.t += TICK_MS;
      for (let k = 0; k < 2; k++) {
        const batch = {};
        for (const i of store.getSettings().inputs) batch[i.id] = { rms: [level, level - 3], peak: [level, level] };
        m.onLevels(batch);
      }
      m.tick();
    }
  };
  // 2 s of drop between loud audio: one micro-silence per input that logs them
  const drop = () => {
    advance(3000, -20);
    advance(2000, -80);
    advance(3000, -20);
  };
  const blips = (id) => store.listEvents().filter((e) => e.kind === 'blip' && (!id || e.inputId === id));
  return { store, m, drop, blips, advance };
}

test('settings: micro-silences are on by default, in General and for every input', () => {
  const s = sanitizeSettings({ inputs: [mkInput('a', 'Main')] });
  assert.equal(s.general.microSilences, true);
  assert.equal(s.inputs[0].microSilences, 'default');
  assert.equal(microSilencesOn(s, s.inputs[0]), true);
});

test('settings: the choice of an input wins over General; wrong values go back to the default', () => {
  const s = sanitizeSettings({ general: { microSilences: false }, inputs: [mkInput('a', 'A'), mkInput('b', 'B', { microSilences: 'on' }), mkInput('c', 'C', { microSilences: 'maybe' })] });
  assert.equal(s.general.microSilences, false);
  assert.deepEqual(s.inputs.map((i) => i.microSilences), ['default', 'on', 'default']);
  assert.deepEqual(s.inputs.map((i) => microSilencesOn(s, i)), [false, true, false]);
  const t = sanitizeSettings({ inputs: [mkInput('a', 'A', { microSilences: 'off' }), mkInput('b', 'B')] });
  assert.deepEqual(t.inputs.map((i) => microSilencesOn(t, i)), [false, true]);
  assert.equal(DEFAULT_SETTINGS.general.microSilences, true);
});

test('monitor: on by default, a drop is logged as before', () => {
  const { m, drop, blips } = setup({ inputs: [mkInput('a', 'Main')] });
  m.start();
  drop();
  assert.equal(blips().length, 1);
});

test('monitor: switched off in General, nothing is written for any input', () => {
  const { m, drop, blips } = setup({ general: { microSilences: false }, inputs: [mkInput('a', 'A'), mkInput('b', 'B')] });
  m.start();
  drop();
  assert.equal(blips().length, 0);
});

test('monitor: switched off for one input only', () => {
  const { m, drop, blips } = setup({ inputs: [mkInput('a', 'A', { microSilences: 'off' }), mkInput('b', 'B')] });
  m.start();
  drop();
  assert.equal(blips('a').length, 0);
  assert.equal(blips('b').length, 1);
});

test('monitor: an input set to "on" logs them although General is off', () => {
  const { m, drop, blips } = setup({ general: { microSilences: false }, inputs: [mkInput('a', 'A', { microSilences: 'on' }), mkInput('b', 'B')] });
  m.start();
  drop();
  assert.equal(blips('a').length, 1);
  assert.equal(blips('b').length, 0);
});

test('monitor: the alarm does not change when micro-silences are off', () => {
  const { m, store, drop, blips, advance } = setup({ general: { microSilences: false }, inputs: [mkInput('a', 'A')] });
  m.start();
  drop();
  assert.notEqual(m.status().overall, 'alarm');
  advance(12_000, -80); // the red alarm after minSilenceSec (10 s), as ever
  assert.equal(m.status().overall, 'alarm');
  assert.equal(store.listEvents().filter((e) => e.kind === 'dead-air').length, 1);
  assert.equal(blips().length, 0);
});

test('monitor: switching it off while running takes effect at once; switching on again too', () => {
  const { m, store, drop, blips } = setup({ inputs: [mkInput('a', 'A')] });
  m.start();
  drop();
  assert.equal(blips().length, 1);
  store.updateSettings({ general: { microSilences: false } });
  m.syncInputs();
  drop();
  assert.equal(blips().length, 1, 'no new one while off');
  store.updateSettings({ general: { microSilences: true } });
  m.syncInputs();
  drop();
  assert.equal(blips().length, 2);
});
