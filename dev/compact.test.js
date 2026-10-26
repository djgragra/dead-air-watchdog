// 26.10.11: compact view and "always on top": what is remembered, the sizes, and the wiring of the window.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sanitizeSettings, DEFAULT_SETTINGS, COMPACT_MIN, NORMAL_MIN, compactHeightFor } from '../src/store.js';
import { buildExport } from '../src/backup.js';
import { MESSAGES } from '../src/messages.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const mkInput = (id) => ({ id, name: id, type: 'stream', streamUrl: `http://${id}.example.org/live` });

test('settings: normal view and not on top by default; the compact size comes from the inputs', () => {
  const s = sanitizeSettings({});
  assert.equal(s.window.compact, false);
  assert.equal(s.window.alwaysOnTop, false);
  assert.deepEqual(s.compactWindow, { x: null, y: null, width: 380, height: 0 });
  assert.equal(DEFAULT_SETTINGS.window.compact, false);
});

test('settings: the view and the pin are remembered; a wrong value is false', () => {
  const s = sanitizeSettings({ window: { compact: true, alwaysOnTop: true } });
  assert.equal(s.window.compact, true);
  assert.equal(s.window.alwaysOnTop, true);
  const t = sanitizeSettings({ window: { compact: 'yes please', alwaysOnTop: 0 } });
  assert.equal(t.window.compact, true); // any truthy value is a yes, like the other switches
  assert.equal(t.window.alwaysOnTop, false);
});

test('settings: the compact window keeps inside its limits and its place', () => {
  const s = sanitizeSettings({ compactWindow: { x: 40.6, y: 12, width: 10, height: 99999 } });
  assert.deepEqual(s.compactWindow, { x: 41, y: 12, width: COMPACT_MIN.width, height: 8000 });
  const t = sanitizeSettings({ compactWindow: { width: 'wide', height: 5 } });
  assert.equal(t.compactWindow.width, 380);
  assert.equal(t.compactWindow.height, COMPACT_MIN.height);
  assert.equal(t.compactWindow.x, null);
});

test('the smallest window of the compact view is much smaller than the normal one', () => {
  assert.deepEqual(NORMAL_MIN, { width: 760, height: 560 });
  assert.ok(COMPACT_MIN.width <= 300 && COMPACT_MIN.height <= 120);
});

test('compact height: one row per input, at most eight, never below the smallest', () => {
  assert.equal(compactHeightFor(1), 166);
  assert.equal(compactHeightFor(4), 304);
  assert.ok(compactHeightFor(12) === compactHeightFor(8));
  assert.ok(compactHeightFor(0) >= COMPACT_MIN.height);
  for (const n of [1, 3, 8, 32]) assert.ok(compactHeightFor(n) >= COMPACT_MIN.height);
});

test('backup: the compact window and the view stay on this PC, like the normal window', () => {
  const s = sanitizeSettings({ inputs: [mkInput('a')], window: { compact: true, alwaysOnTop: true }, compactWindow: { x: 1, y: 2, width: 400, height: 300 } });
  const file = buildExport(s, { includeSecrets: false });
  assert.equal('window' in file.settings, false);
  assert.equal('compactWindow' in file.settings, false);
});

test('tray menu: both switches have a text in English, Italian and Spanish', () => {
  for (const lang of ['en', 'it', 'es']) {
    assert.ok(MESSAGES[lang]['tray.compact'], `${lang} tray.compact`);
    assert.ok(MESSAGES[lang]['tray.top'], `${lang} tray.top`);
  }
});

test('window: the view is switched by one handler that accepts only the two known switches; the tray and the window use it', () => {
  const main = read('../main.js');
  const pre = read('../preload.cjs');
  assert.match(main, /handle\('window:view'/);
  assert.match(main, /key !== 'compact' && key !== 'alwaysOnTop'/);
  assert.match(pre, /window:view/);
  assert.match(main, /toggleWindowView\('compact'\)/);
  assert.match(main, /toggleWindowView\('alwaysOnTop'\)/);
  assert.match(main, /setAlwaysOnTop\(w\.alwaysOnTop, 'floating'\)/);
  assert.match(main, /setMinimumSize\(min\.width, min\.height\)/);
  assert.match(main, /compactWindow: \{ x: b\.x/); // the place of the compact view is saved apart from the normal one
});

test('interface: buttons, texts in three languages, and the compact rules that leave the wall display alone', () => {
  const html = read('../renderer/index.html');
  const css = read('../renderer/style.css');
  const i18n = read('../renderer/i18n.js');
  assert.equal(html.split('js-compact').length - 1, 2, 'one in the side bar, one in the top bar for the compact view');
  assert.equal(html.split('js-top').length - 1, 2);
  assert.match(html, /class="[^"]*js-top"[^>]*aria-pressed/);
  for (const key of ['view.top', 'view.compact', 'view.normal']) assert.equal(i18n.split(`'${key}':`).length - 1, 3, key);
  assert.match(css, /body\.compact:not\(\.wall\) \.side/);
  assert.match(css, /body\.compact:not\(\.wall\) \.tile__body/);
  assert.equal(/body\.compact(?!:not\(\.wall\))[^{]*\{/.test(css), false, 'every compact rule leaves the wall display alone');
});
