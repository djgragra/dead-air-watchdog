// Availability report and "probable common problem" detection from the event log. Pure.
//
// Availability of an input over a period = 1 - (time in dead air) / (period - time that was not monitored). Not
// monitored: the app was not running or the computer was asleep (monitoring gaps), the pauses of that input and its
// monitoring hours switched off. Dead air is every alarm of the input, whatever the cause (silence, offline, frozen).
//
// A "probable common problem" is the moment several inputs go down together: their problems start within a few
// seconds of each other. That points at what they share (the network or the computer that monitors) rather than at
// the servers of the streams, so the report shows it apart and also gives the availability without those episodes.

import { offIntervals } from './schedule.js';

export const COMMON_DEFAULTS = Object.freeze({ windowMs: 10_000 });

// How many inputs must go down together to call it common: three, or all of them when there are fewer (never fewer
// than two), or 30% of the inputs, whichever is the lowest.
export function minInputsForCommon(totalInputs) {
  return Math.max(2, Math.min(3, Math.ceil(totalInputs * 0.3), totalInputs));
}

const startOfDay = (ts) => {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

// kind: 'thisMonth' | 'lastMonth' | 'last7' | 'last30'  ->  { from, to }  (to never later than now)
export function periodRange(kind, now) {
  const d = new Date(now);
  if (kind === 'lastMonth') return { from: new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(), to: new Date(d.getFullYear(), d.getMonth(), 1).getTime() };
  if (kind === 'last7') return { from: startOfDay(now) - 6 * 86_400_000, to: now };
  if (kind === 'last30') return { from: startOfDay(now) - 29 * 86_400_000, to: now };
  return { from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), to: now };
}

