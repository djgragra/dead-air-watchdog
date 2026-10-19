import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { createMonitor, TICK_MS } from '../src/monitor.js';
import { createDispatcher } from '../src/notifications.js';
import { MESSAGES, MESSAGE_KEYS, buildAlert, inputLabel } from '../src/messages.js';

const INPUT_A = { id: 'a', name: 'Main', type: 'stream', streamUrl: 'http://user:secret@radio.example.org:8000/live', thresholdDb: -50, minSilenceSec: 10 };
const INPUT_B = { id: 'b', name: 'Backup', type: 'stream', streamUrl: 'http://backup.example.org/live', thresholdDb: -45, minSilenceSec: 20 };

function setup(settingsPatch = {}) {
  const clock = { t: 1_800_000_000_000 };
  const store = createStore({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'daw-')), 'd.json'), now: () => clock.t });
  store.updateSettings({ inputs: [INPUT_A], ...settingsPatch });
  const sent = [];
  const published = { status: [], events: 0 };
  const engineCalls = [];
  const sounds = [];
  const m = createMonitor({
    store,
    engine: { sync: (list) => engineCalls.push(['sync', list.map((i) => i.id)]), stop: () => engineCalls.push(['stop']) },
    dispatch: (msg) => sent.push(msg),
    alarmSound: (on) => sounds.push(on),
    publish: { status: (st) => published.status.push(st), events: () => published.events++, levels: () => {} },
    now: () => clock.t,
    host: 'test-host',
    setIntervalFn: () => 1,
    clearIntervalFn: () => {}
  });
  // advances the clock in ticks; `level` is the loudest channel in dBFS reported at 10 Hz for every
  // input (a number), per input ({ a: -20, b: null }), or null for no reports at all
  const advance = (ms, level) => {
    for (let n = 0; n < ms / TICK_MS; n++) {
      clock.t += TICK_MS;
      const levels = level !== null && typeof level === 'object' ? level : Object.fromEntries(store.getSettings().inputs.map((i) => [i.id, level]));
      for (let k = 0; k < 2; k++) {
        const batch = {};
        for (const [id, v] of Object.entries(levels)) if (v !== null && v !== undefined) batch[id] = { rms: [v, v - 3], peak: [v, v] };
        if (Object.keys(batch).length) m.onLevels(batch);
      }
      m.tick();
    }
  };
  return { clock, store, m, sent, published, engineCalls, sounds, advance };
}


const NOON = new Date(2026, 9, 19, 12, 0, 0).getTime(); // Monday, local
const setAt = (ctx, ts) => { ctx.clock.t = ts; };

test('yellow delay: a pause of speech (below the threshold, shorter than the delay) leaves the input green; a long one turns yellow', () => {
  const ctx = setup({ inputs: [{ ...INPUT_A, minSilenceSec: 30, yellowDelaySec: 2 }] });
  const { m, advance } = ctx;
  m.start();
  advance(5000, -20);
  advance(1500, -80);
  assert.equal(m.status().inputs[0].state, 'ok');
  advance(1000, -80);
  assert.equal(m.status().inputs[0].state, 'counting');
  assert.equal(m.status().overall, 'counting');
  advance(30_000, -80);
  assert.equal(m.status().overall, 'alarm', 'the alarm time is not changed by the delay');
});

test('yellow delay 0: yellow at the first quiet window, as before', () => {
  const { m, advance } = setup({ inputs: [{ ...INPUT_A, yellowDelaySec: 0 }] });
  m.start();
  advance(5000, -20);
  advance(500, -80);
  assert.equal(m.status().inputs[0].state, 'counting');
});

