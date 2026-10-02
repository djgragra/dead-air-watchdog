import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateDeadAir, summarize, dayKey } from '../src/core/stats.js';
import { toCsv } from '../src/core/export.js';
import { formatDuration } from '../src/core/format.js';
import { loudestChannel, meanSquareToDb, amplitudeToDb } from '../src/core/level.js';

const at = (y, m, d, h = 0, mi = 0, s = 0) => new Date(y, m - 1, d, h, mi, s).getTime();
const ev = (start, end, extra = {}) => ({ kind: 'dead-air', cause: 'silence', start, end, ...extra });

test('aggregate: counts, totals and longest per local day; empty days are present', () => {
  const now = at(2026, 10, 5, 12);
  const events = [ev(at(2026, 10, 5, 8), at(2026, 10, 5, 8, 1)), ev(at(2026, 10, 5, 9), at(2026, 10, 5, 9, 3)), ev(at(2026, 10, 3, 1), at(2026, 10, 3, 1, 0, 30))];
  const d = aggregateDeadAir(events, 7, now);
  assert.equal(d.length, 7);
  assert.equal(d[6].date, '2026-10-05');
  assert.deepEqual([d[6].count, d[6].totalMs, d[6].longestMs], [2, 240_000, 180_000]);
  assert.deepEqual([d[4].count, d[4].totalMs], [1, 30_000]);
  assert.equal(d[5].count, 0);
  assert.deepEqual(summarize(d), { count: 3, totalMs: 270_000, longestMs: 180_000 });
});

test('aggregate: an episode crossing midnight splits its time but counts once', () => {
  const now = at(2026, 10, 5, 12);
  const d = aggregateDeadAir([ev(at(2026, 10, 4, 23, 59), at(2026, 10, 5, 0, 1))], 3, now);
  assert.deepEqual([d[1].count, d[1].totalMs], [1, 60_000]);
  assert.deepEqual([d[2].count, d[2].totalMs], [0, 60_000]);
});

test('aggregate: open episode lasts until now; gaps and old events are ignored', () => {
  const now = at(2026, 10, 5, 12);
  const events = [ev(at(2026, 10, 5, 11), null), { kind: 'gap', cause: 'quit', start: at(2026, 10, 5, 1), end: at(2026, 10, 5, 2) }, ev(at(2026, 9, 1, 1), at(2026, 9, 1, 2))];
  const d = aggregateDeadAir(events, 7, now);
  assert.equal(d[6].totalMs, 3_600_000);
  assert.equal(summarize(d).count, 1);
});

test('aggregate across a DST change keeps 30 distinct local days', () => {
  const d = aggregateDeadAir([], 30, at(2026, 10, 28, 12));
  assert.equal(new Set(d.map((x) => x.date)).size, 30);
  assert.equal(d[29].date, dayKey(at(2026, 10, 28)));
});

test('csv: header, CRLF, quoting and formula-injection guard', () => {
  const csv = toCsv([ev(at(2026, 10, 5, 8), at(2026, 10, 5, 8, 1), { input: '=cmd|"x", y', thresholdDb: -50, minSilenceSec: 30 })]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0].split(',')[0], 'kind');
  assert.match(lines[1], /"'=cmd\|""x"", y"/);
  assert.match(lines[1], /,60,/);
  assert.equal(lines[2], '');
});

test('formatDuration', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(42_000), '42s');
  assert.equal(formatDuration(125_000), '2m 05s');
  assert.equal(formatDuration(3_725_000), '1h 02m 05s');
});

test('level helpers', () => {
  assert.equal(loudestChannel([-30, -12, -40]), -12);
  assert.equal(loudestChannel([]), null);
  assert.equal(meanSquareToDb(0), -120);
  assert.ok(Math.abs(meanSquareToDb(0.5) - -3.0103) < 1e-3);
  assert.ok(Math.abs(amplitudeToDb(1) - 0) < 1e-9);
});
