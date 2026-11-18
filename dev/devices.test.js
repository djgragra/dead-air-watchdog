import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLabel, resolveDevice, toEngineInputs } from '../src/devices.js';

const devs = [
  { id: 'wasapi:{a}', name: 'Microphone (Realtek High Definition Audio)', channels: 2, default: true },
  { id: 'wasapi:{b}', name: 'Scarlett 18i20 USB', channels: 18 },
  { id: 'wasapi:{c}', name: 'Twin Card', channels: 2 },
  { id: 'wasapi:{d}', name: 'Twin Card', channels: 2 }
];

test('labels: the default marker and the USB ids of the browser are ignored, case and spaces too', () => {
  assert.equal(normalizeLabel('Default - Microphone (Realtek High Definition Audio)'), 'microphone (realtek high definition audio)');
  assert.equal(normalizeLabel('Scarlett 18i20 USB (1235:8212)'), 'scarlett 18i20 usb');
  assert.equal(normalizeLabel('  Communications -  Headset   Mic '), 'headset mic');
  assert.equal(normalizeLabel(''), '');
});

test('a saved id of this system is used as it is; an empty id is the system default input', () => {
  assert.deepEqual(resolveDevice('wasapi:{b}', 'anything', devs), { id: 'wasapi:{b}', via: 'id' });
  assert.deepEqual(resolveDevice('', '', devs), { id: '', via: 'default' });
});

test('an old id (browser engine) is found again by the label, only when exactly one device has it', () => {
  assert.deepEqual(resolveDevice('7f3a9c…', 'Scarlett 18i20 USB (1235:8212)', devs), { id: 'wasapi:{b}', via: 'label' });
  assert.deepEqual(resolveDevice('7f3a9c…', 'Default - Microphone (Realtek High Definition Audio)', devs), { id: 'wasapi:{a}', via: 'label' });
  assert.deepEqual(resolveDevice('7f3a9c…', 'Twin Card', devs), { id: null, via: null }, 'two cards with the same name: never guess');
  assert.deepEqual(resolveDevice('7f3a9c…', 'A card that is gone', devs), { id: null, via: null }, 'never swapped for another card');
  assert.deepEqual(resolveDevice('7f3a9c…', '', devs), { id: null, via: null });
});

test('inputs of the monitor become sources of the engine: streams, pairs, single channels, missing cards', () => {
  const list = [
    { id: 's', type: 'stream', streamUrl: 'http://x/live.mp3' },
    { id: 'd0', type: 'device', deviceId: 'wasapi:{b}', channelPair: 0, channelMono: 0 },
    { id: 'd1', type: 'device', deviceId: 'wasapi:{b}', channelPair: 2, channelMono: 0 },
    { id: 'd2', type: 'device', deviceId: 'wasapi:{b}', channelPair: 0, channelMono: 7 },
    { id: 'd3', type: 'device', deviceId: '', channelPair: 0, channelMono: 0 },
    { id: 'd4', type: 'device', deviceId: 'old-id', channelPair: 0, channelMono: 0 },
    { id: 'd5', type: 'device', deviceId: 'gone', channelPair: 0, channelMono: 0 }
  ];
  const labels = { d4: 'Default - Microphone (Realtek High Definition Audio)', d5: 'Gone card' };
  const out = toEngineInputs(list, devs, (id) => labels[id] || '');
  assert.deepEqual(out[0], { id: 's', source: { kind: 'stream', url: 'http://x/live.mp3' } });
  assert.deepEqual(out[1].source, { kind: 'device', device_id: 'wasapi:{b}', channel_start: 0, channel_count: 2 });
  assert.deepEqual(out[2].source, { kind: 'device', device_id: 'wasapi:{b}', channel_start: 4, channel_count: 2 });
  assert.deepEqual(out[3].source, { kind: 'device', device_id: 'wasapi:{b}', channel_start: 6, channel_count: 1 });
  assert.deepEqual(out[4].source, { kind: 'device', device_id: '', channel_start: 0, channel_count: 2 });
  assert.equal(out[5].source.device_id, 'wasapi:{a}', 'found again by its label');
  assert.equal(out[6].source.device_id, 'gone', 'not found: asked as saved, the engine reports it');
});
