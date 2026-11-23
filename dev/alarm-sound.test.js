// The audible alarm: continuous, then calm (one beep every few minutes), silenced by the user, started again by a new alarm.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlarmSound } from '../src/alarm-sound.js';

const MIN = 60_000;
function setup(sound = {}) {
  const clock = { t: 1_800_000_000_000 };
  const sent = [];
  const cfg = { enabled: true, volume: 0.6, continuousMin: 0, repeatMin: 10, ...sound };
  const timers = new Set();
  const a = createAlarmSound({
    send: (m) => sent.push(m),
    getSound: () => cfg,
    now: () => clock.t,
    setIntervalFn: (fn) => { const h = { fn }; timers.add(h); return h; },
    clearIntervalFn: (h) => timers.delete(h)
  });
  // advances the clock by `ms`, one second at a time, running the timer like the real one would
  const advance = (ms) => { for (let n = 0; n < ms / 1000; n++) { clock.t += 1000; for (const h of [...timers]) h.fn(); } };
  return { a, cfg, sent, advance, timers, clock };
}
const kinds = (sent) => sent.map((m) => (m.beep ? 'beep' : m.on ? 'on' : 'off'));

test('as before: continuous until the alarm ends, no timer (continuousMin 0)', () => {
  const { a, sent, advance, timers } = setup();
  a.setActive(true);
  assert.deepEqual(kinds(sent), ['on']);
  assert.equal(timers.size, 0);
  advance(60 * MIN);
  assert.deepEqual(kinds(sent), ['on']);
  assert.equal(a.phase(), 'continuous');
  a.setActive(false);
  assert.deepEqual(kinds(sent), ['on', 'off']);
});

test('calms down: continuous for the set time, then one beep every repeat minutes', () => {
  const { a, sent, advance } = setup({ continuousMin: 5, repeatMin: 10 });
  a.setActive(true);
  advance(5 * MIN - 1000);
  assert.deepEqual(kinds(sent), ['on']);
  assert.equal(a.phase(), 'continuous');
  advance(1000); // 5 minutes: the continuous sound ends, the first beep comes at once
  assert.deepEqual(kinds(sent), ['on', 'off', 'beep']);
  assert.equal(a.phase(), 'periodic');
  advance(10 * MIN - 1000);
  assert.deepEqual(kinds(sent), ['on', 'off', 'beep']);
  advance(1000);
  assert.deepEqual(kinds(sent), ['on', 'off', 'beep', 'beep']);
  advance(30 * MIN);
  assert.equal(kinds(sent).filter((k) => k === 'beep').length, 5); // at 5, 15, 25, 35 and 45 minutes
  assert.equal(sent.at(-1).volume, 0.6);
});

test('repeatMin 0: after the continuous time the alarm goes quiet', () => {
  const { a, sent, advance } = setup({ continuousMin: 2, repeatMin: 0 });
  a.setActive(true);
  advance(2 * MIN);
  advance(30 * MIN);
  assert.deepEqual(kinds(sent), ['on', 'off']);
  assert.equal(a.phase(), 'quiet');
  assert.equal(a.sounding(), true); // the alarm is still open: the window keeps showing the silence button
});

test('a new alarm starts the continuous sound again', () => {
  const { a, sent, advance } = setup({ continuousMin: 5, repeatMin: 10 });
  a.setActive(true);
  advance(8 * MIN);
  assert.deepEqual(kinds(sent), ['on', 'off', 'beep']);
  a.setActive(true); // another input fails
  assert.deepEqual(kinds(sent), ['on', 'off', 'beep', 'on']);
  advance(4 * MIN);
  assert.equal(a.phase(), 'continuous');
  advance(1 * MIN);
  assert.equal(kinds(sent).at(-1), 'beep');
});

test('silenced by the user: nothing more until a new alarm; the answer says if something was sounding', () => {
  const { a, sent, advance } = setup({ continuousMin: 5, repeatMin: 10 });
  assert.equal(a.mute(), false); // nothing sounding
  a.setActive(true);
  advance(1 * MIN);
  assert.equal(a.mute(), true);
  assert.deepEqual(kinds(sent), ['on', 'off']);
  advance(30 * MIN);
  assert.deepEqual(kinds(sent), ['on', 'off']);
  assert.equal(a.sounding(), false);
  a.setActive(true);
  assert.deepEqual(kinds(sent), ['on', 'off', 'on']);
});

test('silenced in the calm phase: no more beeps', () => {
  const { a, sent, advance } = setup({ continuousMin: 1, repeatMin: 5 });
  a.setActive(true);
  advance(1 * MIN);
  assert.equal(kinds(sent).at(-1), 'beep');
  assert.equal(a.mute(), true);
  const n = sent.length;
  advance(30 * MIN);
  assert.equal(sent.length, n);
});

test('the sound switched off in the settings: nothing is played, and switching it on again with an alarm open plays it', () => {
  const { a, cfg, sent } = setup({ enabled: false });
  a.setActive(true);
  assert.deepEqual(kinds(sent), []);
  assert.equal(a.sounding(), false);
  cfg.enabled = true;
  a.refresh();
  assert.deepEqual(kinds(sent), ['on']);
  cfg.enabled = false;
  a.refresh();
  assert.deepEqual(kinds(sent), ['on', 'off']);
});

test('changing the times while an alarm is open takes effect; a restarted sound window gets the state again', () => {
  const { a, cfg, sent, advance } = setup();
  a.setActive(true);
  advance(10 * MIN);
  cfg.continuousMin = 5; // already longer: it calms down at once
  a.refresh();
  assert.deepEqual(kinds(sent), ['on', 'off', 'beep']);
  cfg.continuousMin = 0;
  a.refresh();
  assert.equal(kinds(sent).at(-1), 'on');
  a.resend();
  assert.equal(kinds(sent).at(-1), 'on');
  assert.equal(sent.length, 5);
});

import { sanitizeSettings } from '../src/store.js';

test('settings: the times are clamped, the key combination is checked, the Telegram commands are off by default', () => {
  const d = sanitizeSettings({});
  assert.deepEqual(d.notifications.sound, { enabled: false, volume: 0.6, continuousMin: 0, repeatMin: 10, shortcut: '' });
  assert.equal(d.notifications.telegram.commands, false);
  const s = sanitizeSettings({ notifications: { sound: { continuousMin: 99999, repeatMin: -5, shortcut: ' Ctrl+Alt+M ' }, telegram: { commands: true } } });
  assert.equal(s.notifications.sound.continuousMin, 1440);
  assert.equal(s.notifications.sound.repeatMin, 0);
  assert.equal(s.notifications.sound.shortcut, 'Ctrl+Alt+M');
  assert.equal(s.notifications.telegram.commands, true);
  assert.equal(sanitizeSettings({ notifications: { sound: { shortcut: 'Ctrl+<script>' } } }).notifications.sound.shortcut, '');
  assert.equal(sanitizeSettings({ notifications: { telegram: { commands: 'yes' } } }).notifications.telegram.commands, false); // only a real true
});
