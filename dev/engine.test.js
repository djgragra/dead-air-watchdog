// The Rust engine on its own: protocol, levels, faults, real live streams (MP3, AAC, Ogg Vorbis made by ffmpeg in real time).
import test from 'node:test';
import assert from 'node:assert/strict';
import { enginePath, startEngine, waitFor, haveFfmpeg, liveServer, lumpyProxy, FORMATS } from './helpers.js';

const skip = enginePath ? false : 'engine not built (npm run engine)';
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const tone = (id, script) => ({ id, source: { kind: 'tone', script } });
const batchesOf = (events, id) => events.filter((e) => e.event === 'levels' && e.inputs[id]).map((e) => e.inputs[id]);

test('the engine says hello (protocol 2) and lists the sound cards (maybe none on this machine)', { skip }, async () => {
  const { client, events } = startEngine();
  const ready = await waitFor(client, events, (e) => e.event === 'ready');
  assert.equal(ready.protocol, 2);
  assert.equal(ready.test_sources, true);
  const dev = await client.request({ cmd: 'list_devices' }, 'devices');
  assert.ok(Array.isArray(dev.devices));
  for (const d of dev.devices) assert.ok(typeof d.id === 'string' && typeof d.name === 'string' && d.channels >= 1);
  await client.stop();
});

test('test sources are refused without --test-sources', { skip }, async () => {
  const { client, events } = startEngine([]);
  await waitFor(client, events, (e) => e.event === 'ready');
  client.send({ cmd: 'sync', inputs: [tone('t', [{ ms: 1000, db: -20 }])] });
  const f = await waitFor(client, events, (e) => e.event === 'fault');
  assert.match(f.detail, /not enabled/);
  await client.stop();
});

test('levels come in batches of 100 ms with RMS and peak of both channels, only for inputs that deliver', { skip }, async () => {
  const { client, events } = startEngine();
  await waitFor(client, events, (e) => e.event === 'ready');
  client.send({ cmd: 'sync', inputs: [tone('a', [{ ms: 1500, db: -20 }, { ms: 60_000, db: -120 }])] });
  await waitFor(client, events, (e) => e.event === 'levels' && e.inputs.a && e.inputs.a.rms[0] < -100, 6000);
  const loud = batchesOf(events, 'a').filter((b) => b.rms[0] > -40);
  assert.ok(loud.length >= 8, `only ${loud.length} batches while loud (about 15 expected)`);
  assert.ok(loud.every((b) => near(b.rms[0], -20, 0.5) && near(b.rms[1], -20, 0.5)));
  assert.equal(loud[0].rms.length, 2);
  assert.equal(loud[0].peak.length, 2);
  // no inputs: no batches at all
  client.send({ cmd: 'stop' });
  await new Promise((r) => setTimeout(r, 400));
  const mark = events.length;
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(events.slice(mark).filter((e) => e.event === 'levels').length, 0, 'closed inputs report nothing');
  await client.stop();
});

test('sync opens new inputs, closes the missing ones and keeps the unchanged ones running', { skip }, async () => {
  const { client, events } = startEngine();
  await waitFor(client, events, (e) => e.event === 'ready');
  client.send({ cmd: 'sync', inputs: [tone('a', [{ ms: 60_000, db: -30 }])] });
  await waitFor(client, events, (e) => e.event === 'levels' && e.inputs.a);
  client.send({ cmd: 'sync', inputs: [tone('a', [{ ms: 60_000, db: -30 }]), tone('b', [{ ms: 60_000, db: -45 }])] });
  const both = await waitFor(client, events, (e) => e.event === 'levels' && e.inputs.a && e.inputs.b);
  assert.ok(near(both.inputs.b.rms[0], -45, 0.5));
  client.send({ cmd: 'sync', inputs: [tone('b', [{ ms: 60_000, db: -45 }])] });
  await new Promise((r) => setTimeout(r, 400));
  const mark = events.length;
  await new Promise((r) => setTimeout(r, 500));
  const after = events.slice(mark).filter((e) => e.event === 'levels');
  assert.ok(after.length > 0 && after.every((e) => e.inputs.b && !e.inputs.a), 'only b is reported after a was removed');
  await client.stop();
});

test('a stream that cannot be reached reports a fault "stream-error", tries again and says why', { skip }, async () => {
  const { client, events } = startEngine();
  await waitFor(client, events, (e) => e.event === 'ready');
  client.send({ cmd: 'sync', inputs: [{ id: 's', source: { kind: 'stream', url: 'http://127.0.0.1:9/nothing' } }] });
  const f = await waitFor(client, events, (e) => e.event === 'fault' && e.id === 's');
  assert.equal(f.reason, 'stream-error');
  assert.match(f.detail, /Cannot connect/);
  assert.equal(events.filter((e) => e.event === 'fault').length, 1, 'the same fault is reported once');
  assert.equal(events.filter((e) => e.event === 'levels').length, 0);
  await client.stop();
});

test('a sound card that does not exist reports "NotFoundError"; an id that is not a device of this system too', { skip }, async () => {
  const { client, events } = startEngine();
  await waitFor(client, events, (e) => e.event === 'ready');
  client.send({ cmd: 'sync', inputs: [{ id: 'x', source: { kind: 'device', device_id: 'no-such-device' } }, { id: 'y', source: { kind: 'device', device_id: 'alsa:CARD=Nothing' } }] });
  const x = await waitFor(client, events, (e) => e.event === 'fault' && e.id === 'x');
  const y = await waitFor(client, events, (e) => e.event === 'fault' && e.id === 'y');
  assert.equal(x.reason, 'NotFoundError');
  assert.equal(y.reason, 'NotFoundError');
  await client.stop();
});

