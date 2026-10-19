// Orchestrates all monitored inputs: turns the level reports of the audio engine into detector
// input (one detector per input), writes the event log, sends the alerts, and publishes one
// combined state for the window, the tray and the single audible alarm.
// Everything with side effects is injected so tests can drive it with a fake clock.
import { createDetector } from './core/detector.js';
import { loudestChannel } from './core/level.js';
import { inputLabel, buildAlert, buildGroupAlert } from './messages.js';
import { createGrouper } from './grouping.js';
import { createFrozenDetector } from './core/frozen.js';
import { activeRule, windowEnd } from './core/schedule.js';

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

export function createMonitor({ store, engine, dispatch, publish, desktopNotify = () => {}, alarmSound = () => {}, now = Date.now, host = 'this machine', log = () => {}, setIntervalFn = setInterval, clearIntervalFn = clearInterval, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
  const chans = new Map(); // input id -> channel state
  let running = false;
  let startedAt = 0;
  let lastTick = 0;
  let lastHeartbeat = 0;
  let timer = null;
  let lastStatusKey = '';
  // Alerts for the maintenance of one input: { inputId -> { until, eventId } }, kept in the meta of the store so that a
  // restart does not lift a pause (and the pause still ends by itself at `until`).
  const pauses = new Map(Object.entries(store.getMeta().pauses || {}));
  const savePauses = () => store.setMeta({ pauses: Object.fromEntries(pauses) });

  const settings = () => store.getSettings();
  const inputById = (id) => settings().inputs.find((i) => i.id === id);
  const activeInputs = () => settings().inputs.filter(isUsable);

  // What applies to an input right now: its own values, or those of the monitoring-hours rule that is active.
  // { thresholdDb, minSilenceSec, off, until }: off = nothing is judged (until = when the window ends).
  function effective(inp, t) {
    const rule = activeRule(inp.schedule, t);
    if (!rule) return { thresholdDb: inp.thresholdDb, minSilenceSec: inp.minSilenceSec, off: false, until: null };
    if (rule.mode === 'off') return { thresholdDb: inp.thresholdDb, minSilenceSec: inp.minSilenceSec, off: true, until: windowEnd(rule, t) };
    return { thresholdDb: rule.thresholdDb, minSilenceSec: rule.minSilenceSec, off: false, until: null };
  }

  const frozenOf = (inp) => createFrozenDetector({ frozenMs: (inp.frozenSec || 0) * 1000, toleranceDb: inp.frozenToleranceDb });

  function makeChannel(inp, t) {
    return {
      id: inp.id,
      detector: createDetector({ releaseMs: RELEASE_MS, thresholdDb: inp.thresholdDb, minSilenceMs: inp.minSilenceSec * 1000, yellowDelayMs: inp.yellowDelaySec * 1000, blips: true }),
      frozen: frozenOf(inp), // frozen audio: only fed when the input has frozenSec > 0
      frozenEventId: null,
      eff: effective(inp, t),
      scheduledOff: false,
      startedAt: t,
      lastSampleAt: null,
      windowMax: -Infinity,
      fault: null, // reason string reported by the engine, or null
      openEventId: null,
      lastNotifyAt: 0
    };
  }

  const anyAlarm = () => [...chans.values()].some((c) => c.detector.snapshot(now()).status === 'alarm' || c.frozen.snapshot(now()).alarm);

  function alertData(inp, extra) {
    const s = settings();
    const eff = chans.get(inp.id)?.eff || inp;
    return { input: inputLabel(s.language, inp), thresholdDb: eff.thresholdDb, minSilenceSec: eff.minSilenceSec, frozenSec: inp.frozenSec, frozenToleranceDb: inp.frozenToleranceDb, host, now: now(), ...extra };
  }

  // Several inputs failing (or coming back) together go out as one message (src/grouping.js); a lone one is not delayed.
  const grouper = createGrouper({
    getConfig: () => settings().notifications.grouping,
    send: (m) => dispatch(m),
    buildGroup: (kind, items) => ({ ...buildGroupAlert(settings().language, kind, items, { now: now(), host }), label: `group-${kind}:${items.length}` }),
    setTimer: (fn, ms) => {
      const h = setTimeoutFn(fn, ms);
      h?.unref?.(); // a waiting group never keeps the process alive
      return h;
    },
    clearTimer: clearTimeoutFn
  });

  function send(inp, kind, extra) {
    const lang = settings().language;
    const name = inputLabel(lang, inp);
    const { subject, text } = buildAlert(lang, kind, alertData(inp, extra));
    const single = { subject, text, label: `${kind}:${name}` };
    if (kind === 'alarm' || kind === 'recovered') grouper.submit(kind, { input: name, cause: extra.cause, start: extra.start, end: extra.end, durationMs: extra.durationMs }, single);
    else dispatch(single);
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
    const { thresholdDb, minSilenceSec } = ch.eff;
    if (ev.type === 'alarm') {
      const rec = store.addEvent({ kind: 'dead-air', cause: ev.cause, start: ev.start, end: null, input: label, inputId: inp.id, thresholdDb, minSilenceSec });
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
    } else if (ev.type === 'blip') {
      // a drop below the threshold that ended before the alarm: kept in the log, never sent anywhere
      store.addEvent({ kind: 'blip', cause: ev.cause, start: ev.start, end: ev.end, input: label, inputId: inp.id, thresholdDb, minSilenceSec });
      publish.events();
    }
  }

  // Frozen audio (the level does not move): its own alarm, with its own log entry, next to the one of the silence detector.
  function handleFrozenEvent(ch, ev) {
    const inp = inputById(ch.id);
    if (!inp) return;
    const label = inputLabel(settings().language, inp);
    if (ev.type === 'alarm') {
      const rec = store.addEvent({ kind: 'dead-air', cause: 'frozen', start: ev.start, end: null, input: label, inputId: inp.id, thresholdDb: ch.eff.thresholdDb, minSilenceSec: inp.frozenSec, toleranceDb: inp.frozenToleranceDb });
      ch.frozenEventId = rec.id;
      ch.lastNotifyAt = now();
      send(inp, 'alarm', { cause: 'frozen', start: ev.start });
      desktopNotify('alarm', { input: label });
      alarmSound(true);
      log(`ALARM ${label}: frozen audio since ${new Date(ev.start).toISOString()}`, 'error');
    } else {
      // 'recovered': the level moves again; 'ended': the audio went away (silence or no data have their own alarm)
      if (ch.frozenEventId) store.updateEvent(ch.frozenEventId, { end: ev.end });
      ch.frozenEventId = null;
      if (ev.type === 'recovered') {
        send(inp, 'recovered', { cause: 'frozen', start: ev.start, end: ev.end, durationMs: ev.durationMs });
        desktopNotify('recovered', { input: label, durationMs: ev.durationMs });
        log(`${label}: audio moving again after ${Math.round(ev.durationMs / 1000)} s`, 'info');
      }
      if (!anyAlarm()) alarmSound(false);
    }
    publish.events();
  }

  // Closes an alarm that cannot continue to be observed (monitoring stopped, input removed, process suspended, paused).
  function closeOpenAlarm(ch, end, patch = { interrupted: true }) {
    const open = ch.detector.abort(end);
    if (open && ch.openEventId) store.updateEvent(ch.openEventId, { end: open.end, ...patch });
    ch.openEventId = null;
    const frozen = ch.frozen.reset(end);
    if (frozen && ch.frozenEventId) store.updateEvent(ch.frozenEventId, { end: frozen.end, ...patch });
    ch.frozenEventId = null;
    if ((open || frozen) && !anyAlarm()) alarmSound(false);
    return open || frozen;
  }

  function channelStatus(ch) {
    const p = pauses.get(ch.id);
    if (p && p.until > now()) return { state: 'paused', cause: null, fault: ch.fault, elapsedMs: 0, remainingMs: 0, silenceStart: null, pausedUntil: p.until };
    if (ch.scheduledOff) return { state: 'paused', scheduled: true, cause: null, fault: ch.fault, elapsedMs: 0, remainingMs: 0, silenceStart: null, pausedUntil: ch.eff.until };
    const snap = ch.detector.snapshot(now());
    const fz = ch.frozen.snapshot(now());
    const waiting = ch.lastSampleAt === null && !ch.fault && now() - ch.startedAt < START_GRACE_MS;
    // the traffic light stays green while the silence is shorter than the yellow delay of the input
    const raw = waiting || snap.status === 'idle' ? 'starting' : snap.status;
    if (fz.alarm && raw !== 'alarm') return { state: 'alarm', cause: 'frozen', fault: ch.fault, elapsedMs: fz.elapsedMs, remainingMs: 0, silenceStart: fz.start, thresholdDb: ch.eff.thresholdDb };
    const state = raw === 'counting' && !snap.yellow ? 'ok' : raw;
    return { state, cause: snap.cause, fault: ch.fault, elapsedMs: snap.elapsedMs, remainingMs: snap.remainingMs, silenceStart: snap.silenceStart, thresholdDb: ch.eff.thresholdDb };
  }

  function status() {
    const s = settings();
    const inputs = s.inputs.map((inp) => {
      const base = { id: inp.id, name: inputLabel(s.language, inp), type: inp.type, enabled: inp.enabled, thresholdDb: chans.get(inp.id)?.eff.thresholdDb ?? inp.thresholdDb, minSilenceSec: chans.get(inp.id)?.eff.minSilenceSec ?? inp.minSilenceSec, channelPair: inp.channelPair };
      const p = pauses.get(inp.id);
      if (p && p.until > now()) base.pausedUntil = p.until;
      const ch = chans.get(inp.id);
      if (!running) return { ...base, state: 'idle' };
      if (!ch) return { ...base, state: inp.enabled ? 'incomplete' : 'off' };
      return { ...base, ...channelStatus(ch) };
    });
    const live = inputs.filter((i) => PRIORITY[i.state]);
    const anyPaused = inputs.some((i) => i.state === 'paused');
    const overall = !running ? 'idle' : !live.length ? (anyPaused ? 'paused' : 'idle') : live.reduce((w, i) => (PRIORITY[i.state] > PRIORITY[w] ? i.state : w), 'ok');
    const count = (st) => live.filter((i) => i.state === st).length;
    return {
      running,
      overall, // idle | paused | starting | ok | counting | alarm: the worst state of any input (paused: all of them are)
      counts: { ok: count('ok'), counting: count('counting'), alarm: count('alarm'), starting: count('starting') },
      inputs,
      startedAt: running ? startedAt : null
    };
  }

  function emitStatus(force = false) {
    const st = status();
    const key = JSON.stringify([st.running, st.inputs.map((i) => [i.id, i.name, i.state, i.fault, i.cause, i.pausedUntil || 0, i.thresholdDb, i.state === 'counting' || i.state === 'alarm' ? Math.floor(i.elapsedMs / 1000) : 0])]);
    if (force || key !== lastStatusKey) {
      lastStatusKey = key;
      publish.status(st);
    }
  }

  function tickChannel(ch, inp, t) {
    const p = pauses.get(ch.id);
    if (p) {
      if (p.until > t) {
        ch.windowMax = -Infinity; // measuring goes on in the window, but nothing is judged and nothing is sent
        return;
      }
      api.resumeInput(ch.id, 'expired'); // the pause ends by itself: the countdown starts again from here
    }
    // monitoring hours: outside them nothing is judged (like a pause that ends by itself); a rule can also change the
    // threshold and the time before the alarm for its hours, and the countdown in progress keeps its start
    const eff = effective(inp, t);
    if (eff.off) {
      if (!ch.scheduledOff) {
        ch.scheduledOff = true;
        closeOpenAlarm(ch, t, { scheduled: true }); // an alarm that was open ends here, without a "recovered" message
      }
      ch.eff = eff;
      ch.windowMax = -Infinity;
      return;
    }
    if (ch.scheduledOff) {
      ch.scheduledOff = false;
      ch.detector.abort(t); // the hours start again: the countdown starts again from here
      ch.frozen.reset(t);
    }
    ch.eff = eff;
    ch.detector.configure({ thresholdDb: eff.thresholdDb, minSilenceMs: eff.minSilenceSec * 1000 });
    const waitingForFirst = ch.lastSampleAt === null && !ch.fault && t - ch.startedAt < START_GRACE_MS;
    if (!waitingForFirst) {
      const stale = ch.lastSampleAt === null || t - ch.lastSampleAt > STALE_MS;
      const level = ch.fault || stale || ch.windowMax === -Infinity ? null : ch.windowMax;
      // why a sample without level counts as below: the input is stopped / failed ('nodata'), or the measurement is late ('late')
      const reason = level === null ? (ch.fault ? 'nodata' : 'late') : undefined;
      for (const ev of ch.detector.feed(level, t, reason)) handleEvent(ch, ev);
      if (inp.frozenSec > 0) for (const ev of ch.frozen.feed(level, t, eff.thresholdDb)) handleFrozenEvent(ch, ev);
    }
    ch.windowMax = -Infinity;
    const rem = settings().notifications.reminderMin;
    const snap = ch.detector.snapshot(t);
    const fz = ch.frozen.snapshot(t);
    if (rem > 0 && (snap.status === 'alarm' || fz.alarm) && t - ch.lastNotifyAt >= rem * 60_000) {
      ch.lastNotifyAt = t;
      if (snap.status === 'alarm') send(inp, 'reminder', { cause: snap.cause, start: snap.silenceStart, durationMs: snap.elapsedMs });
      else send(inp, 'reminder', { cause: 'frozen', start: fz.start, durationMs: fz.elapsedMs });
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
    // a pause that reached its end (also of an input that is no longer monitored) is closed in the log
    for (const [id, p] of [...pauses]) if (p.until <= t || !inputById(id)) api.resumeInput(id, p.until <= t ? 'expired' : 'manual');
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
      // a pause survives a restart until its end; one that ended while the app was closed is closed in the log at its end
      for (const e of store.listEvents()) {
        if (e.kind !== 'pause' || e.end != null) continue;
        const p = pauses.get(e.inputId);
        if (p && p.eventId === e.id && p.until > t) continue;
        store.updateEvent(e.id, { end: Math.min(p?.until ?? e.until ?? e.start, t) });
        pauses.delete(e.inputId);
      }
      for (const [id, p] of [...pauses]) if (p.until <= t || !inputById(id)) pauses.delete(id);
      savePauses();
      if (last && t - last > 60_000) addGap(last, t, meta.cleanExit ? 'quit' : 'unknown');
      store.setMeta({ lastHeartbeat: t, cleanExit: false });
    },

    // Maintenance of one input: no alerts, no alarm sound, no alarm events until `untilMs`, then it starts again by
    // itself (it cannot stay off by forgetting). The input is still measured and shown. Written in the log as a pause.
    pauseInput(id, untilMs) {
      const inp = inputById(id);
      const t = now();
      if (!inp || !Number.isFinite(untilMs) || untilMs <= t) return { ok: false };
      const ch = chans.get(id);
      let p = pauses.get(id);
      if (p) p.until = untilMs;
      else {
        const rec = store.addEvent({ kind: 'pause', cause: 'maintenance', start: t, end: null, input: inputLabel(settings().language, inp), inputId: id, until: untilMs });
        p = { until: untilMs, eventId: rec.id };
        pauses.set(id, p);
      }
      store.updateEvent(p.eventId, { until: untilMs });
      if (ch) {
        closeOpenAlarm(ch, t, { pausedBy: true }); // an alarm that was open ends here, without a "recovered" message
        ch.windowMax = -Infinity;
      }
      savePauses();
      publish.events();
      emitStatus(true);
      return { ok: true, until: untilMs };
    },

    resumeInput(id, why = 'manual') {
      const p = pauses.get(id);
      if (!p) return { ok: false };
      const t = now();
      pauses.delete(id);
      store.updateEvent(p.eventId, { end: Math.min(t, why === 'expired' ? p.until : t), ...(why === 'expired' ? { expired: true } : {}) });
      const ch = chans.get(id);
      if (ch) {
        ch.detector.abort(t);
        ch.frozen.reset(t);
        ch.windowMax = -Infinity;
      }
      savePauses();
      publish.events();
      emitStatus(true);
      return { ok: true };
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
      grouper.flush(); // alerts still waiting for their window go out now
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
      for (const id of [...pauses.keys()]) if (!inputById(id)) api.resumeInput(id, 'manual'); // the input was removed
      for (const inp of list) {
        const ch = chans.get(inp.id);
        if (!ch) chans.set(inp.id, makeChannel(inp, t));
        else {
          ch.detector.configure({ yellowDelayMs: inp.yellowDelaySec * 1000 });
          ch.frozen.configure({ frozenMs: (inp.frozenSec || 0) * 1000, toleranceDb: inp.frozenToleranceDb });
          if (!inp.frozenSec) {
            const ended = ch.frozen.reset(t);
            if (ended) handleFrozenEvent(ch, ended);
          }
          // threshold and time before the alarm of the hours that apply are set again at the next tick
          const eff = effective(inp, t);
          ch.eff = eff;
          ch.detector.configure({ thresholdDb: eff.thresholdDb, minSilenceMs: eff.minSilenceSec * 1000 });
        }
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
