import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, findCommonProblems, minInputsForCommon, periodRange, reportToCsv } from '../src/core/report.js';
import { offIntervals, sanitizeSchedule } from '../src/core/schedule.js';
import { toCsv } from '../src/core/export.js';

const D = (day, h = 0, m = 0, s = 0) => new Date(2026, 9, day, h, m, s).getTime();
let n = 0;
const alarm = (inputId, start, end, cause = 'silence') => ({ id: `e${++n}`, kind: 'dead-air', cause, start, end, input: inputId.toUpperCase(), inputId });
const blip = (inputId, start, end, cause = 'nodata') => ({ id: `e${++n}`, kind: 'blip', cause, start, end, input: inputId.toUpperCase(), inputId });
const inputs = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id.toUpperCase() }));

test('periodRange: this month ends now, last month is whole, last 7 and 30 days start at midnight', () => {
  const now = D(19, 15, 30);
  assert.deepEqual(periodRange('thisMonth', now), { from: D(1), to: now });
  assert.deepEqual(periodRange('lastMonth', now), { from: new Date(2026, 8, 1).getTime(), to: D(1) });
  assert.deepEqual(periodRange('last7', now), { from: D(13), to: now });
  assert.deepEqual(periodRange('last30', now), { from: D(19) - 29 * 86_400_000, to: now });
});

test('availability: down time over the monitored time; alarms, longest and total per input', () => {
  const from = D(1);
  const to = D(11); // 10 days
  const ev = [alarm('a', D(2, 10), D(2, 11)), alarm('a', D(5, 3), D(5, 3, 30)), blip('a', D(6), D(6, 0, 0, 1), 'silence')];
  const r = buildReport(ev, inputs.slice(0, 2), { from, to });
  const a = r.rows[0];
  assert.equal(a.alarms, 2);
  assert.equal(a.downMs, 90 * 60_000);
  assert.equal(a.longestMs, 60 * 60_000);
  assert.equal(a.micro, 1);
  assert.ok(Math.abs(a.availability - (1 - 90 / (10 * 1440)) * 100) < 1e-9);
  assert.equal(r.rows[1].availability, 100);
  assert.equal(r.totals.alarms, 2);
});

test('availability: overlapping alarms count once; an alarm that crosses the period is cut; an open one lasts until now', () => {
  const from = D(1);
  const to = D(2);
  const ev = [alarm('a', D(1, 10), D(1, 12)), alarm('a', D(1, 11), D(1, 13), 'offline'), alarm('a', D(1, 23), D(2, 3)), alarm('b', D(1, 22), null)];
  const r = buildReport(ev, inputs.slice(0, 2), { from, to, now: to });
  assert.equal(r.rows[0].downMs, (3 + 1) * 3_600_000);
  assert.equal(r.rows[0].alarms, 3);
  assert.equal(r.rows[1].downMs, 2 * 3_600_000);
});

test('availability: the time the app was not running, the pauses and the monitoring hours switched off are not counted as monitored', () => {
  const from = D(1);
  const to = D(2); // 24 h
  const ev = [
    { id: 'g', kind: 'gap', cause: 'quit', start: D(1, 0), end: D(1, 6), input: '', inputId: '' },
    { id: 'p', kind: 'pause', cause: 'maintenance', start: D(1, 6), end: D(1, 8), input: 'A', inputId: 'a' },
    alarm('a', D(1, 4), D(1, 7)), // 3 h of which 2 h in the gap and 1 h in the pause: nothing is left
    alarm('a', D(1, 20), D(1, 21))
  ];
  const night = sanitizeSchedule({ enabled: true, rules: [{ days: [4], from: '22:00', to: '23:00', mode: 'off' }] }); // Thursday 1 October 2026
  const r = buildReport(ev, [{ id: 'a', name: 'A', schedule: night }], { from, to });
  assert.equal(r.rows[0].monitoredMs, (24 - 6 - 2 - 1) * 3_600_000);
  assert.equal(r.rows[0].downMs, 3_600_000);
  assert.ok(Math.abs(r.rows[0].availability - (1 - 1 / 15) * 100) < 1e-9);
});

test('availability: nothing monitored is null, not 100', () => {
  const from = D(1);
  const to = D(2);
  const r = buildReport([{ id: 'g', kind: 'gap', cause: 'unknown', start: from, end: to, input: '', inputId: '' }], inputs.slice(0, 1), { from, to });
  assert.equal(r.rows[0].availability, null);
});

test('offIntervals: windows through midnight, only mode off, clipped to the period', () => {
  const s = sanitizeSchedule({ enabled: true, rules: [{ days: [5], from: '22:00', to: '06:00', mode: 'off' }, { days: [5], from: '12:00', to: '13:00', mode: 'custom' }] });
  // Friday 2 October 2026
  assert.deepEqual(offIntervals(s, D(2), D(4)), [[D(2, 22), D(3, 6)]]);
  assert.deepEqual(offIntervals(s, D(3, 1), D(3, 3)), [[D(3, 1), D(3, 3)]], 'starts inside the window of the day before');
  assert.deepEqual(offIntervals({ enabled: false, rules: s.rules }, D(2), D(4)), []);
});

