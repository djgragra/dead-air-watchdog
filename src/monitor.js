// Orchestrates all monitored inputs: turns the level reports of the audio engine into detector
// input (one detector per input), writes the event log, sends the alerts, and publishes one
// combined state for the window, the tray and the single audible alarm.
// Everything with side effects is injected so tests can drive it with a fake clock.
import { createDetector } from './core/detector.js';
import { loudestChannel } from './core/level.js';
import { inputLabel, buildAlert } from './messages.js';

export const TICK_MS = 250;
const STALE_MS = 1500; // no level report for this long = the input delivers nothing
const START_GRACE_MS = 8000; // time the engine gets to deliver the first report of an input
const HEARTBEAT_MS = 15_000;
const SUSPEND_MS = 10_000; // a pause between ticks longer than this means the process was suspended
const RELEASE_MS = 2000;
const PRIORITY = { alarm: 4, counting: 3, starting: 2, ok: 1 };

export const isUsable = (inp) => inp.enabled && (inp.type === 'device' || /^https?:\/\/[^\s]+$/i.test(inp.streamUrl || ''));

// What the engine needs to open an input (nothing else leaves the settings).
const engineInput = (i) => ({ id: i.id, type: i.type, deviceId: i.deviceId, channelPair: i.channelPair, streamUrl: i.streamUrl });