test('the engine ends by itself when its parent closes stdin', { skip }, async () => {
  const { client, events } = startEngine();
  await waitFor(client, events, (e) => e.event === 'ready');
  const exited = new Promise((r) => client.once('exit', r));
  client.child.stdin.end();
  const info = await exited;
  assert.equal(info.code, 0);
});

const streamSkip = skip || (haveFfmpeg ? false : 'ffmpeg not installed');
for (const [name, fmt] of Object.entries(FORMATS)) {
  test(`live ${name} stream: the level of the tone, then digital silence`, { skip: streamSkip }, async () => {
    const { server, url } = await liveServer(fmt, { toneSec: 4, silenceSec: 6, peakDb: -20 });
    const { client, events } = startEngine();
    try {
      await waitFor(client, events, (e) => e.event === 'ready');
      client.send({ cmd: 'sync', inputs: [{ id: 's', source: { kind: 'stream', url } }] });
      await waitFor(client, events, (e) => e.event === 'levels' && e.inputs.s && e.inputs.s.rms[0] < -100, 14_000);
      // peak -20 dBFS sine = -23.01 dBFS RMS. The median over the whole tone phase: the first windows hold the start-up
      // of the decoder (a lossy codec needs a moment), a few samples are not enough to judge the level.
      const loud = batchesOf(events, 's').map((b) => b.rms[0]).filter((v) => v > -40).sort((x, y) => x - y);
      assert.ok(loud.length >= 20, `${name}: only ${loud.length} batches during the tone`);
      const mid = loud[Math.floor(loud.length / 2)];
      assert.ok(near(mid, -23.01, 1.5), `${name}: median level ${mid} over ${loud.length} batches`);
      const peak = batchesOf(events, 's').map((b) => b.peak[0]).filter((v) => v > -40).sort((x, y) => x - y);
      assert.ok(near(peak[Math.floor(peak.length / 2)], -20, 1.5), `${name}: peak ${peak[Math.floor(peak.length / 2)]}`);
      assert.equal(events.filter((e) => e.event === 'fault').length, 0, 'no fault while the stream plays');
    } finally {
      await client.stop();
      server.closeAllConnections?.();
      server.close();
    }
  });
}

test('twenty-four live streams at once are all measured (no browser limit of 10 per window and 6 per server)', { skip: streamSkip }, async () => {
  const fmt = FORMATS.mp3;
  const { server, url } = await liveServer(fmt, { toneSec: 30, silenceSec: 0, peakDb: -20 });
  const { client, events } = startEngine();
  try {
    await waitFor(client, events, (e) => e.event === 'ready');
    client.send({ cmd: 'sync', inputs: Array.from({ length: 24 }, (_, i) => ({ id: `s${i}`, source: { kind: 'stream', url } })) });
    // every input reports a level near -23 dBFS within 15 s; all 24 come from one server
    await waitFor(client, events, (e) => {
      if (e.event !== 'levels') return false;
      return Array.from({ length: 24 }, (_, i) => batchesOf(events, `s${i}`).some((b) => near(b.rms[0], -23, 1.5))).every(Boolean);
    }, 20_000);
    assert.equal(events.filter((e) => e.event === 'fault').length, 0);
  } finally {
    await client.stop();
    server.closeAllConnections?.();
    server.close();
  }
});

// Seen on the radio PC (0.6.1 log): a stream arrived in lumps of 128 KB every 5 s (a program between the PC and the server
// holds the data). The engine threw away all but half a second of each lump, and then saw "no audio" for 4 s: yellow and
// red all day. A lump is audio like any other: it is played out at the speed of real time, none of it is lost.
test('a stream that arrives in lumps of five seconds is played out whole: no stall, no gap in the levels', { skip: skip || (!haveFfmpeg && 'ffmpeg not installed') }, async () => {
  const fmt = FORMATS.mp3;
  const { server: origin, url: originUrl } = await liveServer(fmt, { toneSec: 60, silenceSec: 0, peakDb: -20 });
  const { server: proxy, url } = await lumpyProxy(originUrl, 80_000); // 5 s of 128 kbit/s
  const { client, events } = startEngine();
  await waitFor(client, events, (e) => e.event === 'ready');
  client.send({ cmd: 'sync', inputs: [{ id: 'l', source: { kind: 'stream', url } }] });
  await waitFor(client, events, (e) => e.event === 'levels' && e.inputs.l, 20_000);
  const t0 = Date.now();
  const stamps = [];
  client.on('event', (e) => e.event === 'levels' && e.inputs.l && stamps.push(Date.now()));
  await new Promise((r) => setTimeout(r, 28_000));
  const stalls = events.filter((e) => e.event === 'fault' && e.id === 'l');
  let maxGap = 0;
  for (let i = 1; i < stamps.length; i++) maxGap = Math.max(maxGap, stamps[i] - stamps[i - 1]);
  assert.equal(stalls.length, 0, `faults: ${JSON.stringify(stalls)}`);
  assert.ok(maxGap < 1500, `the levels stopped for ${maxGap} ms`);
  assert.ok(stamps.length > 200, `only ${stamps.length} batches in ${(Date.now() - t0) / 1000} s`);
  await client.stop();
  proxy.closeAllConnections?.();
  origin.closeAllConnections?.();
  proxy.close();
  origin.close();
});
