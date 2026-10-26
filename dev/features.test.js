// 26.10.6: micro-silences, pause of alerts per input, grouped alerts, installation name in the alerts, new settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDetector } from '../src/core/detector.js';
import { createStore, sanitizeSettings, DEFAULT_SETTINGS } from '../src/store.js';
import { createMonitor, TICK_MS } from '../src/monitor.js';
import { createGrouper } from '../src/grouping.js';
import { createDispatcher } from '../src/notifications.js';
import { alertPrefix, withPrefix, buildGroupAlert, MESSAGE_KEYS, MESSAGES } from '../src/messages.js';
import { buildExport, prepareImport } from '../src/backup.js';

const mkInput = (id, name, sec = 10) => ({ id, name, type: 'stream', streamUrl: `http://${id}.example.org/live`, thresholdDb: -50, minSilenceSec: sec });
const A = mkInput('a', 'Main');
const B = mkInput('b', 'Backup');
const C = mkInput('c', 'Third');

function setup(patch = {}, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daw-f-'))) {
  const clock = { t: 1_800_000_000_000 };
  const file = path.join(dir, 'd.json');
  const store = createStore({ file, now: () => clock.t });
  store.updateSettings({ inputs: [A], ...patch });
  const sent = [];
  const timers = [];
  const build = () =>
    createMonitor({
      store,
      engine: { sync: () => {}, stop: () => {} },
      dispatch: (msg) => sent.push(msg),
      alarmSound: () => {},
      publish: { status: () => {}, events: () => {}, levels: () => {} },
      now: () => clock.t,
      host: 'test-host',
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
      setTimeoutFn: (fn, ms) => {
        const h = { at: clock.t + ms, fn };
        timers.push(h);
        return h;
      },
      clearTimeoutFn: (h) => {
        const i = timers.indexOf(h);
        if (i >= 0) timers.splice(i, 1);
      }
    });
  const m = build();
  const advance = (ms, level, fault) => {
    for (let n = 0; n < ms / TICK_MS; n++) {
      clock.t += TICK_MS;
      for (const h of [...timers]) if (h.at <= clock.t) {
        timers.splice(timers.indexOf(h), 1);
        h.fn();
      }
      const levels = level !== null && typeof level === 'object' ? level : Object.fromEntries(store.getSettings().inputs.map((i) => [i.id, level]));
      for (let k = 0; k < 2; k++) {
        const batch = {};
        for (const [id, v] of Object.entries(levels)) if (v !== null && v !== undefined) batch[id] = { rms: [v, v - 3], peak: [v, v] };
        if (Object.keys(batch).length) m.onLevels(batch);
      }
      m.tick();
    }
  };
  return { clock, store, m, sent, timers, advance, build, file };
}

// ---- micro-silences -----------------------------------------------------------------------------------------

test('detector: blips are off unless asked for; a drop that ends before the alarm is reported once audio is back', () => {
  const off = createDetector({ thresholdDb: -50, minSilenceMs: 10_000, releaseMs: 2_000 });
  const on = createDetector({ thresholdDb: -50, minSilenceMs: 10_000, releaseMs: 2_000, blips: true });
  const run = (d, level, from, to) => {
    const out = [];
    for (let t = from; t < to; t += 250) out.push(...d.feed(level, t));
    return out;
  };
  for (const d of [off, on]) run(d, -20, 0, 1000);
  assert.deepEqual([...run(off, -80, 1000, 4000), ...run(off, -20, 4000, 8000)], []);
  const ev = [...run(on, -80, 1000, 4000), ...run(on, -20, 4000, 8000)];
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'blip');
  assert.equal(ev[0].start, 1000);
  assert.equal(ev[0].end, 4000);
  assert.equal(ev[0].durationMs, 3000);
  assert.equal(ev[0].cause, 'silence');
});

