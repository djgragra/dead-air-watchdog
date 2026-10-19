import test from 'node:test';
import assert from 'node:assert/strict';
import { activeRule, windowEnd, sanitizeSchedule } from '../src/core/schedule.js';

// local times: Monday 19 October 2026 is day 1
const at = (day, hh, mm = 0) => new Date(2026, 9, 18 + day, hh, mm, 0, 0).getTime(); // day 0 = Sunday 18 October
const night = { enabled: true, rules: [{ days: [5, 6], from: '22:00', to: '06:00', mode: 'off' }] };

test('schedule: disabled or without rules means normal monitoring', () => {
  assert.equal(activeRule({ enabled: false, rules: night.rules }, at(5, 23)), null);
  assert.equal(activeRule({ enabled: true, rules: [] }, at(5, 23)), null);
  assert.equal(activeRule(undefined, at(5, 23)), null);
});

test('schedule: a window through midnight belongs to the day it starts on', () => {
  assert.ok(activeRule(night, at(5, 22, 0)), 'Friday 22:00');
  assert.ok(activeRule(night, at(5, 23, 59)));
  assert.ok(activeRule(night, at(6, 0, 0)), 'Saturday 00:00 (Friday night)');
  assert.ok(activeRule(night, at(6, 5, 59)));
  assert.equal(activeRule(night, at(6, 6, 0)), null, 'the window ends at 06:00');
  assert.ok(activeRule(night, at(6, 23, 0)), 'Saturday night');
  assert.ok(activeRule(night, at(7, 3, 0)), 'Sunday 03:00 (Saturday night)');
  assert.equal(activeRule(night, at(1, 3, 0)), null, 'Monday 03:00: Sunday night is not in the list');
  assert.equal(activeRule(night, at(5, 21, 59)), null);
});

test('schedule: a window inside one day, and "from = to" meaning the whole day', () => {
  const lunch = { enabled: true, rules: [{ days: [1], from: '12:00', to: '14:00', mode: 'off' }, { days: [0], from: '00:00', to: '00:00', mode: 'off' }] };
  assert.ok(activeRule(lunch, at(1, 12, 0)));
  assert.equal(activeRule(lunch, at(1, 14, 0)), null);
  assert.equal(activeRule(lunch, at(2, 13, 0)), null);
  assert.ok(activeRule(lunch, at(0, 9, 30)));
  assert.equal(activeRule(lunch, at(0, 9, 30)).mode, 'off');
});

test('schedule: the first matching rule wins and a custom rule carries its own values', () => {
  const s = sanitizeSchedule({ enabled: true, rules: [
    { days: [1], from: '00:00', to: '06:00', mode: 'custom', thresholdDb: -60, minSilenceSec: 120 },
    { days: [1], from: '00:00', to: '12:00', mode: 'off' }
  ] });
  const r = activeRule(s, at(1, 3));
  assert.equal(r.mode, 'custom');
  assert.equal(r.thresholdDb, -60);
  assert.equal(r.minSilenceSec, 120);
  assert.equal(activeRule(s, at(1, 8)).mode, 'off');
});

test('schedule: where the window ends', () => {
  const r = night.rules[0];
  assert.equal(windowEnd(r, at(5, 23)), at(6, 6), 'before midnight: tomorrow 06:00');
  assert.equal(windowEnd(r, at(6, 2)), at(6, 6), 'after midnight: today 06:00');
  assert.equal(windowEnd({ days: [1], from: '12:00', to: '14:00', mode: 'off' }, at(1, 12, 30)), at(1, 14));
  assert.equal(windowEnd({ days: [0], from: '08:00', to: '08:00', mode: 'off' }, at(0, 9)), at(1, 0));
});

test('schedule: sanitize drops bad rules and keeps values in range', () => {
  const s = sanitizeSchedule({ enabled: 'yes', rules: [
    null, { days: [] }, { days: [9] },
    { days: [1, 1, 2, 'x'], from: '7:00', to: '25:00', mode: 'weird', thresholdDb: -200, minSilenceSec: 99999 }
  ] });
  assert.equal(s.enabled, false, 'only true switches it on');
  assert.equal(s.rules.length, 1);
  assert.deepEqual(s.rules[0], { days: [1, 2], from: '00:00', to: '06:00', mode: 'off', thresholdDb: -90, minSilenceSec: 3600 });
  assert.equal(sanitizeSchedule({ rules: new Array(20).fill({ days: [1] }) }).rules.length, 8);
  assert.deepEqual(sanitizeSchedule('nonsense'), { enabled: false, rules: [] });
});
