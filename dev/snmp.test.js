// SNMP inputs: the address, the "normal" list, and the watcher against a simulated device (a net-snmp agent on localhost).
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import netSnmp from 'net-snmp';
import { parseSnmpAddress, buildSnmpAddress, parseNormal, isValidOid, createSnmpWatcher } from '../src/snmp.js';

const OID = '1.3.6.1.4.1.35833.1.3.1'; // audioInput of the DEVA DB8000
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await wait(20);
  }
  return fn();
};
const freePort = () =>
  new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// A device that answers for the audioInput OID with the value in `state.value`.
async function fakeDevice(community = 'DEVA8000') {
  const port = await freePort();
  const state = { value: 1 };
  const agent = netSnmp.createAgent({ port, disableAuthorization: false }, () => {});
  agent.getAuthorizer().addCommunity(community);
  const mib = agent.getMib();
  mib.registerProvider({ name: 'audioInput', type: netSnmp.MibProviderType.Scalar, oid: OID, scalarType: netSnmp.ObjectType.Integer, maxAccess: netSnmp.MaxAccess['read-write'], handler: (m) => { mib.setScalarValue('audioInput', state.value); m.done(); } });
  mib.setScalarValue('audioInput', state.value);
  return { port, state, close: () => agent.close() };
}

test('address: build and parse, community with odd characters, IPv6, default port', () => {
  assert.deepEqual(parseSnmpAddress('snmp://DEVA8000@192.168.1.50'), { community: 'DEVA8000', host: '192.168.1.50', port: 161 });
  assert.deepEqual(parseSnmpAddress('snmp://pub@10.0.0.1:1161'), { community: 'pub', host: '10.0.0.1', port: 1161 });
  const a = { host: 'deva.example.net', port: 161, community: 'p@ss:/ w' };
  assert.deepEqual(parseSnmpAddress(buildSnmpAddress(a)), a);
  assert.equal(buildSnmpAddress({ host: '10.0.0.1', port: 161, community: 'x' }), 'snmp://x@10.0.0.1');
  assert.deepEqual(parseSnmpAddress(buildSnmpAddress({ host: 'fe80::1', port: 162, community: 'c' })), { community: 'c', host: 'fe80::1', port: 162 });
  assert.equal(parseSnmpAddress('http://x'), null);
  assert.equal(parseSnmpAddress('snmp://@'), null);
  assert.equal(parseSnmpAddress('snmp://h:99999'), null);
  assert.equal(buildSnmpAddress({ host: '', community: 'x' }), '');
});

test('OID and the list of normal values', () => {
  assert.ok(isValidOid('1.3.6.1.4.1.35833.1.3.1.0'));
  assert.ok(isValidOid('.1.3.6.1.4.1.35833.1.3.1'));
  assert.ok(!isValidOid('1.3'));
  assert.ok(!isValidOid('abc'));
  assert.deepEqual(parseNormal('1'), [1]);
  assert.deepEqual(parseNormal('1, 4;0'), [1, 4, 0]);
  assert.equal(parseNormal(''), null);
  assert.equal(parseNormal('main'), null);
});

test('polling: the value arrives, and a change is seen at the next poll', async () => {
  const dev = await fakeDevice();
  const got = [];
  const w = createSnmpWatcher({ onResult: (id, r) => got.push([id, r]) });
  w.sync([{ id: 'a', address: `snmp://DEVA8000@127.0.0.1:${dev.port}`, oid: `${OID}.0`, pollSec: 1 }]);
  assert.ok(await until(() => got.length >= 1));
  assert.equal(got[0][0], 'a');
  assert.equal(got[0][1].value, 1);
  dev.state.value = 2;
  assert.ok(await until(() => got.at(-1)[1].value === 2, 3000));
  w.stop();
  dev.close();
});