test('detector: a drop of a single window is a blip; the cause is nodata, then late, then silence', () => {
  const d = createDetector({ thresholdDb: -50, minSilenceMs: 10_000, releaseMs: 1_000, blips: true });
  d.feed(-20, 0);
  d.feed(-80, 250); // silence
  d.feed(null, 500, 'late');
  d.feed(null, 750, 'nodata');
  let ev = [];
  for (let t = 1000; t <= 2500; t += 250) ev.push(...d.feed(-20, t));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].cause, 'nodata');
  d.feed(-80, 3000);
  d.feed(null, 3250, 'late');
  ev = [];
  for (let t = 3500; t <= 5000; t += 250) ev.push(...d.feed(-20, t));
  assert.equal(ev[0].cause, 'late');
  d.feed(-80, 6000);
  ev = [];
  for (let t = 6250; t <= 8000; t += 250) ev.push(...d.feed(-20, t));
  assert.equal(ev[0].cause, 'silence');
});

test('detector: an alarm is not a blip, and the alarm still needs the full time', () => {
  const d = createDetector({ thresholdDb: -50, minSilenceMs: 2_000, releaseMs: 500, blips: true });
  d.feed(-20, 0);
  const ev = [];
  for (let t = 250; t <= 3000; t += 250) ev.push(...d.feed(-80, t));
  for (let t = 3250; t <= 4000; t += 250) ev.push(...d.feed(-20, t));
  assert.deepEqual(ev.map((e) => e.type), ['alarm', 'recovered']);
});

test('monitor: a brief drop is logged with time, duration and cause; nothing is sent, the alarm rule is unchanged', () => {
  const { m, store, sent, advance } = setup();
  m.start();
  advance(3000, -20);
  advance(2000, -80); // 2 s below: yellow, then back
  advance(3000, -20);
  assert.equal(sent.length, 0);
  assert.notEqual(m.status().overall, 'alarm');
  const blips = store.listEvents().filter((e) => e.kind === 'blip');
  assert.equal(blips.length, 1);
  assert.equal(blips[0].cause, 'silence');
  assert.equal(blips[0].input, 'Main');
  assert.equal(blips[0].inputId, 'a');
  assert.ok(blips[0].end - blips[0].start >= 1500 && blips[0].end - blips[0].start <= 3000);
  assert.equal(store.listEvents().filter((e) => e.kind === 'dead-air').length, 0);
  // the red phase still comes only after minSilenceSec (10 s)
  advance(9000, -80);
  assert.equal(m.status().overall, 'counting');
  advance(2000, -80);
  assert.equal(m.status().overall, 'alarm');
});

test('monitor: measurements that arrive late are told apart from a stopped input', () => {
  const { m, store, advance } = setup();
  m.start();
  advance(3000, -20);
  advance(3000, null); // nothing arrives for 3 s, no fault reported: late
  advance(3000, -20);
  let blips = store.listEvents().filter((e) => e.kind === 'blip');
  assert.equal(blips.length, 1);
  assert.equal(blips[0].cause, 'late');
  m.onFault('a', 'stream-error'); // the engine says the input failed
  advance(3000, -20);
  m.onOk('a');
  advance(3000, -20);
  blips = store.listEvents().filter((e) => e.kind === 'blip');
  assert.equal(blips.length, 2);
  assert.equal(blips[1].cause, 'nodata');
});

test('store: micro-silences are kept for their own (shorter) time and never more than the cap', () => {
  const clock = { t: 1_800_000_000_000 };
  const store = createStore({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'daw-p-')), 'd.json'), now: () => clock.t });
  const day = 86_400_000;
  store.addEvent({ kind: 'blip', cause: 'silence', start: clock.t - 40 * day, end: clock.t - 40 * day + 1000, input: 'x', inputId: 'x' });
  store.addEvent({ kind: 'blip', cause: 'silence', start: clock.t - 5 * day, end: clock.t - 5 * day + 1000, input: 'x', inputId: 'x' });
  store.addEvent({ kind: 'dead-air', cause: 'silence', start: clock.t - 40 * day, end: clock.t - 40 * day + 60_000, input: 'x', inputId: 'x' });
  assert.equal(store.pruneEvents(365, { blipDays: 30 }), 1);
  assert.deepEqual(store.listEvents().map((e) => e.kind).sort(), ['blip', 'dead-air']);
  for (let i = 0; i < 10; i++) store.addEvent({ kind: 'blip', cause: 'silence', start: clock.t - i * 1000, end: clock.t - i * 1000 + 500, input: 'x', inputId: 'x' });
  store.pruneEvents(365, { blipDays: 30, blipMax: 4 });
  const left = store.listEvents().filter((e) => e.kind === 'blip');
  assert.equal(left.length, 4);
  assert.ok(left.every((e) => e.start >= clock.t - 3000), 'the newest ones are the ones kept');
});

