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

export const DEFAULTS = Object.freeze({ thresholdDb: -50, minSilenceMs: 30_000, releaseMs: 2_000 });

export function createDetector(options = {}) {
  let cfg = { ...DEFAULTS, ...options };
  let st = fresh();

  function fresh() {
    return { status: 'idle', silenceStart: null, aboveSince: null, cause: null };
  }

  function isBelow(levelDb) {
    return levelDb === null || levelDb === undefined || Number.isNaN(levelDb) || levelDb < cfg.thresholdDb;
  }

  function feed(levelDb, now) {
    const events = [];
    const below = isBelow(levelDb);

    switch (st.status) {
      case 'idle':
      case 'ok':
        if (below) {
          st = { status: 'counting', silenceStart: now, aboveSince: null, cause: null };
        } else {
          st.status = 'ok';
          break;
        }
      // falls through: the countdown may already be due when minSilenceMs is 0
      case 'counting':
        if (below) {
          st.aboveSince = null;
          if (now - st.silenceStart >= cfg.minSilenceMs) {
            st.status = 'alarm';
            st.cause = levelDb === null || levelDb === undefined ? 'offline' : 'silence';
            events.push({ type: 'alarm', start: st.silenceStart, at: now, cause: st.cause });
          }
        } else {
          if (st.aboveSince === null) st.aboveSince = now;
          if (now - st.aboveSince >= cfg.releaseMs) st = { ...fresh(), status: 'ok' };
        }
        break;
      case 'alarm':
        if (below) {
          st.aboveSince = null;
        } else {
          if (st.aboveSince === null) st.aboveSince = now;
          if (now - st.aboveSince >= cfg.releaseMs) {
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
      remainingMs: st.status === 'counting' ? Math.max(0, cfg.minSilenceMs - elapsedMs) : 0
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
