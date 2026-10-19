import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STRINGS, makeT } from '../renderer/i18n.js';

test('window texts: all languages have exactly the English keys and the same placeholders', () => {
  const en = Object.keys(STRINGS.en).sort();
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
  for (const l of ['it', 'es']) {
    assert.deepEqual(Object.keys(STRINGS[l]).sort(), en, l);
    for (const k of en) assert.equal(ph(STRINGS[l][k]), ph(STRINGS.en[k]), `${l} ${k}`);
  }
});

test('every data-i18n key used in index.html and app.js exists', () => {
  const html = fs.readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../renderer/app.js', import.meta.url), 'utf8');
  const keys = new Set([...html.matchAll(/data-i18n(?:-[a-z]+)?="([^"]+)"/g)].map((m) => m[1]));
  for (const m of js.matchAll(/\bt\('([\w.-]+)'/g)) keys.add(m[1]);
  const missing = [...keys].filter((k) => !(k in STRINGS.en));
  assert.deepEqual(missing, []);
});

test('makeT falls back to English and fills placeholders', () => {
  assert.equal(makeT('it')('kpi.events', { n: 3 }), '3 eventi');
  assert.equal(makeT('xx')('kpi.event'), '1 event');
});

test('keys built at run time exist in every language', () => {
  const keys = [
    ...['run-installer', 'open-image', 'reveal'].map((k) => `upd.after.${k}`),
    ...['silence', 'offline', 'frozen', 'nodata', 'late', 'maintenance', 'quit', 'unknown', 'suspended'].map((k) => `cause.${k}`),
    ...['idle', 'starting', 'ok', 'counting', 'alarm', 'paused', 'off', 'incomplete'].map((k) => `st.${k}`),
    ...['blip', 'pause', 'dead'].map((k) => `kind.${k}`)
  ];
  for (const l of ['en', 'it', 'es']) for (const k of keys) assert.ok(k in STRINGS[l], `${l} ${k}`);
});

test('Italian keeps the English words "Dashboard" and "Wall display" (rule of 19 October 2026)', () => {
  for (const [k, v] of Object.entries(STRINGS.it)) assert.doesNotMatch(v, /cruscott|modalità parete|schermo a muro/i, k);
  assert.equal(STRINGS.it['nav.dashboard'], 'Dashboard');
  assert.equal(STRINGS.it['wall.enter'], 'Wall display');
  assert.match(STRINGS.it['set.disp.name'], /wall display/);
});