// ---- pause of the alerts ---------------------------------------------------------------------------------------

test('pause: no alarm, no alert, no alarm event while paused; the pause is in the log; it ends by itself', () => {
  const { m, store, clock, sent, advance } = setup();
  m.start();
  advance(3000, -20);
  const until = clock.t + 60_000;
  assert.deepEqual(m.pauseInput('a', until), { ok: true, until });
  assert.equal(m.status().inputs[0].state, 'paused');
  assert.equal(m.status().inputs[0].pausedUntil, until);
  assert.equal(m.status().overall, 'paused');
  advance(40_000, -90); // far beyond the 10 s limit
  assert.equal(sent.length, 0);
  assert.equal(store.listEvents().filter((e) => e.kind === 'dead-air').length, 0);
  assert.equal(m.status().inputs[0].state, 'paused');
  const pause = store.listEvents().find((e) => e.kind === 'pause');
  assert.equal(pause.input, 'Main');
  assert.equal(pause.end, null);
  advance(25_000, -90); // the pause ended at 60 s; the countdown restarts from there
  const ended = store.listEvents().find((e) => e.kind === 'pause');
  assert.ok(ended.end && ended.expired === true, 'closed at its end');
  assert.equal(m.status().inputs[0].state, 'counting');
  advance(12_000, -90);
  assert.equal(m.status().overall, 'alarm');
  assert.equal(sent.length, 1);
});

test('pause: an alarm that was open ends in the log without a "recovered" message; resume works by hand', () => {
  const { m, store, clock, sent, advance } = setup();
  m.start();
  advance(3000, -20);
  advance(12_000, -90);
  assert.equal(m.status().overall, 'alarm');
  assert.equal(sent.length, 1);
  m.pauseInput('a', clock.t + 3_600_000);
  assert.equal(sent.length, 1, 'nothing more is sent');
  const dead = store.listEvents().find((e) => e.kind === 'dead-air');
  assert.ok(dead.end && dead.pausedBy === true);
  assert.equal(m.status().overall, 'paused');
  assert.deepEqual(m.resumeInput('a'), { ok: true });
  assert.notEqual(m.status().inputs[0].state, 'paused');
  const pause = store.listEvents().find((e) => e.kind === 'pause');
  assert.ok(pause.end);
  assert.deepEqual(m.resumeInput('a'), { ok: false });
});

test('pause: only the paused input is silent; the others keep alerting', () => {
  const { m, clock, sent, advance } = setup({ inputs: [A, B], notifications: { grouping: { enabled: false } } });
  m.start();
  advance(3000, -20);
  m.pauseInput('a', clock.t + 3_600_000);
  advance(13_000, { a: -90, b: -90 });
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /Backup/);
  assert.equal(m.status().overall, 'alarm');
});

test('pause: an input that is removed or disabled while paused does not leave an open pause in the log', () => {
  const { m, store, clock, advance } = setup({ inputs: [A, B] });
  m.start();
  advance(3000, -20);
  m.pauseInput('b', clock.t + 3_600_000);
  store.updateSettings({ inputs: [A] }); // B removed in Settings
  m.syncInputs();
  const pause = store.listEvents().find((e) => e.kind === 'pause');
  assert.ok(pause.end, 'closed');
  assert.equal(m.status().inputs.length, 1);
});