test('common problems: how many inputs are needed', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 10, 32].map(minInputsForCommon), [2, 2, 2, 2, 2, 3, 3]);
});

test('common problems: inputs going down within the window are one problem; far apart or too few are not', () => {
  const together = [alarm('a', D(3, 9, 0, 0), D(3, 9, 5)), alarm('b', D(3, 9, 0, 4), D(3, 9, 6), 'offline'), blip('c', D(3, 9, 0, 8), D(3, 9, 0, 9), 'nodata')];
  const apart = [alarm('a', D(4, 9), D(4, 10)), alarm('b', D(4, 9, 0, 30), D(4, 10))];
  const lone = [alarm('d', D(5, 9), D(5, 10))];
  const r = findCommonProblems([...together, ...apart, ...lone], { windowMs: 10_000, minInputs: 3 });
  assert.equal(r.groups.length, 1);
  assert.deepEqual(r.groups[0].inputIds.sort(), ['a', 'b', 'c']);
  assert.equal(r.groups[0].start, D(3, 9));
  assert.equal(r.eventIds.size, 3);
  // the same with the need for two inputs: the pair 30 s apart is still not together
  assert.equal(findCommonProblems([...together, ...apart], { windowMs: 10_000, minInputs: 2 }).groups.length, 1);
  assert.equal(findCommonProblems([...together, ...apart], { windowMs: 60_000, minInputs: 2 }).groups.length, 2);
});

test('common problems: frozen audio and plain silence micro-silences are not network problems; one input twice is still one input', () => {
  const ev = [alarm('a', D(3, 9), D(3, 10), 'frozen'), alarm('b', D(3, 9, 0, 2), D(3, 10), 'frozen'), blip('c', D(3, 9, 0, 3), D(3, 9, 0, 4), 'silence'), alarm('d', D(3, 9, 0, 3), D(3, 10))];
  assert.equal(findCommonProblems(ev, { minInputs: 2 }).groups.length, 0);
  const twice = [alarm('a', D(3, 9), D(3, 9, 0, 5)), blip('a', D(3, 9, 0, 2), D(3, 9, 0, 3), 'late')];
  assert.equal(findCommonProblems(twice, { minInputs: 2 }).groups.length, 0);
});

test('report: the alarms inside a common problem are counted apart and the availability is also given without them', () => {
  const from = D(1);
  const to = D(2);
  const ev = [alarm('a', D(1, 9, 0, 0), D(1, 9, 30)), alarm('b', D(1, 9, 0, 3), D(1, 9, 30)), alarm('c', D(1, 9, 0, 6), D(1, 9, 30)), alarm('a', D(1, 15), D(1, 15, 30))];
  const r = buildReport(ev, inputs.slice(0, 3), { from, to });
  assert.equal(r.common.length, 1);
  assert.deepEqual(r.common[0].inputs.sort(), ['A', 'B', 'C']);
  assert.equal(r.totals.commonGroups, 1);
  const a = r.rows[0];
  assert.equal(a.alarms, 2);
  assert.equal(a.commonAlarms, 1);
  assert.ok(Math.abs(a.availability - (1 - 60 / 1440) * 100) < 1e-9);
  assert.ok(Math.abs(a.availabilityWithoutCommon - (1 - 30 / 1440) * 100) < 1e-9);
});

test('report CSV: one line per input, formula-safe names, CRLF', () => {
  const r = buildReport([alarm('a', D(1, 1), D(1, 2))], [{ id: 'a', name: '=SUM(1)' }, { id: 'b', name: 'Back, up' }], { from: D(1), to: D(2) });
  const csv = reportToCsv(r);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'input,period_from,period_to,availability_pct,alarms,down_s,longest_s,micro_silences,alarms_in_common_problems,availability_without_common_pct,monitored_s');
  assert.match(lines[1], /^'=SUM\(1\),2026-10-01,2026-10-02,95\.833,1,3600,3600,0,0,95\.833,86400$/);
  assert.match(lines[2], /^"Back, up",2026-10-01,2026-10-02,100\.000,0,0,0,0,0,100\.000,86400$/);
  assert.equal(lines[3], '');
});

test('event log CSV: the column "common_problem" marks the events that belong to one', () => {
  const ev = [alarm('a', D(1, 9), D(1, 10)), alarm('b', D(1, 9), D(1, 10)), alarm('c', D(1, 12), D(1, 13))];
  const common = findCommonProblems(ev, { minInputs: 2 }).eventIds;
  const rows = toCsv(ev, common).split('\r\n');
  assert.match(rows[0], /,common_problem$/);
  assert.match(rows[1], /,yes$/);
  assert.match(rows[2], /,yes$/);
  assert.match(rows[3], /,$/);
  assert.match(toCsv(ev).split('\r\n')[1], /,$/);
});
