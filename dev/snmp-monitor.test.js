// An SNMP input in the monitor: the value of a device is "normal" or an alarm, no answer is offline; the audio engine never sees it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, sanitizeSettings } from '../src/store.js';
import { createMonitor, TICK_MS, isUsable } from '../src/monitor.js';
import { stripSecrets, mapSecrets } from '../src/secrets.js';
import { missingSecrets } from '../src/backup.js';

const DEVA = { id: 'd', name: 'DEVA studio', type: 'snmp', streamUrl: 'snmp://DEVA8000@192.168.1.50', snmpOid: '1.3.6.1.4.1.35833.1.3.1.0', snmpNormal: '1', snmpPollSec: 5, minSilenceSec: 10 };
const ASSET = { id: 'a', name: 'Main', type: 'stream', streamUrl: 'http://radio.example.org/live', minSilenceSec: 10 };

function setup(inputs = [DEVA], patch = {}) {
  const clock = { t: 1_800_000_000_000 };
  const store = createStore({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'daw-')), 'd.json'), now: () => clock.t });
  store.updateSettings({ inputs, ...patch });
  const sent = [];
  const calls = { engine: [], snmp: [], traps: [] };
  const m = createMonitor({
    store,
    engine: { sync: (l) => calls.engine.push(l.map((i) => i.id)), stop: () => {} },
    snmp: { sync: (l) => calls.snmp.push(l), stop: () => calls.snmp.push('stop'), setTraps: (c) => calls.traps.push(c) },
    dispatch: (msg) => sent.push(msg),
    alarmSound: () => {},
    publish: { status: () => {}, events: () => {}, levels: () => {} },
    now: () => clock.t,
    host: 'test-host',
    setIntervalFn: () => 1,
    clearIntervalFn: () => {}
  });
  // `value`: what the device answers at every poll (every 5 s); null = no answer (timeout)
  const advance = (ms, value, id = 'd') => {
    for (let n = 0; n < ms / TICK_MS; n++) {
      clock.t += TICK_MS;
      if (n % 20 === 0) value === null ? m.onSnmp(id, { error: 'timeout' }) : m.onSnmp(id, { value, at: clock.t });
      m.tick();
    }
  };
  return { clock, store, m, sent, calls, advance };
}

test('usable: address and OID are needed', () => {
  assert.ok(isUsable({ ...DEVA, enabled: true }));
  assert.ok(!isUsable({ ...DEVA, enabled: true, snmpOid: '' }));
  assert.ok(!isUsable({ ...DEVA, enabled: true, streamUrl: '' }));
});

test('a value that is normal stays ok; another value held for the time before the alarm is one alarm, then it recovers', () => {
  const { m, store, sent, advance } = setup();
  m.start();
  advance(6000, 1);
  assert.equal(m.status().overall, 'ok');
  assert.equal(m.status().inputs[0].snmpValue, 1);
  advance(6000, 2); // the DEVA went to the backup input
  assert.equal(m.status().overall, 'counting');
  assert.equal(sent.length, 0);
  advance(6000, 2);
  assert.equal(m.status().overall, 'alarm');
  assert.equal(m.status().inputs[0].cause, 'snmp');
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /DEVICE ALERT: DEVA studio/);
  assert.match(sent[0].text, /abnormal state \[2\]/);
  assert.ok(!/threshold|dBFS/i.test(sent[0].text), 'no audio words in an alert about a device');
  assert.ok(!sent[0].text.includes('DEVA8000'), 'the community never appears in an alert');
  const evs = store.listEvents();
  assert.equal(evs.length, 1);
  assert.equal(evs[0].cause, 'snmp');
  advance(6000, 1);
  assert.equal(m.status().overall, 'ok');
  assert.equal(sent.length, 2);
  assert.match(sent[1].subject, /Back to normal/);
  assert.ok(store.listEvents()[0].end > store.listEvents()[0].start);
});

test('several values can be normal (1, 4); a short change is not an alarm', () => {
  const { m, sent, advance } = setup([{ ...DEVA, snmpNormal: '1, 4' }]);
  m.start();
  advance(6000, 4);
  assert.equal(m.status().overall, 'ok');
  advance(4000, 2);
  advance(6000, 1);
  assert.equal(m.status().overall, 'ok');
  assert.equal(sent.length, 0);
});

