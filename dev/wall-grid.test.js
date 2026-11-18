import test from 'node:test';
import assert from 'node:assert/strict';
import { wallGrid } from '../src/core/wall-grid.js';

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