test('pause: wrong input, past time and not-a-number are refused', () => {
  const { m, clock } = setup();
  assert.equal(m.pauseInput('nope', clock.t + 1000).ok, false);
  assert.equal(m.pauseInput('a', clock.t - 1).ok, false);
  assert.equal(m.pauseInput('a', NaN).ok, false);
});

test('pause: survives a restart and ends at its time; one that ended while the app was closed is closed in the log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daw-r-'));
  const s1 = setup({ inputs: [A, B] }, dir);
  s1.m.pauseInput('a', s1.clock.t + 3_600_000);
  s1.m.pauseInput('b', s1.clock.t + 600_000);
  s1.store.flush();
  // a new run of the program, 20 minutes later
  const clock2 = { t: s1.clock.t + 20 * 60_000 };
  const store2 = createStore({ file: s1.file, now: () => clock2.t });
  const m2 = createMonitor({ store: store2, engine: { sync() {}, stop() {} }, dispatch() {}, publish: { status() {}, events() {}, levels() {} }, now: () => clock2.t, setIntervalFn: () => 1, clearIntervalFn() {} });
  m2.recoverFromPreviousRun();
  const st = m2.status().inputs;
  assert.equal(st.find((i) => i.id === 'a').pausedUntil, s1.clock.t + 3_600_000);
  assert.equal(st.find((i) => i.id === 'b').pausedUntil, undefined);
  const pauses = store2.listEvents().filter((e) => e.kind === 'pause');
  assert.equal(pauses.find((e) => e.inputId === 'a').end, null, 'still running');
  assert.equal(pauses.find((e) => e.inputId === 'b').end, s1.clock.t + 600_000, 'closed at its own end');
});

// ---- grouped alerts --------------------------------------------------------------------------------------------------

function fakeGrouper(cfg) {
  let now = 0;
  const sent = [];
  const timers = [];
  const g = createGrouper({
    getConfig: () => cfg,
    send: (m) => sent.push(m),
    buildGroup: (kind, items) => ({ group: kind, items: items.map((i) => i.input) }),
    setTimer: (fn, ms) => {
      const h = { at: now + ms, fn };
      timers.push(h);
      return h;
    },
    clearTimer: (h) => timers.splice(timers.indexOf(h), 1)
  });
  const tick = (ms) => {
    now += ms;
    for (const h of [...timers]) if (h.at <= now) {
      timers.splice(timers.indexOf(h), 1);
      h.fn();
    }
  };
  return { g, sent, tick };
}

test('grouping: the first alert goes at once, the others of the same window go out as one list', () => {
  const { g, sent, tick } = fakeGrouper({ enabled: true, windowSec: 60, firstNow: true });
  g.submit('alarm', { input: 'A' }, { id: 'single-A' });
  assert.deepEqual(sent, [{ id: 'single-A' }]);
  tick(10_000);
  g.submit('alarm', { input: 'B' }, { id: 'single-B' });
  g.submit('alarm', { input: 'C' }, { id: 'single-C' });
  assert.equal(sent.length, 1);
  assert.equal(g.pending(), 2);
  tick(50_000);
  assert.deepEqual(sent[1], { group: 'alarm', items: ['B', 'C'] });
  assert.equal(sent.length, 2);
  assert.equal(g.pending(), 0);
});

test('grouping: a lone alert is never delayed and a single leftover goes out as its own message', () => {
  const { g, sent, tick } = fakeGrouper({ enabled: true, windowSec: 60, firstNow: true });
  g.submit('alarm', { input: 'A' }, { id: 'single-A' });
  g.submit('alarm', { input: 'B' }, { id: 'single-B' });
  tick(60_000);
  assert.deepEqual(sent, [{ id: 'single-A' }, { id: 'single-B' }]);
  g.submit('alarm', { input: 'C' }, { id: 'single-C' }); // a new window
  assert.equal(sent.length, 3);
});

