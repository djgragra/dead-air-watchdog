// Event log export (pure). CSV follows RFC 4180 (CRLF, quotes doubled); cells that a spreadsheet
// could read as a formula get a leading apostrophe.

const COLUMNS = ['kind', 'cause', 'start_local', 'end_local', 'start_utc', 'end_utc', 'duration_s', 'input', 'threshold_db', 'min_silence_s', 'interrupted'];

function cell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function local(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function toRows(events) {
  return events.map((e) => ({
    kind: e.kind,
    cause: e.cause,
    start_local: local(e.start),
    end_local: e.end == null ? '' : local(e.end),
    start_utc: new Date(e.start).toISOString(),
    end_utc: e.end == null ? '' : new Date(e.end).toISOString(),
    duration_s: e.end == null ? '' : Math.round((e.end - e.start) / 1000),
    input: e.input || '',
    threshold_db: e.thresholdDb ?? '',
    min_silence_s: e.minSilenceSec ?? '',
    interrupted: e.interrupted ? 'yes' : ''
  }));
}

export function toCsv(events) {
  const lines = [COLUMNS.join(',')];
  for (const row of toRows(events)) lines.push(COLUMNS.map((c) => cell(row[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

export function toJson(events, meta = {}) {
  return JSON.stringify({ app: 'Dead Air Watchdog', exportedAt: new Date().toISOString(), ...meta, events: toRows(events) }, null, 2);
}