test('an OID the device does not have is reported, a wrong community times out', async () => {
  const dev = await fakeDevice();
  const got = [];
  const w = createSnmpWatcher({ onResult: (id, r) => got.push([id, r]) });
  w.sync([
    { id: 'nooid', address: `snmp://DEVA8000@127.0.0.1:${dev.port}`, oid: '1.3.6.1.4.1.35833.1.9.9.0', pollSec: 5 },
    { id: 'badcomm', address: `snmp://wrong@127.0.0.1:${dev.port}`, oid: `${OID}.0`, pollSec: 5 }
  ]);
  assert.ok(await until(() => got.some(([id]) => id === 'nooid')));
  assert.equal(got.find(([id]) => id === 'nooid')[1].error, 'no-such-object');
  assert.ok(await until(() => got.some(([id]) => id === 'badcomm'), 6000));
  assert.equal(got.find(([id]) => id === 'badcomm')[1].error, 'timeout');
  w.stop();
  dev.close();
});

test('changing or removing an input closes its session; nothing is polled after stop', async () => {
  const dev = await fakeDevice();
  const got = [];
  const w = createSnmpWatcher({ onResult: (id, r) => got.push([id, r]) });
  const cfg = { id: 'a', address: `snmp://DEVA8000@127.0.0.1:${dev.port}`, oid: `${OID}.0`, pollSec: 1 };
  w.sync([cfg]);
  assert.ok(await until(() => got.length >= 1));
  w.sync([]);
  const n = got.length;
  await wait(1300);
  assert.equal(got.length, n);
  w.sync([cfg]);
  assert.ok(await until(() => got.length > n));
  w.stop();
  const m = got.length;
  await wait(1300);
  assert.equal(got.length, m);
  dev.close();
});

test('traps: a trap from the device is passed on with its value and triggers a poll; one with the wrong community is ignored', async () => {
  const dev = await fakeDevice();
  const trapPort = await freePort();
  const got = [];
  const traps = [];
  const w = createSnmpWatcher({ onResult: (id, r) => got.push([id, r]), onTrap: (id, v) => traps.push([id, v]) });
  w.sync([{ id: 'a', address: `snmp://DEVA8000@127.0.0.1:${dev.port}`, oid: `${OID}.0`, pollSec: 60 }]);
  w.setTraps({ enabled: true, port: trapPort });
  assert.equal(w.trapState().state, 'listening');
  assert.ok(await until(() => got.length >= 1)); // the first poll
  dev.state.value = 3;
  const send = (community) =>
    new Promise((resolve) => {
      const s = netSnmp.createSession('127.0.0.1', community, { port: trapPort, trapPort, version: netSnmp.Version2c });
      s.trap('1.3.6.1.4.1.35833.1.100.0.1', [{ oid: `${OID}.0`, type: netSnmp.ObjectType.Integer, value: 3 }], { upTime: 100 }, () => {
        s.close();
        resolve();
      });
    });
  await send('wrong');
  await wait(300);
  assert.equal(traps.length, 0);
  await send('DEVA8000');
  assert.ok(await until(() => traps.length === 1));
  assert.deepEqual(traps[0], ['a', 3]);
  assert.ok(await until(() => got.at(-1)[1].value === 3)); // the poll after the trap (the interval is 60 s)
  w.setTraps({ enabled: false });
  assert.equal(w.trapState().state, 'off');
  w.stop();
  dev.close();
});

test('the trap port already in use is reported, the polling goes on', async () => {
  const dev = await fakeDevice();
  const taken = dgram.createSocket('udp4');
  await new Promise((r) => taken.bind(0, '0.0.0.0', r));
  const w = createSnmpWatcher({ onResult: () => {}, log: () => {} });
  try {
    w.sync([{ id: 'a', address: `snmp://DEVA8000@127.0.0.1:${dev.port}`, oid: `${OID}.0`, pollSec: 5 }]);
    w.setTraps({ enabled: true, port: taken.address().port });
    assert.ok(await until(() => w.trapState().state === 'error', 2000));
    assert.equal(w.trapState().code, 'EADDRINUSE');
  } finally {
    w.stop();
    taken.close();
    dev.close();
  }
});