// Sorted, merged [start, end] pairs.
function union(pairs) {
  const sorted = pairs.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

const length = (pairs) => pairs.reduce((n, [a, b]) => n + (b - a), 0);

function clip(pairs, from, to) {
  return pairs.map(([a, b]) => [Math.max(a, from), Math.min(b, to)]).filter(([a, b]) => b > a);
}

// pairs minus `holes` (both merged and sorted)
function subtract(pairs, holes) {
  const out = [];
  for (const [a0, b] of pairs) {
    let a = a0;
    for (const [h0, h1] of holes) {
      if (h1 <= a || h0 >= b) continue;
      if (h0 > a) out.push([a, h0]);
      a = Math.max(a, h1);
      if (a >= b) break;
    }
    if (a < b) out.push([a, b]);
  }
  return out;
}

// Events that could be a problem of the network or of the monitoring computer: every alarm except frozen audio (the
// source is what is stuck there), and the micro-silences caused by missing data.
const isCandidate = (e) => (e.kind === 'dead-air' && e.cause !== 'frozen') || (e.kind === 'blip' && (e.cause === 'nodata' || e.cause === 'late'));

// events: the log. options: { windowMs, minInputs, totalInputs }.
// Returns { groups: [{ start, end, inputIds, inputs, events }], eventIds: Set }  eventIds: every event that is part of one.
export function findCommonProblems(events, options = {}) {
  const windowMs = options.windowMs ?? COMMON_DEFAULTS.windowMs;
  const need = options.minInputs ?? minInputsForCommon(options.totalInputs ?? 0);
  const list = events.filter((e) => isCandidate(e) && e.inputId).sort((a, b) => a.start - b.start);
  const groups = [];
  let cur = null;
  const flush = () => {
    if (cur && new Set(cur.map((e) => e.inputId)).size >= need) {
      const ids = [...new Set(cur.map((e) => e.inputId))];
      groups.push({ start: cur[0].start, end: Math.max(...cur.map((e) => e.end ?? e.start)), inputIds: ids, inputs: ids.map((id) => cur.find((e) => e.inputId === id).input), events: cur });
    }
  };
  for (const e of list) {
    if (cur && e.start - cur[0].start <= windowMs) cur.push(e);
    else {
      flush();
      cur = [e];
    }
  }
  flush();
  return { groups, eventIds: new Set(groups.flatMap((g) => g.events.map((e) => e.id))) };
}

// inputs: [{ id, name, schedule }] (the inputs being monitored now). Returns { from, to, rows, totals, common }.
//   rows: per input { inputId, input, alarms, downMs, longestMs, micro, monitoredMs, availability, commonAlarms,
//                     availabilityWithoutCommon }   availability in 0..100, or null when nothing was monitored
export function buildReport(events, inputs, { from, to, now = to, windowMs, minInputs } = {}) {
  const common = findCommonProblems(events, { windowMs, minInputs, totalInputs: inputs.length });
  const gaps = union(clip(events.filter((e) => e.kind === 'gap').map((e) => [e.start, e.end ?? now]), from, to));
  const rows = inputs.map((inp) => {
    const mine = events.filter((e) => e.inputId === inp.id);
    const pauses = clip(mine.filter((e) => e.kind === 'pause').map((e) => [e.start, e.end ?? now]), from, to);
    const unmonitored = union([...gaps, ...pauses, ...offIntervals(inp.schedule, from, to)].map(([a, b]) => [Math.max(a, from), Math.min(b, to)]));
    const monitoredMs = Math.max(0, to - from - length(unmonitored));
    const alarms = mine.filter((e) => e.kind === 'dead-air' && (e.end ?? now) > from && e.start < to);
    const downOf = (list) => length(subtract(union(clip(list.map((e) => [e.start, e.end ?? now]), from, to)), unmonitored));
    const downMs = downOf(alarms);
    const inCommon = alarms.filter((e) => common.eventIds.has(e.id));
    const pct = (down) => (monitoredMs > 0 ? Math.max(0, Math.min(100, (1 - down / monitoredMs) * 100)) : null);
    return {
      inputId: inp.id,
      input: inp.name,
      alarms: alarms.length,
      downMs,
      longestMs: alarms.reduce((m, e) => Math.max(m, Math.min(e.end ?? now, to) - Math.max(e.start, from)), 0),
      micro: mine.filter((e) => e.kind === 'blip' && e.start >= from && e.start < to).length,
      monitoredMs,
      availability: pct(downMs),
      commonAlarms: inCommon.length,
      availabilityWithoutCommon: pct(downOf(alarms.filter((e) => !common.eventIds.has(e.id))))
    };
  });
  const groups = common.groups.filter((g) => g.end >= from && g.start < to);
  return {
    from,
    to,
    rows,
    totals: { alarms: rows.reduce((n, r) => n + r.alarms, 0), downMs: rows.reduce((n, r) => n + r.downMs, 0), longestMs: rows.reduce((m, r) => Math.max(m, r.longestMs), 0), commonGroups: groups.length },
    common: groups.map((g) => ({ start: g.start, end: g.end, inputIds: g.inputIds, inputs: g.inputs })),
    minInputs: minInputs ?? minInputsForCommon(inputs.length),
    windowMs: windowMs ?? COMMON_DEFAULTS.windowMs
  };
}

// CSV (RFC 4180, CRLF) with one line per input; the same protection against formulas as the log export.
const COLUMNS = ['input', 'period_from', 'period_to', 'availability_pct', 'alarms', 'down_s', 'longest_s', 'micro_silences', 'alarms_in_common_problems', 'availability_without_common_pct', 'monitored_s'];
function cell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const day = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const pct = (v) => (v === null ? '' : (Math.round(v * 1000) / 1000).toFixed(3));

export function reportToCsv(report) {
  const lines = [COLUMNS.join(',')];
  for (const r of report.rows) {
    const row = {
      input: r.input,
      period_from: day(report.from),
      period_to: day(report.to),
      availability_pct: pct(r.availability),
      alarms: r.alarms,
      down_s: Math.round(r.downMs / 1000),
      longest_s: Math.round(r.longestMs / 1000),
      micro_silences: r.micro,
      alarms_in_common_problems: r.commonAlarms,
      availability_without_common_pct: pct(r.availabilityWithoutCommon),
      monitored_s: Math.round(r.monitoredMs / 1000)
    };
    lines.push(COLUMNS.map((c) => cell(row[c])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
