// 26.10.10: several sound cards (and several pairs of one card) open together in the real renderer/engine.js,
// against a stub of the browser audio APIs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../renderer/engine.js', import.meta.url), 'utf8');

async function load(channelsOf) {
  const calls = [];
  const links = [];
  const asked = [];
  const handlers = {};
  const node = () => ({ connect() {}, disconnect() {} });
  class FakeContext {
    constructor() { this.state = 'running'; this.destination = {}; this.audioWorklet = { addModule: () => Promise.resolve() }; }
    createGain() { return { ...node(), gain: {} }; }
    createMediaStreamSource() { return node(); }
    createChannelSplitter() { return { connect: (to, out, inp) => links.push([out, inp]), disconnect() {} }; }
    createChannelMerger() { return node(); }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }
  class FakeWorkletNode { constructor() { this.port = {}; } connect() {} disconnect() {} }
  const getUserMedia = async ({ audio }) => {
    const id = audio.deviceId?.exact;
    if (id && !(id in channelsOf)) {
      const e = new Error('no such device');
      e.name = 'OverconstrainedError';
      throw e;
    }
    asked.push({ id: id || '', channels: audio.channelCount.ideal });
    const have = Math.min(audio.channelCount.ideal, channelsOf[id] ?? 2);
    return { getTracks: () => [{ stop() {} }], getAudioTracks: () => [{ getSettings: () => ({ channelCount: have }) }] };
  };
  const api = {
    fault: (id, reason) => calls.push(['fault', id, reason]),
    ok: (id) => calls.push(['ok', id]),
    levels() {}, ready() {}, rpcResult() {}, onSound() {},
    onSync: (f) => (handlers.sync = f), onStop: (f) => (handlers.stop = f), onRpc() {}
  };
  const sandbox = {
    window: { engineApi: api }, AudioContext: FakeContext, AudioWorkletNode: FakeWorkletNode,
    navigator: { mediaDevices: { addEventListener() {}, getUserMedia } },
    setTimeout, clearTimeout, setInterval, clearInterval, Promise, Math, Object, Number, Map
  };
  vm.runInNewContext(code, sandbox);
  return { calls, asked, links, sync: async (list) => { handlers.sync(list); await new Promise((r) => setTimeout(r, 30)); }, stop: handlers.stop };
}
const dev = (id, deviceId, channelPair = 0) => ({ id, type: 'device', deviceId, channelPair });

test('eight sound cards open together', async () => {
  const cards = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`usb-${i}`, 2]));
  const { calls, asked, sync, stop } = await load(cards);
  try {
    await sync(Array.from({ length: 8 }, (_, i) => dev('in' + i, `usb-${i}`)));
    assert.equal(asked.length, 8);
    assert.deepEqual(asked.map((a) => a.id).sort(), Array.from({ length: 8 }, (_, i) => `usb-${i}`).sort());
    assert.equal(calls.length, 0, 'no fault: an input that opens at once reports nothing');
  } finally { await stop(); }
});

test('one device, three pairs: all three open and ask for the same number of channels (the most any needs)', async () => {
  const { calls, asked, sync, stop } = await load({ dante: 8 });
  try {
    await sync([dev('p1', 'dante', 0), dev('p2', 'dante', 1), dev('p4', 'dante', 3)]);
    assert.deepEqual(asked.map((a) => a.channels), [8, 8, 8]);
    assert.equal(calls.length, 0);
  } finally { await stop(); }
});

test('a device with one pair only still asks for 2 channels, as before', async () => {
  const { asked, sync, stop } = await load({ card: 2 });
  try {
    await sync([dev('a', 'card', 0)]);
    assert.deepEqual(asked.map((a) => a.channels), [2]);
  } finally { await stop(); }
});

test('a saved device that is no longer there is reported, and the other inputs are not touched', async () => {
  const { calls, sync, stop } = await load({ present: 2 });
  try {
    await sync([dev('gone', 'was-here-yesterday'), dev('ok', 'present')]);
    assert.deepEqual(calls.filter((c) => c[0] === 'fault'), [['fault', 'gone', 'OverconstrainedError']]);
    assert.equal(calls.filter((c) => c[1] === 'ok').length, 0, 'the present device has no fault');
  } finally { await stop(); }
});

test('a pair the device does not have is reported as ChannelsUnavailable', async () => {
  const { calls, sync, stop } = await load({ stereo: 2 });
  try {
    await sync([dev('x', 'stereo', 2)]);
    assert.deepEqual(calls.filter((c) => c[0] === 'fault'), [['fault', 'x', 'ChannelsUnavailable']]);
  } finally { await stop(); }
});

const mono = (id, deviceId, channelMono) => ({ id, type: 'device', deviceId, channelPair: 0, channelMono });

test('26.11.2: one single channel is measured, on both sides, and the device is asked for enough channels', async () => {
  const { calls, asked, links, sync, stop } = await load({ dante: 8 });
  try {
    await sync([mono('m5', 'dante', 5)]);
    assert.deepEqual(asked.map((a) => a.channels), [5]);
    assert.deepEqual(links, [[4, 0], [4, 1]], 'channel 5 (index 4) feeds both sides of the meter');
    assert.equal(calls.length, 0);
  } finally { await stop(); }
});

test('26.11.2: channel 1 alone needs 2 channels as before; a mono and a pair of one device ask for the same number', async () => {
  const one = await load({ card: 2 });
  try {
    await one.sync([mono('a', 'card', 1)]);
    assert.deepEqual(one.asked.map((a) => a.channels), [2]);
    assert.deepEqual(one.links, [[0, 0], [0, 1]]);
  } finally { await one.stop(); }
  const both = await load({ dante: 8 });
  try {
    await both.sync([mono('m3', 'dante', 3), dev('p4', 'dante', 3)]);
    assert.deepEqual(both.asked.map((a) => a.channels), [8, 8]);
  } finally { await both.stop(); }
});

test('26.11.2: channels up to 16 (a 16-channel virtual card): channel 16 alone and pair 15-16', async () => {
  const { calls, asked, links, sync, stop } = await load({ virt: 16 });
  try {
    await sync([mono('m16', 'virt', 16), dev('p8', 'virt', 7)]);
    assert.deepEqual(asked.map((a) => a.channels), [16, 16]);
    assert.deepEqual(links, [[15, 0], [15, 1], [14, 0], [15, 1]]);
    assert.equal(calls.length, 0);
  } finally { await stop(); }
});

test('26.11.2: a channel the device does not have is reported as ChannelsUnavailable', async () => {
  const { calls, sync, stop } = await load({ stereo: 2 });
  try {
    await sync([mono('x', 'stereo', 6)]);
    assert.deepEqual(calls.filter((c) => c[0] === 'fault'), [['fault', 'x', 'ChannelsUnavailable']]);
  } finally { await stop(); }
});
