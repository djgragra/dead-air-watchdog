import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createEngineBridge } from '../src/engine-bridge.js';

// A supervisor that answers like the engine: the list of devices on request, the rest is written down.
function fakeSupervisor(devices) {
  const sup = new EventEmitter();
  sup.sent = [];
  sup.requests = 0;
  sup.request = async (cmd, name) => {
    assert.equal(cmd.cmd, 'list_devices');
    assert.equal(name, 'devices');
    sup.requests++;
    return { event: 'devices', devices };
  };
  sup.syncInputs = (inputs) => sup.sent.push(['sync', inputs]);
  sup.stopInputs = () => sup.sent.push(['stop']);
  sup.stop = async () => sup.sent.push(['shutdown']);
  return sup;
}
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const DEVS = [{ id: 'dev:1', name: 'Card One', channels: 8, default: false }, { id: 'dev:2', name: 'Card Two', channels: 2, default: true }];

test('streams go to the engine without asking for the devices; cards are looked up first', async () => {
  const sup = fakeSupervisor(DEVS);
  const bridge = createEngineBridge({ supervisor: sup, getMonitor: () => null, setIntervalFn: () => 1, clearIntervalFn() {} });
  bridge.sync([{ id: 's', type: 'stream', streamUrl: 'http://x/y' }]);
  await wait();
  assert.equal(sup.requests, 0);
  assert.deepEqual(sup.sent[0], ['sync', [{ id: 's', source: { kind: 'stream', url: 'http://x/y' } }]]);
  bridge.sync([{ id: 'c', type: 'device', deviceId: 'dev:1', channelPair: 1, channelMono: 0 }]);
  await wait();
  assert.equal(sup.requests, 1);
  assert.deepEqual(sup.sent[1][1][0].source, { kind: 'device', device_id: 'dev:1', channel_start: 2, channel_count: 2 });
});

test('the same list is not sent twice; a card found later (or an old id found by its label) is sent when it changes', async () => {
  const devices = [];
  const sup = fakeSupervisor(devices);
  let tick;
  const bridge = createEngineBridge({
    supervisor: sup,
    getMonitor: () => null,
    getLabel: () => 'Card One',
    setIntervalFn: (fn) => { tick = fn; return 1; },
    clearIntervalFn() {}
  });
  bridge.sync([{ id: 'c', type: 'device', deviceId: 'old-browser-id', channelPair: 0, channelMono: 0 }]);
  await wait();
  assert.equal(sup.sent.length, 1);
  assert.equal(sup.sent[0][1][0].source.device_id, 'old-browser-id', 'not found yet: asked as saved');
  tick(); // nothing changed
  await wait();
  assert.equal(sup.sent.length, 1, 'the same list is not sent again');
  devices.push(...DEVS); // the card is plugged in
  tick();
  await wait();
  assert.equal(sup.sent.length, 2);
  assert.equal(sup.sent[1][1][0].source.device_id, 'dev:1', 'found by its label');
});

test('the list of devices reaches onDevices (to save the new ids) and the window gets deviceId, label and channels', async () => {
  const sup = fakeSupervisor(DEVS);
  const seen = [];
  const bridge = createEngineBridge({ supervisor: sup, getMonitor: () => null, onDevices: (d) => seen.push(d.length) });
  assert.deepEqual(await bridge.devices(), [{ deviceId: 'dev:1', label: 'Card One', channels: 8 }, { deviceId: 'dev:2', label: 'Card Two', channels: 2 }]);
  assert.deepEqual(seen, [2]);
  assert.equal(await bridge.channels('dev:1'), 8);
  assert.equal(await bridge.channels(''), 2, 'empty id: the default input');
  assert.equal(await bridge.channels('nope'), null);
  await bridge.shutdown();
});

test('events of the engine go to the monitor; a restart tells the monitor; stop closes the inputs and forgets the list', async () => {
  const sup = fakeSupervisor(DEVS);
  const calls = [];
  const monitor = { onLevels: (b) => calls.push(['levels', Object.keys(b)]), onFault: (id, r) => calls.push(['fault', id, r]), onOk: (id) => calls.push(['ok', id]), engineRestarted: () => calls.push(['restarted']) };
  const bridge = createEngineBridge({ supervisor: sup, getMonitor: () => monitor, setIntervalFn: () => 1, clearIntervalFn() {} });
  sup.emit('event', { event: 'levels', inputs: { a: { rms: [-20, -20], peak: [-10, -10] } } });
  sup.emit('event', { event: 'fault', id: 'a', reason: 'device-ended' });
  sup.emit('event', { event: 'ok', id: 'a' });
  sup.emit('restarted', {});
  assert.deepEqual(calls, [['levels', ['a']], ['fault', 'a', 'device-ended'], ['ok', 'a'], ['restarted']]);
  bridge.sync([{ id: 's', type: 'stream', streamUrl: 'http://x/y' }]);
  await wait();
  bridge.stop();
  assert.deepEqual(sup.sent.at(-1), ['stop']);
  bridge.sync([{ id: 's', type: 'stream', streamUrl: 'http://x/y' }]);
  await wait();
  assert.equal(sup.sent.filter((s) => s[0] === 'sync').length, 2, 'after a stop the same list is sent again');
});

test('what the engine says about an input is written to the log, with its name, reason and detail', () => {
  const sup = fakeSupervisor([]);
  const lines = [];
  createEngineBridge({ supervisor: sup, getMonitor: () => null, getName: (id) => (id === 'a' ? 'Station · Nazionale' : ''), log: (m, level) => lines.push([m, level]), setIntervalFn: () => 1, clearIntervalFn() {} });
  sup.emit('event', { event: 'fault', id: 'a', reason: 'stream-stalled', detail: 'No audio for 5 seconds (40 s on this connection, 640 KB received)' });
  sup.emit('event', { event: 'ok', id: 'a' });
  sup.emit('event', { event: 'fault', id: 'zz', reason: 'stream-error', detail: '' });
  assert.deepEqual(lines, [
    ['Station · Nazionale: stream-stalled (No audio for 5 seconds (40 s on this connection, 640 KB received))', 'warn'],
    ['Station · Nazionale: audio is back', 'info'],
    ['zz: stream-error', 'warn']
  ]);
});