test('speech with pauses for a minute: green all the time, no alarm, nothing sent', () => {
  const { m, advance, sent, store } = setup({ inputs: [{ ...INPUT_A, minSilenceSec: 10, yellowDelaySec: 2 }] });
  m.start();
  advance(5000, -20);
  for (let i = 0; i < 40; i++) {
    advance(1000, -25);
    advance(500, -70);
    assert.equal(m.status().inputs[0].state, 'ok');
  }
  assert.equal(sent.length, 0);
  assert.equal(store.listEvents().filter((e) => e.kind === 'dead-air').length, 0);
});

test('monitoring hours, mode off: no alarm, no message, shown as paused; the alarm that was open ends without "recovered"', () => {
  const ctx = setup({ inputs: [{ ...INPUT_A, minSilenceSec: 10, schedule: { enabled: true, rules: [{ days: [1], from: '12:05', to: '13:00', mode: 'off' }] } }], notifications: { grouping: { enabled: false } } });
  const { m, advance, sent, store } = ctx;
  setAt(ctx, NOON);
  m.start();
  advance(5000, -20);
  advance(20_000, -80); // 12:00:05 - 12:00:25: alarm
  assert.equal(m.status().overall, 'alarm');
  assert.equal(sent.length, 1);
  advance(5 * 60_000, -80); // crosses 12:05
  const st = m.status();
  assert.equal(st.inputs[0].state, 'paused');
  assert.equal(st.inputs[0].scheduled, true);
  assert.equal(st.inputs[0].pausedUntil, new Date(2026, 9, 19, 13, 0).getTime());
  assert.equal(st.overall, 'paused');
  assert.equal(sent.length, 1, 'no "recovered" message and nothing new');
  const ev = store.listEvents().filter((e) => e.kind === 'dead-air');
  assert.equal(ev.length, 1);
  assert.ok(ev[0].end, 'the open alarm is closed');
  assert.equal(ev[0].scheduled, true);
  advance(10 * 60_000, -80);
  assert.equal(sent.length, 1);
  // after the window the countdown starts again from there
  advance(44 * 60_000 + 40_000, -80); // 13:00:05
  assert.equal(sent.length, 1);
  assert.equal(m.status().inputs[0].state, 'counting');
  advance(10_000, -80);
  assert.equal(m.status().overall, 'alarm');
  assert.equal(sent.length, 2);
});

test('monitoring hours, custom rule: its own time before the alarm and threshold apply in its hours, then the normal ones', () => {
  const ctx = setup({ inputs: [{ ...INPUT_A, thresholdDb: -50, minSilenceSec: 10, schedule: { enabled: true, rules: [{ days: [1], from: '12:00', to: '12:10', mode: 'custom', thresholdDb: -70, minSilenceSec: 120 }] } }] });
  const { m, advance, sent, store } = ctx;
  setAt(ctx, NOON);
  m.start();
  advance(5000, -20);
  advance(60_000, -80); // -80 is below -70 too, but 120 s are needed
  assert.equal(m.status().inputs[0].state, 'counting');
  assert.equal(m.status().inputs[0].thresholdDb, -70);
  assert.equal(sent.length, 0);
  advance(70_000, -80);
  assert.equal(m.status().overall, 'alarm');
  const rec = store.listEvents().find((e) => e.kind === 'dead-air');
  assert.equal(rec.minSilenceSec, 120);
  assert.equal(rec.thresholdDb, -70);
  assert.match(sent[0].text, /-70 dBFS, alert after 120 s/);
  // -60 dB is above -70: audio in the custom hours, silence outside them (-50)
  const ctx2 = setup({ inputs: [{ ...INPUT_A, minSilenceSec: 10, schedule: { enabled: true, rules: [{ days: [1], from: '12:00', to: '12:10', mode: 'custom', thresholdDb: -70, minSilenceSec: 10 }] } }] });
  setAt(ctx2, NOON);
  ctx2.m.start();
  ctx2.advance(60_000, -60);
  assert.equal(ctx2.m.status().inputs[0].state, 'ok');
  ctx2.advance(9 * 60_000 + 5000, -60); // 12:10:05: the normal rule again, -60 is below -50
  assert.equal(ctx2.m.status().inputs[0].state, 'counting');
});

