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

test('silence beyond the minimum: one alarm alert, one log entry; recovery closes it with the duration', () => {
  const { m, store, sent, advance } = setup();
  m.start();
  advance(5000, -20);
  assert.equal(m.status().overall, 'ok');
  advance(6000, -80);
  assert.equal(m.status().overall, 'counting');
  assert.equal(sent.length, 0);
  advance(6000, -80);
  assert.equal(m.status().overall, 'alarm');
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /DEAD AIR/);
  assert.ok(!sent[0].text.includes('secret'), 'credentials of the stream URL must not appear in alerts');
  assert.match(sent[0].subject, /Main/);
  let evs = store.listEvents();
  assert.equal(evs.length, 1);
  assert.equal(evs[0].end, null);
  advance(5000, -20);
  assert.equal(m.status().overall, 'ok');
  evs = store.listEvents();
  assert.ok(evs[0].end > evs[0].start);
  assert.equal(sent.length, 2);
  assert.match(sent[1].subject, /Audio back/);
  const dur = (evs[0].end - evs[0].start) / 1000;
  assert.ok(dur >= 10 && dur <= 20, String(dur));
});

test('silence shorter than the minimum produces nothing', () => {
  const { m, store, sent, advance } = setup();
  m.start();
  advance(3000, -20);
  advance(6000, -80);
  advance(5000, -20);
  assert.equal(sent.length, 0);
  assert.equal(store.listEvents().length, 0);
});

test('no level reports at all (engine stalled) is dead air with cause offline', () => {
  const { m, store, sent, advance } = setup();
  m.start();
  advance(4000, -20);
  advance(20_000, null);
  assert.equal(m.status().overall, 'alarm');
  assert.equal(store.listEvents()[0].cause, 'offline');
  assert.match(sent[0].text, /offline/);
});

test('engine fault is dead air even while level reports keep arriving', () => {
  const { m, store, advance } = setup();
  m.start();
  advance(3000, -20);
  m.onFault('a', 'stream-error');
  advance(15_000, -20);
  assert.equal(m.status().overall, 'alarm');
  assert.equal(store.listEvents()[0].cause, 'offline');
  m.onOk('a');
  advance(4000, -20);
  assert.equal(m.status().overall, 'ok');
});

test('start-up grace: no alarm clock before the first report', () => {
  const { m, advance } = setup();
  m.start();
  advance(5000, null);
  assert.equal(m.status().overall, 'starting');
});

test('reminders repeat while the alarm lasts', () => {
  const { m, sent, advance } = setup({ notifications: { reminderMin: 1 } });
  m.start();
  advance(3000, -20);
  advance(15_000, -80);
  assert.equal(sent.length, 1);
  advance(61_000, -80);
  assert.equal(sent.length, 2);
  assert.match(sent[1].subject, /STILL DEAD AIR/);
});

test('stopping during an alarm closes the log entry as interrupted', () => {
  const { m, store, advance } = setup();
  m.start();
  advance(3000, -20);
  advance(15_000, -80);
  m.stop();
  const e = store.listEvents()[0];
  assert.ok(e.end > e.start);
  assert.equal(e.interrupted, true);
  assert.equal(m.status().overall, 'idle');
});

test('a long pause between ticks (sleep) is logged as a gap and drops the countdown', () => {
  const { m, store, clock, advance } = setup();
  m.start();
  advance(3000, -20);
  clock.t += 3_600_000;
  m.tick();
  const gaps = store.listEvents().filter((e) => e.kind === 'gap');
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].cause, 'suspended');
});

test('recoverFromPreviousRun closes open alarms and records the gap', () => {
  const { m, store, clock } = setup();
  store.addEvent({ kind: 'dead-air', cause: 'silence', start: clock.t - 500_000, end: null });
  store.setMeta({ lastHeartbeat: clock.t - 400_000, cleanExit: false });
  m.recoverFromPreviousRun();
  const evs = store.listEvents();
  assert.equal(evs.find((e) => e.kind === 'dead-air').end, clock.t - 400_000);
  assert.equal(evs.find((e) => e.kind === 'dead-air').interrupted, true);
  assert.equal(evs.find((e) => e.kind === 'gap').cause, 'unknown');
});

