// Daily statistics for the silence chart. Pure. Days are local calendar days.

function startOfDay(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function nextDay(dayStart) {
  const d = new Date(dayStart);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(); // DST-safe
}

export function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Returns `days` entries, oldest first, ending with the day of `now`:
//   { date, count, totalMs, longestMs }
// Only dead-air episodes count (not monitoring gaps). An episode that crosses midnight adds its
// time to each day it touches but counts once, on the day it started. An open episode
// (end === null) lasts until `now`.
export function aggregateDeadAir(events, days, now) {
  const last = startOfDay(now);
  const starts = [];
  for (let i = 0, d = last; i < days; i++) {
    starts.unshift(d);
    d = startOfDay(d - 1);
  }
  const buckets = new Map(starts.map((s) => [s, { date: dayKey(s), count: 0, totalMs: 0, longestMs: 0 }]));
  const first = starts[0];
  for (const ev of events) {
    if (ev.kind !== 'dead-air') continue;
    const evEnd = ev.end ?? now;
    if (evEnd < first || ev.start > now) continue;
    let day = startOfDay(Math.max(ev.start, first));
    const startDay = startOfDay(ev.start);
    while (day <= last && day < evEnd) {
      const b = buckets.get(day);
      const from = Math.max(ev.start, day);
      const to = Math.min(evEnd, nextDay(day));
      if (b && to > from) b.totalMs += to - from;
      if (b && day === startDay) {
        b.count += 1;
        b.longestMs = Math.max(b.longestMs, evEnd - ev.start);
      }
      day = nextDay(day);
    }
  }
  return starts.map((s) => buckets.get(s));
}

export function summarize(daily) {
  return {
    count: daily.reduce((n, d) => n + d.count, 0),
    totalMs: daily.reduce((n, d) => n + d.totalMs, 0),
    longestMs: daily.reduce((m, d) => Math.max(m, d.longestMs), 0)
  };
}
