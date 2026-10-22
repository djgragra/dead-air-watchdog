// 26.10.10: wording of the alerts chosen by the user (subject and text with {placeholders}).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAlert, buildGroupAlert, withPrefix, alertPrefix } from '../src/messages.js';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../src/store.js';

const D = { input: 'Main', cause: 'silence', start: 1_800_000_000_000, now: 1_800_000_060_000, thresholdDb: -50, minSilenceSec: 10, host: 'PC-REGIA' };

test('no templates: the text of the app, as before', () => {
  const a = buildAlert('en', 'alarm', D);
  assert.equal(a.subject, '[Dead Air Watchdog] DEAD AIR: Main');
  assert.deepEqual(buildAlert('en', 'alarm', D, {}), a);
  assert.deepEqual(buildAlert('en', 'alarm', D, { alarm: { subject: '', body: '' } }), a);
});

test('a custom subject and text: placeholders filled, unknown words left as typed', () => {
  const tpl = { alarm: { subject: 'STOP {input}!', body: '{input} is silent since {start} on {host}. Threshold {threshold}. {nobody}' } };
  const a = buildAlert('it', 'alarm', D, tpl);
  assert.equal(a.subject, '[Dead Air Watchdog] STOP Main!');
  assert.match(a.text, /^Main is silent since .+ on PC-REGIA\. Threshold -50\. \{nobody\}$/);
});

test('only the subject (or only the text) can be customised', () => {
  const only = buildAlert('en', 'reminder', { ...D, durationMs: 120000 }, { reminder: { subject: '', body: 'Still silent: {duration}' } });
  assert.equal(only.subject, '[Dead Air Watchdog] STILL DEAD AIR: Main');
  assert.match(only.text, /^Still silent: \d/);
  const sub = buildAlert('en', 'recovered', { ...D, end: D.now, durationMs: 1000 }, { recovered: { subject: 'Back: {input}', body: '' } });
  assert.equal(sub.subject, '[Dead Air Watchdog] Back: Main');
  assert.match(sub.text, /^Audio is back on "Main"/);
});

test('frozen audio has its own wording; the alarm wording is not used for it', () => {
  const tpl = { alarm: { subject: '', body: 'SILENCE' }, frozen: { subject: '', body: 'FROZEN {seconds} s' } };
  const f = buildAlert('en', 'alarm', { ...D, cause: 'frozen', frozenSec: 60, frozenToleranceDb: 1 }, tpl);
  assert.equal(f.text, 'FROZEN 60 s');
  assert.equal(buildAlert('en', 'alarm', D, tpl).text, 'SILENCE');
});

test('grouped alerts: {n}, {list}, {now}, {host}', () => {
  const items = [{ input: 'A', cause: 'silence', start: D.start }, { input: 'B', cause: 'offline', start: D.start }];
  const g = buildGroupAlert('en', 'alarm', items, { now: D.now, host: 'PC' }, { groupAlarm: { subject: '{n} inputs down', body: 'Down:\n{list}\n{host}' } });
  assert.equal(g.subject, '[Dead Air Watchdog] 2 inputs down');
  assert.match(g.text, /^Down:\n- A: silence.*\n- B: input offline.*\nPC$/);
  const r = buildGroupAlert('en', 'recovered', items, { now: D.now, host: 'PC' }, { groupAlarm: { subject: 'x', body: 'x' } });
  assert.match(r.subject, /Audio back on 2 inputs/);
});

test('the installation name keeps going into a custom subject', () => {
  const a = buildAlert('en', 'alarm', D, { alarm: { subject: 'STOP {input}', body: '' } });
  assert.equal(withPrefix(a.subject, alertPrefix({ installationName: 'Regia 2' })), '[Dead Air Watchdog · Regia 2] STOP Main');
  const own = buildAlert('en', 'alarm', D, { alarm: { subject: '[Dead Air Watchdog] custom', body: '' } });
  assert.equal(own.subject, '[Dead Air Watchdog] custom');
});

test('sanitizeSettings: unknown kinds dropped, empty ones removed, lengths and lines bounded', () => {
  assert.deepEqual(DEFAULT_SETTINGS.notifications.templates, {});
  const s = sanitizeSettings({ notifications: { templates: { alarm: { subject: ' a\nb ', body: 'x'.repeat(9000) }, reminder: { subject: '', body: '' }, nonsense: { subject: 'z' }, recovered: 'text' } } });
  assert.deepEqual(Object.keys(s.notifications.templates), ['alarm']);
  assert.equal(s.notifications.templates.alarm.subject, 'a b');
  assert.equal(s.notifications.templates.alarm.body.length, 4000);
  assert.deepEqual(sanitizeSettings({ notifications: { templates: 'bad' } }).notifications.templates, {});
});