test('dispatcher retries only the failed channel and gives up after maxAge', async () => {
  const calls = [];
  const timers = [];
  let fail = 2;
  const settings = { language: 'en', notifications: { email: { enabled: true }, telegram: { enabled: true } } };
  const d = createDispatcher({
    getSettings: () => settings,
    delays: [10, 20],
    maxAgeMs: 1000,
    setTimer: (fn) => (timers.push(fn), timers.length),
    deps: {
      sendEmail: async () => calls.push('email'),
      sendTelegram: async () => {
        calls.push('telegram');
        if (fail-- > 0) throw new Error('offline');
      }
    }
  });
  const done = d.dispatch({ subject: 's', text: 't', label: 'x' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['email', 'telegram']);
  timers.shift()();
  await new Promise((r) => setImmediate(r));
  timers.shift()();
  assert.equal(await done, true);
  assert.deepEqual(calls, ['email', 'telegram', 'telegram', 'telegram']);
});

test('dispatcher gives up when the retry window is over', async () => {
  let t = 0;
  const d = createDispatcher({ getSettings: () => ({ language: 'en', notifications: { email: { enabled: false }, telegram: { enabled: true } } }), delays: [400], maxAgeMs: 1000, now: () => t, setTimer: (fn) => { t += 400; setImmediate(fn); return 1; }, deps: { sendTelegram: async () => { throw new Error('offline'); } } });
  assert.equal(await d.dispatch({ subject: 's', text: 't', label: 'x' }), false);
});

test('translations: every language has every key; placeholders match English', () => {
  for (const l of ['it', 'es']) {
    assert.deepEqual(Object.keys(MESSAGES[l]).sort(), [...MESSAGE_KEYS].sort(), l);
    for (const k of MESSAGE_KEYS) {
      const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
      assert.equal(ph(MESSAGES[l][k]), ph(MESSAGES.en[k]), `${l} ${k}`);
    }
  }
});

test('alert text in each language contains the input and the duration', () => {
  for (const lang of ['en', 'it', 'es']) {
    const a = buildAlert(lang, 'recovered', { input: 'Main out', cause: 'silence', start: 0, end: 65_000, now: 70_000, durationMs: 65_000, host: 'h', thresholdDb: -50, minSilenceSec: 30 });
    assert.ok(a.text.includes('Main out') && a.text.includes('1m 05s'), lang);
  }
  assert.equal(inputLabel('en', { type: 'device', deviceLabel: '' }), 'default audio input');
});

test('alarm sound starts with the alarm and stops on recovery, on stop and never for short silences', () => {
  const a = setup();
  a.m.start();
  a.advance(3000, -20);
  a.advance(6000, -80);
  a.advance(5000, -20);
  assert.deepEqual(a.sounds, []);
  a.advance(15_000, -80);
  assert.deepEqual(a.sounds, [true]);
  a.advance(5000, -20);
  assert.deepEqual(a.sounds, [true, false]);
  a.advance(15_000, -80);
  assert.deepEqual(a.sounds, [true, false, true]);
  a.m.stop();
  assert.deepEqual(a.sounds, [true, false, true, false]);
});

test('two inputs: independent detectors, one log entry each, alerts carry the input name, one sound', () => {
  const { m, store, sent, sounds, advance } = setup({ inputs: [INPUT_A, INPUT_B] });
  assert.equal(m.start(), true);
  advance(4000, -20);
  assert.equal(m.status().overall, 'ok');
  assert.deepEqual(m.status().counts, { ok: 2, counting: 0, alarm: 0, starting: 0 });
  advance(12_000, { a: -80, b: -20 }); // only the main input goes silent (10 s limit)
  let st = m.status();
  assert.equal(st.overall, 'alarm');
  assert.deepEqual(st.inputs.map((i) => i.state), ['alarm', 'ok']);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /Main/);
  assert.deepEqual(sounds, [true]);
  advance(12_000, { a: -80, b: -80 }); // backup silent too: its own limit is 20 s
  assert.deepEqual(m.status().inputs.map((i) => i.state), ['alarm', 'counting']);
  advance(10_000, { a: -80, b: -80 });
  assert.deepEqual(m.status().inputs.map((i) => i.state), ['alarm', 'alarm']);
  assert.equal(sent.length, 2);
  assert.match(sent[1].subject, /Backup/);
  assert.deepEqual(sounds, [true, true], 'every new alarm sounds again (re-arms a muted alarm)');
  advance(5000, { a: -20, b: -80 }); // main back, backup still silent: sound goes on
  assert.deepEqual(sounds, [true, true]);
  advance(5000, { a: -20, b: -20 });
  assert.deepEqual(sounds, [true, true, false]);
  const evs = store.listEvents().filter((e) => e.kind === 'dead-air');
  assert.equal(evs.length, 2);
  assert.deepEqual(evs.map((e) => e.input).sort(), ['Backup', 'Main']);
  assert.ok(evs.every((e) => e.end > e.start && e.inputId));
});

test('an input that stays quiet does not affect the others; thresholds are per input', () => {
  const { m, sent, advance } = setup({ inputs: [INPUT_A, INPUT_B] });
  m.start();
  advance(3000, -20);
  advance(8000, { a: -48, b: -48 }); // -48 dB: below B's threshold (-45), above A's (-50)
  assert.deepEqual(m.status().inputs.map((i) => i.state), ['ok', 'counting']);
  assert.equal(sent.length, 0);
});

test('syncInputs: adding, removing and editing inputs while running', () => {
  const { m, store, engineCalls, advance } = setup();
  m.start();
  advance(3000, -20);
  store.updateSettings({ inputs: [INPUT_A, INPUT_B] });
  m.syncInputs();
  assert.deepEqual(engineCalls.at(-1), ['sync', ['a', 'b']]);
  assert.equal(m.status().inputs.length, 2);
  advance(15_000, { a: -80, b: -20 });
  assert.equal(m.status().overall, 'alarm');
  store.updateSettings({ inputs: [INPUT_B] }); // main removed during its alarm
  m.syncInputs();
  const e = store.listEvents().find((x) => x.inputId === 'a');
  assert.equal(e.interrupted, true);
  assert.ok(e.end > e.start);
  store.updateSettings({ inputs: [{ ...INPUT_B, enabled: false }] });
  m.syncInputs();
  assert.equal(m.isRunning(), false, 'nothing left to monitor: stops');
});

test('start refuses when no input is usable; invalid URLs and disabled inputs are skipped', () => {
  const { m, engineCalls } = setup({ inputs: [{ ...INPUT_A, streamUrl: '' }, { ...INPUT_B, enabled: false }] });
  assert.equal(m.start(), false);
  assert.equal(m.isRunning(), false);
  assert.equal(engineCalls.length, 0);
  assert.deepEqual(m.status().inputs.map((i) => i.state), ['idle', 'idle']);
});
