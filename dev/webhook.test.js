// HTTP alerts (src/webhook.js): against a real local HTTP server, from the sender alone up to a stream falling silent.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendWebhook, buildWebhookPayload, webhookGetUrl } from '../src/webhook.js';
import { createStore, sanitizeSettings, DEFAULT_SETTINGS } from '../src/store.js';
import { createMonitor, TICK_MS } from '../src/monitor.js';
import { createDispatcher } from '../src/notifications.js';
import { stripSecrets, mapSecrets } from '../src/secrets.js';
import { missingSecrets } from '../src/backup.js';

function startServer(status = 200) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.statusCode = typeof status === 'function' ? status(hits.length) : status;
      res.end('ok');
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ hits, port: srv.address().port, close: () => new Promise((r) => srv.close(r)) })));
}

const EVENT = { kind: 'alarm', items: [{ input: 'Mount A', cause: 'silence', start: Date.UTC(2026, 9, 21, 8, 0, 0), end: null, durationMs: 45_000 }] };
const MSG = { event: EVENT, subject: '[Dead Air Watchdog] DEAD AIR: Mount A', text: 'Dead air on "Mount A".', installation: 'Studio 1', host: 'pc-1', version: '26.10.9', now: Date.UTC(2026, 9, 21, 8, 0, 45) };

test('POST sends the JSON with the event, the installation, the message and the inputs', async () => {
  const s = await startServer();
  try {
    await sendWebhook({ enabled: true, url: `http://127.0.0.1:${s.port}/alert`, method: 'POST', authHeader: '' }, MSG);
    assert.equal(s.hits.length, 1);
    const h = s.hits[0];
    assert.equal(h.method, 'POST');
    assert.equal(h.url, '/alert');
    assert.match(h.headers['content-type'], /application\/json/);
    assert.match(h.headers['user-agent'], /^Dead-Air-Watchdog\/26\.10\.9$/);
    assert.equal(h.headers.authorization, undefined);
    const p = JSON.parse(h.body);
    assert.equal(p.app, 'Dead Air Watchdog');
    assert.equal(p.event, 'alarm');
    assert.equal(p.installation, 'Studio 1');
    assert.equal(p.host, 'pc-1');
    assert.equal(p.time, '2026-10-21T08:00:45.000Z');
    assert.equal(p.message, 'Dead air on "Mount A".');
    assert.deepEqual(p.inputs, [{ name: 'Mount A', cause: 'silence', since: '2026-10-21T08:00:00.000Z', until: null, durationSec: 45 }]);
  } finally {
    await s.close();
  }
});

test('GET puts the same facts in the query and keeps what is already in the address', async () => {
  const s = await startServer();
  try {
    await sendWebhook({ enabled: true, url: `http://127.0.0.1:${s.port}/hook?key=abc`, method: 'GET', authHeader: 'Bearer t0ken' }, MSG);
    const h = s.hits[0];
    assert.equal(h.method, 'GET');
    assert.equal(h.body, '');
    const u = new URL(h.url, 'http://x');
    assert.equal(u.pathname, '/hook');
    assert.equal(u.searchParams.get('key'), 'abc');
    assert.equal(u.searchParams.get('event'), 'alarm');
    assert.equal(u.searchParams.get('input'), 'Mount A');
    assert.equal(u.searchParams.get('cause'), 'silence');
    assert.equal(u.searchParams.get('count'), '1');
    assert.equal(u.searchParams.get('installation'), 'Studio 1');
    assert.equal(h.headers.authorization, 'Bearer t0ken');
  } finally {
    await s.close();
  }
});

test('a group message lists every input; the test event has its own name', () => {
  const g = buildWebhookPayload({ ...MSG, event: { kind: 'recovered', items: [{ input: 'A', cause: 'nodata', start: 1, end: 2001, durationMs: 2000 }, { input: 'B', cause: 'silence', start: 1, end: 5001, durationMs: 5000 }] } });
  assert.equal(g.event, 'recovered');
  assert.deepEqual(g.inputs.map((i) => [i.name, i.durationSec]), [['A', 2], ['B', 5]]);
  assert.equal(webhookGetUrl('http://h/x', g).includes('count=2'), true);
  assert.equal(buildWebhookPayload({ ...MSG, event: { kind: 'test', items: [] } }).event, 'test');
});

test('a refused request names the status, never the address or the token', async () => {
  const s = await startServer(500);
  try {
    const url = `http://127.0.0.1:${s.port}/secret-path-123`;
    await assert.rejects(sendWebhook({ enabled: true, url, method: 'POST', authHeader: 'Bearer SUPERSECRET' }, MSG), (e) => {
      assert.match(e.message, /HTTP 500/);
      assert.ok(!e.message.includes('secret-path-123') && !e.message.includes('SUPERSECRET') && !e.message.includes(String(s.port)));
      return true;
    });
  } finally {
    await s.close();
  }
  // server not there at all: the error must not repeat the address either
  const url = 'http://127.0.0.1:9/secret-path-456';
  await assert.rejects(sendWebhook({ enabled: true, url, method: 'POST' }, MSG), (e) => !e.message.includes('secret-path-456'));
});