export function createMonitor({ store, engine, dispatch, publish, desktopNotify = () => {}, alarmSound = () => {}, now = Date.now, host = 'this machine', log = () => {}, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  const chans = new Map(); // input id -> channel state
  let running = false;
  let startedAt = 0;
  let lastTick = 0;
  let lastHeartbeat = 0;
  let timer = null;
  let lastStatusKey = '';

  const settings = () => store.getSettings();
  const inputById = (id) => settings().inputs.find((i) => i.id === id);
  const activeInputs = () => settings().inputs.filter(isUsable);

  function makeChannel(inp, t) {
    return {
      id: inp.id,
      detector: createDetector({ releaseMs: RELEASE_MS, thresholdDb: inp.thresholdDb, minSilenceMs: inp.minSilenceSec * 1000 }),
      startedAt: t,
      lastSampleAt: null,
      windowMax: -Infinity,
      fault: null, // reason string reported by the engine, or null
      openEventId: null,
      lastNotifyAt: 0
    };
  }

  const anyAlarm = () => [...chans.values()].some((c) => c.detector.snapshot(now()).status === 'alarm');

  function alertData(inp, extra) {
    const s = settings();
    return { input: inputLabel(s.language, inp), thresholdDb: inp.thresholdDb, minSilenceSec: inp.minSilenceSec, host, now: now(), ...extra };
  }

  function send(inp, kind, extra) {
    const { subject, text } = buildAlert(settings().language, kind, alertData(inp, extra));
    dispatch({ subject, text, label: `${kind}:${inputLabel(settings().language, inp)}` });
  }

  function addGap(start, end, cause) {
    if (end - start < 1000) return;
    store.addEvent({ kind: 'gap', cause, start, end, input: '', inputId: '' });
    publish.events();
  }

  function handleEvent(ch, ev) {
    const inp = inputById(ch.id);
    if (!inp) return;
    const label = inputLabel(settings().language, inp);
    if (ev.type === 'alarm') {
      const rec = store.addEvent({ kind: 'dead-air', cause: ev.cause, start: ev.start, end: null, input: label, inputId: inp.id, thresholdDb: inp.thresholdDb, minSilenceSec: inp.minSilenceSec });
      ch.openEventId = rec.id;
      ch.lastNotifyAt = now();
      send(inp, 'alarm', { cause: ev.cause, start: ev.start });
      desktopNotify('alarm', { input: label });
      alarmSound(true); // a new alarm always sounds, even if an earlier one was silenced
      log(`ALARM ${label}: ${ev.cause} since ${new Date(ev.start).toISOString()}`, 'error');
      publish.events();
    } else if (ev.type === 'recovered') {
      if (ch.openEventId) store.updateEvent(ch.openEventId, { end: ev.end });
      ch.openEventId = null;
      send(inp, 'recovered', { cause: ev.cause, start: ev.start, end: ev.end, durationMs: ev.durationMs });
      desktopNotify('recovered', { input: label, durationMs: ev.durationMs });
      if (!anyAlarm()) alarmSound(false);
      log(`${label}: recovered after ${Math.round(ev.durationMs / 1000)} s`, 'info');
      publish.events();
    }
  }

  // Closes an alarm that cannot continue to be observed (monitoring stopped, input removed, process suspended).
  function closeOpenAlarm(ch, end) {
    const open = ch.detector.abort(end);
    if (open && ch.openEventId) store.updateEvent(ch.openEventId, { end: open.end, interrupted: true });
    ch.openEventId = null;
    if (open && !anyAlarm()) alarmSound(false);
    return open;
  }

  function channelStatus(ch) {
    const snap = ch.detector.snapshot(now());
    const waiting = ch.lastSampleAt === null && !ch.fault && now() - ch.startedAt < START_GRACE_MS;
    const state = waiting || snap.status === 'idle' ? 'starting' : snap.status;
    return { state, cause: snap.cause, fault: ch.fault, elapsedMs: snap.elapsedMs, remainingMs: snap.remainingMs, silenceStart: snap.silenceStart };
  }

  function status() {
    const s = settings();
    const inputs = s.inputs.map((inp) => {
      const base = { id: inp.id, name: inputLabel(s.language, inp), type: inp.type, enabled: inp.enabled, thresholdDb: inp.thresholdDb, minSilenceSec: inp.minSilenceSec, channelPair: inp.channelPair };
      const ch = chans.get(inp.id);
      if (!running) return { ...base, state: 'idle' };
      if (!ch) return { ...base, state: inp.enabled ? 'incomplete' : 'off' };
      return { ...base, ...channelStatus(ch) };
    });
    const live = inputs.filter((i) => PRIORITY[i.state]);
    const overall = !running || !live.length ? 'idle' : live.reduce((w, i) => (PRIORITY[i.state] > PRIORITY[w] ? i.state : w), 'ok');
    const count = (st) => live.filter((i) => i.state === st).length;
    return {
      running,
      overall, // idle | starting | ok | counting | alarm: the worst state of any input
      counts: { ok: count('ok'), counting: count('counting'), alarm: count('alarm'), starting: count('starting') },
      inputs,
      startedAt: running ? startedAt : null
    };
  }

  function emitStatus(force = false) {
    const st = status();
    const key = JSON.stringify([st.running, st.inputs.map((i) => [i.id, i.name, i.state, i.fault, i.cause, i.state === 'counting' || i.state === 'alarm' ? Math.floor(i.elapsedMs / 1000) : 0])]);
    if (force || key !== lastStatusKey) {
      lastStatusKey = key;
      publish.status(st);
    }
  }

  function tickChannel(ch, inp, t) {
    const waitingForFirst = ch.lastSampleAt === null && !ch.fault && t - ch.startedAt < START_GRACE_MS;
    if (!waitingForFirst) {
      const stale = ch.lastSampleAt === null || t - ch.lastSampleAt > STALE_MS;
      const level = ch.fault || stale || ch.windowMax === -Infinity ? null : ch.windowMax;
      for (const ev of ch.detector.feed(level, t)) handleEvent(ch, ev);
    }
    ch.windowMax = -Infinity;
    const rem = settings().notifications.reminderMin;
    const snap = ch.detector.snapshot(t);
    if (rem > 0 && snap.status === 'alarm' && t - ch.lastNotifyAt >= rem * 60_000) {
      ch.lastNotifyAt = t;
      send(inp, 'reminder', { cause: snap.cause, start: snap.silenceStart, durationMs: snap.elapsedMs });
    }
  }

  function tick() {
    if (!running) return;
    const t = now();
    if (lastTick && t - lastTick > SUSPEND_MS) {
      // the process did not run (sleep, freeze): what happened in between is unknown
      for (const ch of chans.values()) {
        closeOpenAlarm(ch, lastTick);
        ch.windowMax = -Infinity;
      }
      addGap(lastTick, t, 'suspended');
    }
    lastTick = t;
    for (const ch of chans.values()) {
      const inp = inputById(ch.id);
      if (inp) tickChannel(ch, inp, t);
    }
    if (t - lastHeartbeat >= HEARTBEAT_MS) {
      lastHeartbeat = t;
      store.setMeta({ lastHeartbeat: t, cleanExit: false });
    }
    emitStatus();
  }

  const api = {
    // Called once at program start: closes what the previous run left open and records the gap.
    recoverFromPreviousRun() {
      const meta = store.getMeta();
      const t = now();
      const last = meta.lastHeartbeat;
      for (const e of store.listEvents()) {
        if (e.kind === 'dead-air' && e.end == null) store.updateEvent(e.id, { end: last ?? e.start, interrupted: true });
      }
      if (last && t - last > 60_000) addGap(last, t, meta.cleanExit ? 'quit' : 'unknown');
      store.setMeta({ lastHeartbeat: t, cleanExit: false });
    },

    // Returns false when there is nothing usable to monitor.
    start() {
      if (running) return true;
      const list = activeInputs();
      if (!list.length) return false;
      running = true;
      startedAt = now();
      lastTick = 0;
      lastHeartbeat = 0;
      chans.clear();
      for (const inp of list) chans.set(inp.id, makeChannel(inp, startedAt));
      engine.sync(list.map(engineInput));
      timer = setIntervalFn(tick, TICK_MS);
      emitStatus(true);
      return true;
    },

    stop(cleanExit = true) {
      if (!running) return;
      running = false;
      clearIntervalFn(timer);
      timer = null;
      for (const ch of chans.values()) closeOpenAlarm(ch, now());
      chans.clear();
      engine.stop();
      if (cleanExit) store.setMeta({ lastHeartbeat: now(), cleanExit: true });
      publish.events();
      emitStatus(true);
    },

    // Settings changed while running: inputs added, removed, edited, enabled or disabled.
    syncInputs() {
      if (!running) return;
      const list = activeInputs();
      if (!list.length) return api.stop(true);
      const t = now();
      const keep = new Set(list.map((i) => i.id));
      for (const [id, ch] of chans) {
        if (!keep.has(id)) {
          closeOpenAlarm(ch, t);
          chans.delete(id);
        }
      }
      for (const inp of list) {
        const ch = chans.get(inp.id);
        if (!ch) chans.set(inp.id, makeChannel(inp, t));
        else ch.detector.configure({ thresholdDb: inp.thresholdDb, minSilenceMs: inp.minSilenceSec * 1000 });
      }
      engine.sync(list.map(engineInput));
      emitStatus(true);
    },

    // The engine process crashed and was restarted: samples stop until it is back.
    engineRestarted() {
      const t = now();
      for (const ch of chans.values()) {
        ch.lastSampleAt = null;
        ch.startedAt = t;
      }
    },

    // batch: { [inputId]: { rms: [dB...], peak: [dB...] } }
    onLevels(batch) {
      const t = now();
      for (const [id, r] of Object.entries(batch || {})) {
        const ch = chans.get(id);
        if (!ch) continue;
        const level = loudestChannel(r?.rms);
        ch.lastSampleAt = t;
        if (level !== null && level > ch.windowMax) ch.windowMax = level;
      }
      publish.levels(batch || {});
    },

    onFault(id, reason) {
      const ch = chans.get(id);
      if (!ch) return;
      ch.fault = reason || 'unknown';
      emitStatus(true);
    },

    onOk(id) {
      const ch = chans.get(id);
      if (!ch) return;
      ch.fault = null;
      emitStatus(true);
    },

    engineList: () => activeInputs().map(engineInput),
    tick,
    status,
    isRunning: () => running
  };
  return api;
}
