// "Frozen audio" detector: the level stays (almost) the same for a long time while it is above the silence threshold.
// A steady test tone, a loop stuck on one cycle, constant noise from a faulty source or a player that repeats a
// buffer never go below the threshold but are not a programme. Pure: time is passed in. Off by default (frozenSec 0).
//
// feed(levelDb, now, thresholdDb): levelDb is the loudest channel in dBFS, or null when the input delivers nothing.
// Samples below the threshold or without level are not frozen audio (silence and offline have their own alarm) and
// start the search again. The level is kept in buckets of one second (lowest and highest value seen), so a long time
// costs little.
//
// Events returned:
//   { type: 'alarm',     start, at }                       the level has varied by at most toleranceDb for frozenMs
//   { type: 'recovered', start, end, durationMs }          the level moves again (by more than twice the tolerance in 4 s)
//   { type: 'ended',     start, end, durationMs }          the alarm ends because the audio went away (silence has its own alarm)

export const FROZEN_DEFAULTS = Object.freeze({ frozenMs: 60_000, toleranceDb: 1 });
const MOVE_WINDOW_MS = 4_000;
const MAX_GAP_MS = 2_000; // samples further apart than this are not one continuous signal

export function createFrozenDetector(options = {}) {
  let cfg = { ...FROZEN_DEFAULTS, ...options };
  let buckets = []; // { sec, min, max }, oldest first
  let lastAt = null;
  let alarm = null; // { start }

  function reset(now) {
    const open = alarm ? { type: 'ended', start: alarm.start, end: now, durationMs: now - alarm.start } : null;
    buckets = [];
    lastAt = null;
    alarm = null;
    return open;
  }

  function range(fromMs) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const b of buckets) {
      if ((b.sec + 1) * 1000 <= fromMs) continue;
      lo = Math.min(lo, b.min);
      hi = Math.max(hi, b.max);
    }
    return hi === -Infinity ? 0 : hi - lo;
  }

  function feed(levelDb, now, thresholdDb) {
    const events = [];
    const usable = typeof levelDb === 'number' && Number.isFinite(levelDb) && levelDb >= thresholdDb;
    if (!usable) {
      const ended = reset(now);
      if (ended) events.push(ended);
      return events;
    }
    if (lastAt !== null && now - lastAt > MAX_GAP_MS) {
      const ended = reset(now);
      if (ended) events.push(ended);
    }
    lastAt = now;
    const sec = Math.floor(now / 1000);
    const last = buckets.at(-1);
    if (last && last.sec === sec) {
      last.min = Math.min(last.min, levelDb);
      last.max = Math.max(last.max, levelDb);
    } else buckets.push({ sec, min: levelDb, max: levelDb });
    const keep = Math.max(cfg.frozenMs, MOVE_WINDOW_MS) + 2000;
    while (buckets.length && now - buckets[0].sec * 1000 > keep) buckets.shift();

    if (!alarm) {
      const spanStart = now - cfg.frozenMs;
      const first = buckets[0];
      // the window must be covered: the first bucket is at or before its start (a one-second bucket of slack)
      if (first && first.sec * 1000 <= spanStart + 1000 && range(spanStart) <= cfg.toleranceDb) {
        alarm = { start: spanStart };
        events.push({ type: 'alarm', start: alarm.start, at: now });
      }
    } else if (range(now - MOVE_WINDOW_MS) > cfg.toleranceDb * 2) {
      events.push({ type: 'recovered', start: alarm.start, end: now, durationMs: now - alarm.start });
      alarm = null;
      buckets = []; // the next search starts here, not in the old frozen stretch
    }
    return events;
  }

  return {
    feed,
    reset,
    configure(next) {
      cfg = { ...cfg, ...next };
    },
    snapshot: (now) => ({ alarm: !!alarm, start: alarm ? alarm.start : null, elapsedMs: alarm ? now - alarm.start : 0 })
  };
}