test('switched off sends nothing; a bad address is reported', async () => {
  const s = await startServer();
  try {
    await sendWebhook({ enabled: false, url: `http://127.0.0.1:${s.port}/` }, MSG);
    assert.equal(s.hits.length, 0);
    await assert.rejects(sendWebhook({ enabled: true, url: 'ftp://x/y' }, MSG), /http:\/\/ or https:\/\//);
    await assert.rejects(sendWebhook({ enabled: true, url: '' }, MSG), /http:\/\/ or https:\/\//);
  } finally {
    await s.close();
  }
});

test('settings: defaults, method and limits, url and header are secrets', () => {
  const d = structuredClone(DEFAULT_SETTINGS);
  assert.deepEqual(d.notifications.webhook, { enabled: false, url: '', method: 'POST', authHeader: '' });
  const s = sanitizeSettings({ notifications: { webhook: { enabled: 1, url: ' http://a/b ', method: 'put', authHeader: ' Bearer x ' } } });
  assert.deepEqual(s.notifications.webhook, { enabled: true, url: 'http://a/b', method: 'POST', authHeader: 'Bearer x' });
  assert.equal(sanitizeSettings({ notifications: { webhook: { method: 'GET' } } }).notifications.webhook.method, 'GET');
  const plain = sanitizeSettings({ notifications: { webhook: { enabled: true, url: 'http://a/b?k=1', authHeader: 'Bearer x' } } });
  const sealed = mapSecrets(plain, (v) => 'enc:v1:' + v);
  assert.equal(sealed.notifications.webhook.url, 'enc:v1:http://a/b?k=1');
  assert.equal(sealed.notifications.webhook.authHeader, 'enc:v1:Bearer x');
  const { settings: stripped, emptied } = stripSecrets(plain);
  assert.equal(stripped.notifications.webhook.url, '');
  assert.equal(stripped.notifications.webhook.authHeader, '');
  assert.ok(emptied.includes('webhook.url') && emptied.includes('webhook.authHeader'));
  assert.deepEqual(missingSecrets(stripped, emptied).filter((m) => m.kind.startsWith('webhook')).map((m) => m.id), ['webhook.url']);
});

test('the whole chain: a stream falling silent calls the address for the alarm and for the recovery', async () => {
  const s = await startServer();
  try {
    const clock = { t: 1_800_000_000_000 };
    const store = createStore({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'daw-')), 'd.json'), now: () => clock.t });
    store.updateSettings({
      installationName: 'Studio 1',
      inputs: [{ id: 'a', name: 'Mount A', type: 'stream', streamUrl: 'http://radio.example.org:8000/live', thresholdDb: -50, minSilenceSec: 10 }],
      notifications: { desktop: false, webhook: { enabled: true, url: `http://127.0.0.1:${s.port}/dead-air`, method: 'POST', authHeader: 'Bearer abc' } }
    });
    const results = [];
    const dispatcher = createDispatcher({ getSettings: () => store.getSettings(), host: 'test-host', version: '26.10.9', onResult: (r) => results.push(r), delays: [1, 1], maxAgeMs: 50 });
    const sends = [];
    const m = createMonitor({ store, engine: { sync() {}, stop() {} }, dispatch: (msg) => sends.push(dispatcher.dispatch(msg)), publish: { status() {}, events() {}, levels() {} }, now: () => clock.t, host: 'test-host', setIntervalFn: () => 1, clearIntervalFn: () => {} });
    const advance = (ms, level) => {
      for (let n = 0; n < ms / TICK_MS; n++) {
        clock.t += TICK_MS;
        for (let k = 0; k < 2; k++) m.onLevels({ a: { rms: [level, level], peak: [level, level] } });
        m.tick();
      }
    };
    m.start();
    advance(5000, -20);
    advance(12_000, -90);
    advance(3000, -20);
    await Promise.all(sends);
    assert.equal(s.hits.length, 2);
    const bodies = s.hits.map((h) => JSON.parse(h.body)).sort((a, b) => a.event.localeCompare(b.event));
    assert.deepEqual(bodies.map((b) => b.event), ['alarm', 'recovered']);
    for (const b of bodies) {
      assert.equal(b.installation, 'Studio 1');
      assert.equal(b.host, 'test-host');
      assert.equal(b.version, '26.10.9');
      assert.equal(b.inputs[0].name, 'Mount A');
    }
    assert.ok(bodies[1].inputs[0].until && bodies[1].inputs[0].durationSec > 0);
    assert.ok(s.hits.every((h) => h.headers.authorization === 'Bearer abc'));
    assert.ok(results.every((r) => r.ok));
  } finally {
    await s.close();
  }
});

test('a receiver that fails once is retried until it answers', async () => {
  const s = await startServer((n) => (n === 1 ? 503 : 200));
  try {
    const store = { getSettings: () => ({ language: 'en', installationName: '', notifications: { email: {}, telegram: {}, webhook: { enabled: true, url: `http://127.0.0.1:${s.port}/`, method: 'POST', authHeader: '' } } }) };
    const results = [];
    const d = createDispatcher({ getSettings: store.getSettings, host: 'h', onResult: (r) => results.push(r), delays: [5, 5], maxAgeMs: 2000 });
    assert.equal(await d.dispatch({ subject: 's', text: 't', label: 'x', event: EVENT }), true);
    assert.equal(s.hits.length, 2);
    assert.deepEqual(results.map((r) => [r.channel, r.ok]), [['webhook', false], ['webhook', true]]);
    assert.ok(!JSON.stringify(results).includes(String(s.port)));
  } finally {
    await s.close();
  }
});