test('grouping: alarms and recoveries have separate windows; without firstNow everything waits for the window', () => {
  const { g, sent, tick } = fakeGrouper({ enabled: true, windowSec: 30, firstNow: false });
  g.submit('alarm', { input: 'A' }, { id: 'a' });
  g.submit('recovered', { input: 'B' }, { id: 'rb' });
  g.submit('alarm', { input: 'C' }, { id: 'c' });
  assert.equal(sent.length, 0);
  tick(30_000);
  assert.deepEqual(sent, [{ group: 'alarm', items: ['A', 'C'] }, { id: 'rb' }]);
});

test('grouping: switched off, every alert goes at once; flush sends what is waiting', () => {
  const off = fakeGrouper({ enabled: false, windowSec: 60, firstNow: true });
  off.g.submit('alarm', { input: 'A' }, { id: 'a' });
  off.g.submit('alarm', { input: 'B' }, { id: 'b' });
  assert.equal(off.sent.length, 2);
  const on = fakeGrouper({ enabled: true, windowSec: 60, firstNow: true });
  on.g.submit('alarm', { input: 'A' }, { id: 'a' });
  on.g.submit('alarm', { input: 'B' }, { id: 'b' });
  on.g.submit('alarm', { input: 'C' }, { id: 'c' });
  on.g.flush();
  assert.deepEqual(on.sent[1], { group: 'alarm', items: ['B', 'C'] });
  assert.equal(on.g.pending(), 0);
});

test('monitor: three streams fail together: one message at once, then one message for the other two; recoveries the same', () => {
  const { m, sent, advance } = setup({ inputs: [A, B, C] });
  m.start();
  advance(3000, -20);
  advance(11_000, { a: -90, b: -90, c: -90 });
  assert.equal(sent.length, 1, 'the first alarm went at once');
  assert.match(sent[0].subject, /DEAD AIR: Main/);
  advance(60_000, { a: -90, b: -90, c: -90 });
  assert.equal(sent.length, 2, 'the window closed: one message for the other two');
  assert.match(sent[1].subject, /DEAD AIR on 2 inputs/);
  assert.match(sent[1].text, /Backup/);
  assert.match(sent[1].text, /Third/);
  assert.ok(!/Main/.test(sent[1].text));
  advance(5000, -20);
  assert.equal(sent.length, 3, 'first recovery at once');
  assert.match(sent[2].subject, /Audio back: Main/);
  advance(60_000, -20);
  assert.equal(sent.length, 4);
  assert.match(sent[3].subject, /Audio back on 2 inputs/);
});

test('monitor: stopping sends the alerts that were waiting for their window', () => {
  const { m, sent, advance } = setup({ inputs: [A, B] });
  m.start();
  advance(3000, -20);
  advance(11_000, { a: -90, b: -90 });
  assert.equal(sent.length, 1);
  m.stop(true);
  assert.equal(sent.length, 2);
  assert.match(sent[1].subject, /Backup/);
});

test('group message: list of inputs in the three languages', () => {
  const items = [{ input: 'Roma', cause: 'silence', start: 1_800_000_000_000 }, { input: 'Milano', cause: 'offline', start: 1_800_000_060_000 }];
  for (const lang of ['en', 'it', 'es']) {
    const a = buildGroupAlert(lang, 'alarm', items, { now: 1_800_000_100_000, host: 'h' });
    assert.match(a.subject, /2/);
    assert.match(a.text, /Roma/);
    assert.match(a.text, /Milano/);
    const r = buildGroupAlert(lang, 'recovered', [{ input: 'Roma', start: 1, end: 61_000, durationMs: 60_000 }, { input: 'Milano', start: 1, end: 91_000, durationMs: 90_000 }], { now: 2, host: 'h' });
    assert.match(r.text, /Roma/);
  }
  assert.deepEqual(MESSAGE_KEYS.filter((k) => !(k in MESSAGES.it) || !(k in MESSAGES.es)), []);
});

// ---- installation name in the alerts ------------------------------------------------------------------------------