test('monitoring hours: settings changed while running take effect and the settings editor can switch them off', () => {
  const ctx = setup({ inputs: [{ ...INPUT_A, minSilenceSec: 10 }] });
  setAt(ctx, NOON);
  ctx.m.start();
  ctx.advance(5000, -20);
  ctx.store.updateSettings({ inputs: [{ ...INPUT_A, minSilenceSec: 10, schedule: { enabled: true, rules: [{ days: [1], from: '00:00', to: '00:00', mode: 'off' }] } }] });
  ctx.m.syncInputs();
  ctx.advance(1000, -80);
  assert.equal(ctx.m.status().inputs[0].state, 'paused');
  ctx.store.updateSettings({ inputs: [{ ...INPUT_A, minSilenceSec: 10 }] });
  ctx.m.syncInputs();
  ctx.advance(1000, -80);
  assert.notEqual(ctx.m.status().inputs[0].state, 'paused');
});

test('frozen audio: a steady level above the threshold raises its own alarm, with its own message and log entry; moving again closes it', () => {
  const { m, advance, sent, store, sounds } = setup({ inputs: [{ ...INPUT_A, minSilenceSec: 30, frozenSec: 20, frozenToleranceDb: 1 }] });
  m.start();
  const moving = (ms) => { for (let i = 0; i < ms / 1000; i++) advance(1000, -25 + (i % 7) * 2); };
  moving(10_000);
  advance(30_000, -20); // steady tone
  assert.equal(m.status().overall, 'alarm');
  assert.equal(m.status().inputs[0].cause, 'frozen');
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /DEAD AIR: Main/);
  assert.match(sent[0].text, /Frozen audio/);
  assert.match(sent[0].text, /within 1 dB for 20 s/);
  assert.deepEqual(sounds.at(-1), true);
  const rec = store.listEvents().find((e) => e.kind === 'dead-air');
  assert.equal(rec.cause, 'frozen');
  assert.equal(rec.end, null);
  moving(10_000);
  assert.equal(m.status().overall, 'ok');
  assert.equal(sent.length, 2);
  assert.match(sent[1].subject, /Audio back/);
  assert.ok(store.listEvents().find((e) => e.kind === 'dead-air').end);
  assert.equal(sounds.at(-1), false);
});

test('frozen audio is off by default: a steady tone is just audio', () => {
  const { m, advance, sent } = setup({ inputs: [INPUT_A] });
  m.start();
  advance(300_000, -20);
  assert.equal(m.status().overall, 'ok');
  assert.equal(sent.length, 0);
});

test('frozen audio: when the tone turns into silence the frozen alarm ends quietly and the silence alarm takes over', () => {
  const { m, advance, sent, store } = setup({ inputs: [{ ...INPUT_A, minSilenceSec: 10, frozenSec: 20 }] });
  m.start();
  advance(40_000, -20);
  assert.equal(m.status().inputs[0].cause, 'frozen');
  advance(15_000, -80);
  assert.equal(m.status().inputs[0].cause, 'silence');
  const ev = store.listEvents().filter((e) => e.kind === 'dead-air');
  assert.deepEqual(ev.map((e) => e.cause).sort(), ['frozen', 'silence']);
  assert.ok(ev.find((e) => e.cause === 'frozen').end);
  assert.equal(sent.filter((s) => /Audio back/.test(s.subject)).length, 0);
});

test('frozen audio: stopping the monitor closes an open frozen alarm as interrupted', () => {
  const { m, advance, store } = setup({ inputs: [{ ...INPUT_A, frozenSec: 20 }] });
  m.start();
  advance(40_000, -20);
  m.stop();
  const rec = store.listEvents().find((e) => e.cause === 'frozen');
  assert.ok(rec.end);
  assert.equal(rec.interrupted, true);
});
