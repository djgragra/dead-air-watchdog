// Dead-air state machine. Pure: no timers, no I/O, time is passed in (ms since epoch).
//
//   idle     no sample received yet
//   ok       level at or above the threshold
//   counting level below the threshold for less than minSilenceMs (traffic light: yellow)
//   alarm    below the threshold for at least minSilenceMs (red)
//
// feed(levelDb, now): levelDb is the loudest channel in dBFS, or null when the input delivers
// nothing (device unplugged, stream down, engine stalled): that counts as dead air as well,
// with cause "offline" instead of "silence".
//
// Audio is considered back only after it stays at or above the threshold for releaseMs.
// Without that, a quiet passage with a single loud blip would restart the countdown.
//
// Events returned by feed():
//   { type: 'alarm',     start, at, cause }
//   { type: 'recovered', start, end, durationMs, cause }
// With the option `blips: true` a drop below the threshold that ends before the alarm (the yellow phase, however
// short) is reported too, once audio is back:
//   { type: 'blip',      start, end, durationMs, cause }   cause: 'silence' | 'nodata' | 'late'
// feed() takes a third argument that says why a sample is below the threshold when it carries no level:
// 'nodata' (the input is stopped or failed) or 'late' (no measurement arrived in time); a level that is simply low
// is 'silence'. The cause of a blip is the first of nodata, late, silence that occurred during it. Nothing about the
// alarm changes: it still needs minSilenceMs below the threshold.
//
// "Back" (counting -> ok, alarm -> recovered) needs audio above the threshold for releaseMs in a row, or for releaseMs
// in total within the last ACTIVITY_WINDOW_MS: speech has a pause below the threshold between words, so with only
// the first rule it would never count as audio and the alarm would go off during a programme.
//
// yellowDelayMs: for how long the input must stay below the threshold, without a sample above it, before
// snapshot().yellow turns true (the traffic light stays green until then; an input that delivers no data, or late data,
// is yellow at once: that is not the pause of a speaker). Only the colour changes: the countdown, the
// alarm and the blips are as without it.

export const DEFAULTS = Object.freeze({ thresholdDb: -50, minSilenceMs: 30_000, releaseMs: 2_000, blips: false, yellowDelayMs: 0 });
export const ACTIVITY_WINDOW_MS = 5_000;
const MAX_STEP_MS = 1_000; // a gap between two samples longer than this counts as this much
const BLIP_CAUSES = ['nodata', 'late', 'silence'];

export function createDetector(options = {}) {
  let cfg = { ...DEFAULTS, ...options };
  let st = fresh();

  function fresh() {
    return { status: 'idle', silenceStart: null, quietSince: null, hard: false, aboveSince: null, cause: null, seen: new Set(), recent: [], lastAt: null };
  }

  // True when the audio above the threshold in the last ACTIVITY_WINDOW_MS adds up to releaseMs, in one run or in pieces.
  function activity(above, now) {
    const prev = st.lastAt;
    st.lastAt = now;
    st.recent.push({ at: now, ms: above && prev !== null ? Math.min(now - prev, MAX_STEP_MS) : 0, above });
    while (st.recent.length && now - st.recent[0].at > ACTIVITY_WINDOW_MS) st.recent.shift();
    let total = 0;
    for (const r of st.recent) total += r.ms;
    return total >= cfg.releaseMs;
  }

  function isBelow(levelDb) {
    return levelDb === null || levelDb === undefined || Number.isNaN(levelDb) || levelDb < cfg.thresholdDb;
  }

  function feed(levelDb, now, reason) {
    const events = [];
    const below = isBelow(levelDb);
    const why = reason || (levelDb === null || levelDb === undefined ? 'nodata' : 'silence');

    switch (st.status) {
      case 'idle':
      case 'ok':
        if (below) {
          st = { ...fresh(), status: 'counting', silenceStart: now, quietSince: now };
        } else {
          st.status = 'ok';
          break;
        }
      // falls through: the countdown may already be due when minSilenceMs is 0
      case 'counting':
        if (below) {
          st.seen.add(why);
          if (st.aboveSince !== null) {
            st.quietSince = now; // a new quiet run starts after a sample above the threshold
            st.hard = false;
          }
          if (why !== 'silence') st.hard = true; // no data / late measurements are not the pause of a speaker: yellow at once
          st.aboveSince = null;
          activity(false, now);
          if (now - st.silenceStart >= cfg.minSilenceMs) {
            st.status = 'alarm';
            st.cause = levelDb === null || levelDb === undefined ? 'offline' : 'silence';
            events.push({ type: 'alarm', start: st.silenceStart, at: now, cause: st.cause });
          }
        } else {
          if (st.aboveSince === null) st.aboveSince = now;
          if (activity(true, now)) {
            if (cfg.blips) events.push({ type: 'blip', start: st.silenceStart, end: st.aboveSince, durationMs: st.aboveSince - st.silenceStart, cause: BLIP_CAUSES.find((c) => st.seen.has(c)) || 'silence' });
            st = { ...fresh(), status: 'ok' };
          }
        }
        break;
      case 'alarm':
        if (below) {
          st.aboveSince = null;
          activity(false, now);
        } else {
          if (st.aboveSince === null) st.aboveSince = now;
          if (activity(true, now)) {
            events.push({ type: 'recovered', start: st.silenceStart, end: st.aboveSince, durationMs: st.aboveSince - st.silenceStart, cause: st.cause });
            st = { ...fresh(), status: 'ok' };
          }
        }
        break;
    }
    return events;
  }

  // Parameters can change while running (the countdown keeps its start time).
  function configure(next) {
    cfg = { ...cfg, ...next };
  }

  function snapshot(now) {
    const counting = st.status === 'counting' || st.status === 'alarm';
    const elapsedMs = counting && st.silenceStart !== null ? Math.max(0, now - st.silenceStart) : 0;
    return {
      status: st.status,
      cause: st.cause,
      silenceStart: counting ? st.silenceStart : null,
      elapsedMs,
      remainingMs: st.status === 'counting' ? Math.max(0, cfg.minSilenceMs - elapsedMs) : 0,
      yellow: st.status === 'alarm' || (st.status === 'counting' && (cfg.yellowDelayMs <= 0 || st.hard || (st.aboveSince === null && now - st.quietSince >= cfg.yellowDelayMs)))
    };
  }

  // Monitoring stopped or interrupted (sleep, restart). If an alarm was open it is closed here
  // so that the caller can log it as interrupted; a countdown in progress is simply dropped.
  function abort(now) {
    const open = st.status === 'alarm' ? { type: 'aborted', start: st.silenceStart, end: now, durationMs: now - st.silenceStart, cause: st.cause } : null;
    st = fresh();
    return open;
  }

  return { feed, configure, snapshot, abort, get config() { return { ...cfg }; } };
}