test('installation name: the prefix says which PC speaks (the computer name when none is set)', () => {
  assert.equal(alertPrefix({ installationName: 'Studio 2' }, 'PC-7'), '[Dead Air Watchdog · Studio 2]');
  assert.equal(alertPrefix({ installationName: '' }, 'PC-7'), '[Dead Air Watchdog · PC-7]');
  assert.equal(alertPrefix({ installationName: '' }, ''), '[Dead Air Watchdog]');
  assert.equal(withPrefix('[Dead Air Watchdog] DEAD AIR: Main', '[Dead Air Watchdog · Studio 2]'), '[Dead Air Watchdog · Studio 2] DEAD AIR: Main');
  assert.equal(withPrefix('Plain text', '[Dead Air Watchdog · X]'), 'Plain text');
});

test('installation name: email subject and Telegram text carry it', async () => {
  const mails = [];
  const tgs = [];
  const d = createDispatcher({
    getSettings: () => ({ language: 'en', installationName: 'Studio 2', notifications: { email: { enabled: true }, telegram: { enabled: true } } }),
    host: 'PC-7',
    deps: { sendEmail: async (_c, subject) => mails.push(subject), sendTelegram: async (_c, text, _l, _f, prefix) => tgs.push({ text, prefix }) }
  });
  await d.dispatch({ subject: '[Dead Air Watchdog] DEAD AIR: Main', text: 'Dead air on "Main".', label: 'x' });
  assert.equal(mails[0], '[Dead Air Watchdog · Studio 2] DEAD AIR: Main');
  assert.equal(tgs[0].prefix, '[Dead Air Watchdog · Studio 2]');
});

// ---- settings -------------------------------------------------------------------------------------------------------

test('settings: new fields have safe defaults and are kept inside their limits', () => {
  const d = sanitizeSettings({});
  assert.equal(d.display.wallLogo, 'large');
  assert.equal(d.display.wallClock, 'max');
  assert.equal(d.display.wallLogoOpacity, 0.2);
  assert.deepEqual(d.notifications.grouping, { enabled: true, windowSec: 60, firstNow: true });
  assert.equal(d.general.microRetentionDays, 30);
  assert.equal(d.installationName, '');
  assert.deepEqual(d.updateState, { skipVersion: '', remindUntil: 0, lastCheck: null });
  assert.equal(d.window.width, 1180);
  const w = sanitizeSettings({ display: { wallLogo: 'huge', wallClock: 'x', wallLogoOpacity: 7 }, notifications: { grouping: { windowSec: 5 } }, general: { microRetentionDays: 9999 }, installationName: '  Regia  ', window: { x: 10.4, y: 20, width: 5, height: 99999, maximized: 1 } });
  assert.equal(w.display.wallLogo, 'large');
  assert.equal(w.display.wallClock, 'max');
  assert.equal(w.display.wallLogoOpacity, 0.5);
  assert.equal(w.notifications.grouping.windowSec, 10);
  assert.equal(w.general.microRetentionDays, 365);
  assert.equal(w.installationName, 'Regia');
  assert.deepEqual(w.window, { x: 10, y: 20, width: 760, height: 8000, maximized: true, compact: false, alwaysOnTop: false, hideMenuBar: false });
  assert.ok(DEFAULT_SETTINGS.display.wallLogo);
});

test('backup: the window position, the update decisions and the last seen version stay on this PC', () => {
  const s = sanitizeSettings({ inputs: [A], installationName: 'Studio 2', lastSeenVersion: '26.10.5', updateState: { skipVersion: '26.10.9', remindUntil: 5, lastCheck: null }, window: { x: 1, y: 2, width: 900, height: 700 } });
  const file = buildExport(s);
  for (const k of ['window', 'updateState', 'lastSeenVersion']) assert.equal(k in file.settings, false, k);
  assert.equal(file.settings.installationName, 'Studio 2');
  const current = sanitizeSettings({ inputs: [], lastSeenVersion: '26.10.6', window: { x: 5, y: 6, width: 1000, height: 800 } });
  const plan = prepareImport(file, current);
  assert.equal(plan.settings.lastSeenVersion, '26.10.6');
  assert.equal(plan.settings.window.width, 1000);
  assert.equal(plan.settings.installationName, 'Studio 2');
});
