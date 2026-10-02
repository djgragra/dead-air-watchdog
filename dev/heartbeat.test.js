import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeartbeat, validPingUrl } from '../src/heartbeat.js';
import { sanitizeSettings } from '../src/store.js';

const mk = (hb, fetchFn, extra = {}) => {
  const timers = [];
  const h = createHeartbeat({ getSettings: () => ({ heartbeat: hb }), fetchFn, version: '1.2.3', setIntervalFn: (fn, ms) => (timers.push({ fn, ms }), timers.length), clearIntervalFn: () => {}, ...extra });
  return { h, timers };
};
const ok = (calls) => async (url, opts) => (calls.push({ url, opts }), { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) });

test('start pings at once and then every intervalMin minutes', async () => {
  const calls = [];
  const { h, timers } = mk({ enabled: true, url: 'https://ping.example.org/abc', intervalMin: 5 }, ok(calls));
  h.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.method, 'GET');
  assert.equal(calls[0].opts.headers['User-Agent'], 'Dead-Air-Watchdog/1.2.3');
  assert.equal(calls[0].opts.body, undefined);
  assert.equal(timers[0].ms, 300_000);
  assert.equal(h.last().ok, true);
});

test('disabled or invalid URL: nothing is sent', async () => {
  const calls = [];
  mk({ enabled: false, url: 'https://x.example.org/', intervalMin: 5 }, ok(calls)).h.start();
  mk({ enabled: true, url: 'ftp://x', intervalMin: 5 }, ok(calls)).h.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 0);
  assert.equal(validPingUrl('javascript:alert(1)'), false);
  assert.equal(validPingUrl('http://192.168.1.5:8080/push/x?status=up'), true);
});

test('failure is reported without the secret URL', async () => {
  const logs = [];
  const { h } = mk({ enabled: true, url: 'https://ping.example.org/SECRET', intervalMin: 5 }, async () => { throw new Error('connect ECONNREFUSED https://ping.example.org/SECRET'); }, { log: (m) => logs.push(m) });
  h.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.last().ok, false);
  assert.ok(!JSON.stringify(logs).includes('SECRET') && !h.last().error.includes('SECRET'));
});

test('HTTP error status counts as failure; stop clears the timer', async () => {
  const { h } = mk({ enabled: true, url: 'https://ping.example.org/a', intervalMin: 1 }, async () => ({ ok: false, status: 503 }));
  assert.deepEqual(await h.ping(), { ok: false, error: 'HTTP 503' });
  h.start();
  assert.equal(h.isActive(), true);
  h.stop();
  assert.equal(h.isActive(), false);
});

test('settings: new fields are clamped', () => {
  const s = sanitizeSettings({ heartbeat: { enabled: 1, url: ' https://x.example.org/a ', intervalMin: 999 }, notifications: { sound: { enabled: 1, volume: 9 } }, inputs: [{ type: 'device', channelPair: 7 }] });
  assert.deepEqual(s.heartbeat, { enabled: true, url: 'https://x.example.org/a', intervalMin: 60 });
  assert.deepEqual(s.notifications.sound, { enabled: true, volume: 1 });
  assert.equal(s.inputs[0].channelPair, 3);
});
