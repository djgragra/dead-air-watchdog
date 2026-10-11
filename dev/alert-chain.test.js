// The whole chain, from a stream falling silent to the email on the wire:
// monitor -> dispatcher -> sendEmail (real nodemailer) -> a local SMTP server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { createMonitor, TICK_MS } from '../src/monitor.js';
import { createDispatcher } from '../src/notifications.js';
import { startFakeSmtp } from './fake-smtp.js';

const INPUT = { id: 'a', name: 'Mount A', type: 'stream', streamUrl: 'http://radio.example.org:8000/live', thresholdDb: -50, minSilenceSec: 10 };

async function setup({ smtp, emailEnabled = true }) {
  const clock = { t: 1_800_000_000_000 };
  const store = createStore({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'daw-')), 'd.json'), now: () => clock.t });
  store.updateSettings({
    inputs: [INPUT],
    notifications: { desktop: false, email: { enabled: emailEnabled, host: '127.0.0.1', port: smtp.port, secure: false, user: '', pass: '', from: 'watchdog@example.org', recipients: ['one@example.org', 'two@example.org'] } }
  });
  const results = [];
  const dispatcher = createDispatcher({ getSettings: () => store.getSettings(), onResult: (r) => results.push(r), delays: [1, 1], maxAgeMs: 50 });
  const sends = [];
  const m = createMonitor({
    store,
    engine: { sync() {}, stop() {} },
    dispatch: (msg) => sends.push(dispatcher.dispatch(msg)),
    publish: { status() {}, events() {}, levels() {} },
    now: () => clock.t,
    host: 'test-host',
    setIntervalFn: () => 1,
    clearIntervalFn: () => {}
  });
  const advance = (ms, level) => {
    for (let n = 0; n < ms / TICK_MS; n++) {
      clock.t += TICK_MS;
      for (let k = 0; k < 2; k++) m.onLevels({ a: { rms: [level, level], peak: [level, level] } });
      m.tick();
    }
  };
  return { m, advance, sends, results, store };
}

test('a stream going silent and coming back: one email for the alarm and one for the recovery, everybody in Bcc', async () => {
  const smtp = await startFakeSmtp();
  try {
    const { m, advance, sends, results } = await setup({ smtp });
    m.start();
    advance(5000, -20);
    advance(12_000, -90); // silence longer than the 10 s of the input
    advance(3000, -20); // audio back
    await Promise.all(sends);
    assert.equal(smtp.messages.length, 2);
    // two separate connections: the order they land in is not guaranteed
    assert.equal(smtp.messages.filter((x) => /Subject: .*DEAD AIR: Mount A/.test(x.data)).length, 1);
    assert.equal(smtp.messages.filter((x) => /Subject: .*Audio back: Mount A/.test(x.data)).length, 1);
    for (const msg of smtp.messages) assert.deepEqual(msg.to.sort(), ['one@example.org', 'two@example.org', 'watchdog@example.org']);
    assert.ok(results.every((r) => r.ok));
  } finally {
    await smtp.close();
  }
});

test('email switched off in the saved settings: the alarm happens but no email leaves, whatever a Test button said', async () => {
  const smtp = await startFakeSmtp();
  try {
    const { m, advance, sends, results, store } = await setup({ smtp, emailEnabled: false });
    m.start();
    advance(5000, -20);
    advance(12_000, -90);
    await Promise.all(sends);
    assert.equal(store.listEvents().length, 1); // the alarm is in the log
    assert.equal(smtp.messages.length, 0);
    assert.deepEqual(results, []); // and nothing is reported either: this is why the window now warns when a test runs with the channel off or unsaved
  } finally {
    await smtp.close();
  }
});

test('a server that refuses the message: every failure is reported with its reason, then the app gives up and says so', async () => {
  const smtp = await startFakeSmtp({ refuse: true });
  try {
    const { m, advance, sends, results } = await setup({ smtp });
    m.start();
    advance(5000, -20);
    advance(12_000, -90);
    await Promise.all(sends);
    const failed = results.filter((r) => !r.ok && !r.giveUp);
    assert.ok(failed.length >= 1);
    assert.match(failed[0].error, /refused|550|Email not sent/i);
    assert.ok(results.some((r) => r.giveUp && r.channel === 'email'));
  } finally {
    await smtp.close();
  }
});