test('no answer: the device is offline (unreachable) after the time before the alarm, and it recovers when it answers', () => {
  const { m, sent, advance } = setup();
  m.start();
  advance(6000, 1);
  advance(6000, null);
  assert.equal(m.status().overall, 'counting'); // the answers fail: counted at once
  advance(6000, null);
  assert.equal(m.status().overall, 'alarm');
  assert.equal(m.status().inputs[0].cause, 'unreachable');
  assert.match(sent[0].text, /does not answer/);
  advance(6000, 1);
  assert.equal(m.status().overall, 'ok');
});

test('a trap with a value is taken at once', () => {
  const { m, advance } = setup();
  m.start();
  advance(6000, 1);
  m.onSnmpTrap('d', 3);
  m.tick();
  assert.equal(m.status().inputs[0].snmpValue, 3);
  assert.equal(m.status().overall, 'counting');
  m.onSnmpTrap('d', null); // a trap without the watched value changes nothing
  assert.equal(m.status().inputs[0].snmpValue, 3);
});

test('the audio engine gets the audio inputs only; the watcher gets the devices, with the trap settings; stop stops both', () => {
  const { m, calls, store } = setup([ASSET, DEVA], { snmp: { traps: true, trapPort: 2162 } });
  m.start();
  assert.deepEqual(calls.engine.at(-1), ['a']);
  assert.deepEqual(calls.snmp.at(-1), [{ id: 'd', address: 'snmp://DEVA8000@192.168.1.50', oid: '1.3.6.1.4.1.35833.1.3.1.0', pollSec: 5 }]);
  assert.deepEqual(calls.traps.at(-1), { enabled: true, port: 2162 });
  store.updateSettings({ inputs: [ASSET, { ...DEVA, snmpPollSec: 10 }] });
  m.syncInputs();
  assert.equal(calls.snmp.at(-1)[0].pollSec, 10);
  m.stop();
  assert.equal(calls.snmp.at(-1), 'stop');
});

test('an alert pause and the monitoring hours work for a device like for any input', () => {
  const { m, sent, advance, clock } = setup();
  m.start();
  advance(6000, 1);
  m.pauseInput('d', clock.t + 60_000);
  advance(30_000, 2);
  assert.equal(sent.length, 0);
  assert.equal(m.status().inputs[0].state, 'paused');
});

test('settings: an SNMP input keeps no audio options; a bad OID or address is dropped; a stream cannot carry an snmp address', () => {
  const s = sanitizeSettings({ inputs: [{ ...DEVA, alerts: 'indicator', frozenSec: 60, yellowDelaySec: 5, microSilences: 'on' }, { ...DEVA, id: 'x', snmpOid: 'abc', streamUrl: 'http://x' }, { id: 'y', type: 'stream', streamUrl: 'snmp://c@h' }] });
  const [a, b, c] = s.inputs;
  assert.equal(a.type, 'snmp');
  assert.equal(a.alerts, 'on');
  assert.equal(a.frozenSec, 0);
  assert.equal(a.yellowDelaySec, 0);
  assert.equal(a.microSilences, 'off');
  assert.equal(b.snmpOid, '');
  assert.equal(b.streamUrl, '');
  assert.equal(c.streamUrl, '');
  assert.deepEqual(s.snmp, { traps: true, trapPort: 1162 });
  assert.equal(sanitizeSettings({ snmp: { trapPort: 99999 } }).snmp.trapPort, 65535);
  assert.equal(sanitizeSettings({ snmp: { traps: false } }).snmp.traps, false);
});

test('the community is a secret: sealed at rest, left out of a backup, asked again after an import', () => {
  const s = sanitizeSettings({ inputs: [DEVA] });
  const sealed = mapSecrets(s, (v) => `enc:${v}`);
  assert.equal(sealed.inputs[0].streamUrl, 'enc:snmp://DEVA8000@192.168.1.50');
  const { settings, emptied } = stripSecrets(s);
  assert.equal(settings.inputs[0].streamUrl, 'snmp://192.168.1.50');
  assert.deepEqual(emptied, ['input:d']);
  assert.ok(!JSON.stringify(settings).includes('DEVA8000'));
  assert.deepEqual(missingSecrets(settings, emptied).map((m) => m.id), ['input:d']);
});
