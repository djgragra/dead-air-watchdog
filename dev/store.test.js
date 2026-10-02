import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, sanitizeSettings, deepMerge, DEFAULT_SETTINGS, MAX_INPUTS } from '../src/store.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'daw-')), 'data.json');
const seal = (v) => 'enc:v1:' + Buffer.from(v).toString('base64');
const open = (v) => (v.startsWith('enc:v1:') ? Buffer.from(v.slice(7), 'base64').toString() : v);

test('defaults: English, dark theme, nothing enabled', () => {
  const s = createStore({ file: tmp() }).getSettings();
  assert.equal(s.language, 'en');
  assert.equal(s.theme, 'dark');
  assert.equal(s.notifications.email.enabled, false);
  assert.equal(s.notifications.telegram.enabled, false);
  assert.equal(s.notifications.telegram.botToken, '');
});

test('secrets are written sealed and read back in clear', () => {
  const file = tmp();
  const st = createStore({ file, seal, open });
  st.updateSettings({ notifications: { telegram: { botToken: 'PLACEHOLDER-TOKEN' }, email: { pass: 'PLACEHOLDER-PASS' } }, heartbeat: { url: 'https://ping.example.org/PLACEHOLDER-HB' }, inputs: [{ id: 'x1', type: 'stream', streamUrl: 'http://u:p@example.org/live' }] });
  st.flush();
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('PLACEHOLDER-TOKEN') && !raw.includes('PLACEHOLDER-PASS') && !raw.includes('u:p@') && !raw.includes('PLACEHOLDER-HB'));
  const again = createStore({ file, seal, open }).getSettings();
  assert.equal(again.notifications.telegram.botToken, 'PLACEHOLDER-TOKEN');
  assert.equal(again.notifications.email.pass, 'PLACEHOLDER-PASS');
  assert.equal(again.inputs[0].streamUrl, 'http://u:p@example.org/live');
  assert.equal(again.heartbeat.url, 'https://ping.example.org/PLACEHOLDER-HB');
});

test('sanitize clamps numbers and rejects unknown enum values', () => {
  const s = sanitizeSettings({ language: 'fr', theme: 'pink', inputs: [{ type: 'stream', thresholdDb: 5, minSilenceSec: 0 }], notifications: { reminderMin: -3, email: { port: 99999 } }, general: { retentionDays: 1, updateRepo: '../evil' } });
  assert.equal(s.language, 'en');
  assert.equal(s.theme, 'dark');
  assert.equal(s.inputs[0].thresholdDb, -10);
  assert.equal(s.inputs[0].minSilenceSec, 1);
  assert.equal(s.notifications.reminderMin, 0);
  assert.equal(s.notifications.email.port, 65535);
  assert.equal(s.general.retentionDays, 30);
  assert.equal(s.general.updateRepo, DEFAULT_SETTINGS.general.updateRepo);
});

test('telegram recipients are normalised', () => {
  const s = sanitizeSettings({ notifications: { telegram: { recipients: [{ chatId: ' 123 ', note: 'x' }, { chatId: '' }, null] } } });
  assert.deepEqual(s.notifications.telegram.recipients, [{ chatId: '123', note: 'x' }]);
});

test('deepMerge replaces arrays and merges objects', () => {
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 }, r: [1, 2] }, { a: { b: 9 }, r: [3] }), { a: { b: 9, c: 2 }, r: [3] });
});

test('events: add, update, prune, clear; survive a reload', () => {
  const file = tmp();
  let t = 1_000_000_000_000;
  const st = createStore({ file, now: () => t });
  const a = st.addEvent({ kind: 'dead-air', cause: 'silence', start: t - 400 * 86_400_000, end: t - 400 * 86_400_000 + 5000 });
  const b = st.addEvent({ kind: 'dead-air', cause: 'silence', start: t - 1000, end: null });
  st.updateEvent(b.id, { end: t });
  assert.equal(st.pruneEvents(365), 1);
  st.flush();
  const again = createStore({ file }).listEvents();
  assert.equal(again.length, 1);
  assert.equal(again[0].id, b.id);
  assert.equal(again[0].end, t);
  assert.notEqual(a.id, b.id);
  st.clearEvents();
  assert.equal(st.listEvents().length, 0);
});

test('a corrupt file is kept aside and replaced by defaults', () => {
  const file = tmp();
  fs.writeFileSync(file, '{not json');
  const st = createStore({ file });
  assert.equal(st.getSettings().language, 'en');
  assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.includes('.corrupt-')));
});

test('inputs: ids, one sound card at most, limit of 32, names and defaults', () => {
  const dev = (n) => ({ type: 'device', name: n });
  const s = sanitizeSettings({ inputs: [{ id: 'dup', type: 'stream', name: '  Main  ' }, { id: 'dup', type: 'stream' }, dev('card 1'), dev('card 2'), { type: 'weird' }] });
  assert.equal(s.inputs.length, 4, 'second sound card dropped');
  assert.equal(new Set(s.inputs.map((i) => i.id)).size, 4, 'ids made unique');
  assert.equal(s.inputs[0].name, 'Main');
  assert.equal(s.inputs.filter((i) => i.type === 'device').length, 1);
  assert.equal(s.inputs[3].type, 'stream', 'unknown type becomes stream');
  assert.equal(s.inputs[0].thresholdDb, -50);
  assert.equal(s.inputs[0].minSilenceSec, 30);
  const many = sanitizeSettings({ inputs: Array.from({ length: 50 }, () => ({ type: 'stream' })) });
  assert.equal(many.inputs.length, MAX_INPUTS);
});

test('settings of the single-input versions are migrated to one input', () => {
  const s = sanitizeSettings({ input: { type: 'stream', streamUrl: 'http://x.example.org/live' }, detection: { thresholdDb: -42, minSilenceSec: 15 } });
  assert.equal(s.inputs.length, 1);
  assert.equal(s.inputs[0].streamUrl, 'http://x.example.org/live');
  assert.equal(s.inputs[0].thresholdDb, -42);
  assert.equal(s.inputs[0].minSilenceSec, 15);
  assert.equal(s.input, undefined);
  assert.equal(sanitizeSettings({ input: { type: 'stream', streamUrl: '' } }).inputs.length, 0);
});

test('display settings are validated', () => {
  assert.equal(sanitizeSettings({ display: { edgeGlow: 'nope', startInWall: 1 } }).display.edgeGlow, 'wall');
  assert.equal(sanitizeSettings({ display: { edgeGlow: 'always', startInWall: 1 } }).display.startInWall, true);
});
