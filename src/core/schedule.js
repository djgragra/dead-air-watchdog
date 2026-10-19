// Monitoring hours of one input. Pure: time is passed in (ms since epoch), days and hours are local.
//
//   schedule = { enabled, rules: [ { days: [0..6], from: 'HH:MM', to: 'HH:MM', mode: 'off' | 'custom', thresholdDb, minSilenceSec } ] }
//
// days: 0 = Sunday ... 6 = Saturday (Date.getDay). A rule is a window of the day: from <= time < to. When "from" is later
// than "to" the window goes through midnight and belongs to the day it starts on (Friday 22:00-06:00 is Friday night).
// "from" equal to "to" means the whole day. The first rule that matches wins.
//   mode 'off'    nothing is judged, sent or sounded in the window (the input is still measured and shown)
//   mode 'custom' the window has its own threshold and time before the alarm; the rest is as usual

export const MAX_RULES = 8;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const DEFAULT_SCHEDULE = Object.freeze({ enabled: false, rules: [] });

const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

export function sanitizeSchedule(raw, defaults = { thresholdDb: -50, minSilenceSec: 30 }) {
  const clamp = (v, lo, hi, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  const src = raw && typeof raw === 'object' ? raw : {};
  const rules = (Array.isArray(src.rules) ? src.rules : [])
    .slice(0, MAX_RULES)
    .map((r) => {
      if (!r || typeof r !== 'object') return null;
      const days = [...new Set((Array.isArray(r.days) ? r.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
      if (!days.length) return null;
      const from = TIME_RE.test(r.from) ? r.from : '00:00';
      const to = TIME_RE.test(r.to) ? r.to : '06:00';
      const mode = r.mode === 'custom' ? 'custom' : 'off';
      return {
        days,
        from,
        to,
        mode,
        thresholdDb: Math.round(clamp(r.thresholdDb, -90, -10, defaults.thresholdDb)),
        minSilenceSec: Math.round(clamp(r.minSilenceSec, 1, 3600, defaults.minSilenceSec))
      };
    })
    .filter(Boolean);
  return { enabled: src.enabled === true, rules };
}

function matches(rule, ts) {
  const d = new Date(ts);
  const m = d.getHours() * 60 + d.getMinutes();
  const from = toMin(rule.from);
  const to = toMin(rule.to);
  const day = d.getDay();
  if (from === to) return rule.days.includes(day);
  if (from < to) return rule.days.includes(day) && m >= from && m < to;
  return (rule.days.includes(day) && m >= from) || (rule.days.includes((day + 6) % 7) && m < to);
}

// The rule that applies at `ts`, or null (normal monitoring).
export function activeRule(schedule, ts) {
  if (!schedule?.enabled) return null;
  return schedule.rules.find((r) => matches(r, ts)) || null;
}

// When the window of `rule` that contains `ts` ends (ms since epoch).
export function windowEnd(rule, ts) {
  const d = new Date(ts);
  const m = d.getHours() * 60 + d.getMinutes();
  const from = toMin(rule.from);
  const to = toMin(rule.to);
  const at = (dayOffset, minutes) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, Math.floor(minutes / 60), minutes % 60, 0, 0).getTime();
  if (from === to) return at(1, 0);
  if (from < to) return at(0, to);
  return m >= from ? at(1, to) : at(0, to);
}

// The stretches of [fromMs, toMs] in which the monitoring hours of `schedule` switch an input off (mode 'off'), as
// [start, end] pairs, from today's rules (a change of rules is not remembered). Used for the availability report.
export function offIntervals(schedule, fromMs, toMs) {
  if (!schedule?.enabled) return [];
  const out = [];
  const first = new Date(fromMs);
  for (let d = new Date(first.getFullYear(), first.getMonth(), first.getDate() - 1); d.getTime() <= toMs; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    for (const r of schedule.rules) {
      if (r.mode !== 'off' || !r.days.includes(d.getDay())) continue;
      const f = toMin(r.from);
      const t = toMin(r.to);
      const at = (dayOffset, minutes) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, Math.floor(minutes / 60), minutes % 60, 0, 0).getTime();
      const start = at(0, f);
      const end = f === t ? at(1, 0) : f < t ? at(0, t) : at(1, t);
      const a = Math.max(start, fromMs);
      const b = Math.min(end, toMs);
      if (b > a) out.push([a, b]);
    }
  }
  return out;
}
