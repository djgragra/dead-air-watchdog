// Runs renderer/engine.js (the real file) against a stub of the browser audio APIs and checks that a
// stream that stalls and then delivers data again is reported as OK (the "DEAD stays red" bug of 26.10.4).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../renderer/engine.js', import.meta.url), 'utf8');

async function load() {
  const calls = [];
  const handlers = {};
  const audios = [];
  class FakeAudio {
    constructor() { this.paused = true; this.currentTime = 0; audios.push(this); }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute() {}
    load() {}
  }
  const node = () => ({ connect() {}, disconnect() {} });
  class FakeContext {
    constructor() { this.state = 'running'; this.destination = {}; this.audioWorklet = { addModule: () => Promise.resolve() }; }
    createGain() { return { ...node(), gain: {} }; }
    createMediaElementSource() { return node(); }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }
  class FakeWorkletNode { constructor() { this.port = {}; } connect() {} disconnect() {} }
  const api = {
    fault: (id, reason) => calls.push(['fault', id, reason]),
    ok: (id) => calls.push(['ok', id]),
    levels() {},
    ready() {},
    rpcResult() {},
    onSound() {},
    onSync: (f) => (handlers.sync = f),
    onStop: (f) => (handlers.stop = f),
    onRpc() {}
  };
  const sandbox = {
    window: { engineApi: api },
    Audio: FakeAudio,
    AudioContext: FakeContext,
    AudioWorkletNode: FakeWorkletNode,
    navigator: { mediaDevices: { addEventListener() {} } },
    setTimeout, clearTimeout, setInterval, clearInterval, Promise, Math, Object, Number, Map
  };
  vm.runInNewContext(code, sandbox);
  handlers.sync([{ id: 'a', type: 'stream', streamUrl: 'http://x/stream' }]);
  await new Promise((r) => setTimeout(r, 20)); // create() is async
  return { calls, audio: audios[0], stop: handlers.stop };
}

test('stalled then playback time advances again: fault is cleared and ok is reported', async () => {
  const { calls, audio, stop } = await load();
  try {
  audio.onplaying();
  audio.onstalled();
  assert.deepEqual(calls.filter((c) => c[0] === 'fault'), [['fault', 'a', 'stream-stalled']]);
  audio.currentTime = 1; audio.ontimeupdate();
  assert.deepEqual(calls.filter((c) => c[0] === 'ok'), [['ok', 'a']]);
  audio.currentTime = 2; audio.ontimeupdate();
  assert.equal(calls.filter((c) => c[0] === 'ok').length, 1, 'ok is sent once');
  } finally { await stop(); }
});

test('stalled and time does not advance: stays in fault', async () => {
  const { calls, audio, stop } = await load();
  try {
  audio.onstalled();
  audio.ontimeupdate();
  audio.ontimeupdate();
  assert.equal(calls.filter((c) => c[0] === 'ok').length, 0);
  } finally { await stop(); }
});

test('time advancing without a fault sends nothing', async () => {
  const { calls, audio, stop } = await load();
  try {
  audio.onplaying();
  const before = calls.length;
  for (let t = 1; t < 5; t++) { audio.currentTime = t; audio.ontimeupdate(); }
  assert.equal(calls.length, before);
  } finally { await stop(); }
});

test('waiting then playing still clears the fault', async () => {
  const { calls, audio, stop } = await load();
  try {
  audio.onplaying(); // started
  audio.onstalled();
  audio.onwaiting();
  audio.onplaying();
  assert.equal(calls.filter((c) => c[0] === 'ok').length, 1);
  } finally { await stop(); }
});

test('a stream that is slow to start is not given up at 3 s (Winchester 128k: first data after 6.6 s)', async () => {
  const { calls, audio, stop } = await load();
  try {
  audio.onwaiting();
  audio.onstalled();
  await new Promise((r) => setTimeout(r, 3300)); // the old STALL_MS
  assert.equal(calls.filter((c) => c[0] === 'fault').length, 0, 'no fault while the stream is still starting');
  audio.onplaying();
  audio.currentTime = 1; audio.ontimeupdate();
  assert.equal(calls.filter((c) => c[0] === 'fault').length, 0);
  } finally { await stop(); }
});

test('after it has played, a stall of 3 s still disconnects and reports the stream as stopped', async () => {
  const { calls, audio, stop } = await load();
  try {
  audio.onplaying();
  audio.onwaiting();
  await new Promise((r) => setTimeout(r, 3300));
  assert.deepEqual(calls.filter((c) => c[0] === 'fault'), [['fault', 'a', 'stream-stalled']]);
  } finally { await stop(); }
});
