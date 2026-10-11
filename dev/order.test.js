import test from 'node:test';
import assert from 'node:assert/strict';
import { moveItem } from '../src/core/order.js';

test('moveItem: up and down swap neighbours, the ends stay, the original list is not changed', () => {
  const l = ['a', 'b', 'c'];
  assert.deepEqual(moveItem(l, 1, -1), ['b', 'a', 'c']);
  assert.deepEqual(moveItem(l, 1, 1), ['a', 'c', 'b']);
  assert.deepEqual(moveItem(l, 0, -1), ['a', 'b', 'c']);
  assert.deepEqual(moveItem(l, 2, 1), ['a', 'b', 'c']);
  assert.deepEqual(moveItem(l, 5, 1), ['a', 'b', 'c']);
  assert.deepEqual(l, ['a', 'b', 'c']);
});

test('the order of the inputs in the settings is the order of the tiles (and of the wall display)', async () => {
  const { sanitizeSettings } = await import('../src/store.js');
  const s = sanitizeSettings({ inputs: ['x', 'y', 'z'].map((id) => ({ id, type: 'stream', streamUrl: `http://${id}.example.org/l` })) });
  const swapped = moveItem(s.inputs, 2, -1);
  assert.deepEqual(sanitizeSettings({ inputs: swapped }).inputs.map((i) => i.id), ['x', 'z', 'y']);
});
