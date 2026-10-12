import test from 'node:test';
import assert from 'node:assert/strict';
import { wallGrid } from '../src/core/wall-grid.js';
import { shardInputs, STREAMS_PER_ENGINE } from '../src/engine-shards.js';

test('wallGrid: every number of inputs from 1 to 32 fits the screen, on any window shape', () => {
  for (const [w, h] of [[1920, 1000], [1280, 700], [3840, 2000], [800, 600], [1000, 1400]]) {
    for (let n = 1; n <= 32; n++) {
      const { cols, rows } = wallGrid(n, w, h);
      assert.ok(cols >= 1 && rows >= 1, `${n} in ${w}x${h}`);
      assert.ok(cols * rows >= n, `${n} inputs need ${n} cells, got ${cols}x${rows} in ${w}x${h}`);
      assert.ok(cols * rows < n + Math.max(cols, rows), `no empty row or column: ${n} -> ${cols}x${rows}`);
    }
  }
});

test('wallGrid: familiar shapes on a 16:9 screen', () => {
  assert.deepEqual(wallGrid(1, 1920, 1000), { cols: 1, rows: 1 });
  assert.deepEqual(wallGrid(2, 1920, 1000), { cols: 2, rows: 1 });
  assert.deepEqual(wallGrid(4, 1920, 1000), { cols: 2, rows: 2 });
  const g12 = wallGrid(12, 1920, 1000);
  assert.ok(g12.cols >= 4 && g12.cols * g12.rows >= 12);
  const g32 = wallGrid(32, 1920, 1000);
  assert.ok(g32.cols >= 6 && g32.rows <= 6, `32 tiles: ${g32.cols}x${g32.rows}`);
});

test('wallGrid: nonsense sizes do not break it', () => {
  assert.deepEqual(wallGrid(0, 100, 100), { cols: 1, rows: 1 });
  assert.deepEqual(wallGrid(5, 0, 0), { cols: 1, rows: 1 });
});

const stream = (id) => ({ id, type: 'stream', streamUrl: `http://radio.example.org/${id}` });
const device = { id: 'dev', type: 'device' };

test('engine windows: up to 6 streams stay in one window, exactly as before', () => {
  assert.equal(shardInputs([]).length, 1);
  assert.equal(shardInputs(['a', 'b', 'c', 'd', 'e', 'f'].map(stream)).length, 1);
});

test('engine windows: 12 streams (the reported case) take two windows, 32 take six, none has more than 6', () => {
  const twelve = shardInputs(Array.from({ length: 12 }, (_, i) => stream('s' + i)));
  assert.deepEqual(twelve.map((s) => s.length), [6, 6]);
  const all = shardInputs(Array.from({ length: 32 }, (_, i) => stream('s' + i)));
  assert.equal(all.length, Math.ceil(32 / STREAMS_PER_ENGINE));
  assert.ok(all.every((s) => s.length <= STREAMS_PER_ENGINE));
  assert.equal(all.flat().length, 32); // nobody lost, nobody twice
  assert.equal(new Set(all.flat().map((i) => i.id)).size, 32);
});

test('engine windows: the sound card goes to the first window and takes no stream slot; the order of the settings is kept', () => {
  const list = [stream('a'), device, ...['b', 'c', 'd', 'e', 'f', 'g', 'h'].map(stream)];
  const shards = shardInputs(list);
  assert.deepEqual(shards[0].map((i) => i.id), ['a', 'dev', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(shards[1].map((i) => i.id), ['g', 'h']);
});

test('engine windows: moving an input changes its window only when it crosses a boundary', () => {
  const ids = Array.from({ length: 8 }, (_, i) => 's' + i);
  const where = (order) => Object.fromEntries(shardInputs(order.map(stream)).flatMap((s, k) => s.map((i) => [i.id, k])));
  const before = where(ids);
  const swapped = [...ids];
  [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  assert.deepEqual(where(swapped), before); // same window for all: nothing reopens
});
