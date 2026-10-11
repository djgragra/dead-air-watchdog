import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExport, prepareImport, missingSecrets, backupFileName, BACKUP_APP } from '../src/backup.js';
import { sanitizeSettings, MAX_INPUTS } from '../src/store.js';
import { secretSlots, mapSecrets, stripSecrets } from '../src/secrets.js';

// fictitious data only
const base = () =>
  sanitizeSettings({
    language: 'it',
    theme: 'light',
    micExplained: true,
    closeHintShown: true,
    inputs: [
      { id: 'a1', type: 'stream', name: 'Studio A', streamUrl: 'http://dj:hunter22@stream.example.org:8000/live', thresholdDb: -45, minSilenceSec: 20 },
      { id: 'b2', type: 'stream', name: 'Backup', streamUrl: 'http://stream2.example.org/live' }
    ],
    notifications: {
      email: { enabled: true, host: 'smtp.example.org', user: 'watchdog', pass: 'S3cretPass', from: 'w@example.org', recipients: ['a@example.org', 'b@example.org'] },
      telegram: { enabled: true, botToken: '123456789:AAEhBOweik6ad9r_QXMENQjcrvKa1B2c3d4', recipients: [{ chatId: '111', note: 'Anna' }] }
    },
    heartbeat: { enabled: true, url: 'https://ping.example.org/TOKEN123', intervalMin: 5 }
  });
const SECRETS = ['S3cretPass', '123456789:AAEhBOweik6ad9r_QXMENQjcrvKa1B2c3d4', 'TOKEN123', 'hunter22'];
const NOW = Date.UTC(2026, 9, 11, 10, 0, 0);

test('file: name, fields and what is left out', () => {
  const f = buildExport(base(), { now: NOW });
  assert.equal(backupFileName(NOW), 'dead-air-watchdog-backup-2026-10-11.json');
  assert.equal(f.app, BACKUP_APP);
  assert.equal(f.version, 1);
  assert.equal(f.exportedAt, '2026-10-11T10:00:00.000Z');
  assert.equal(f.includesSecrets, false);
  assert.equal(f.inputs.length, 2);
  assert.equal(f.settings.language, 'it');
  assert.equal('inputs' in f.settings, false);
  assert.equal('micExplained' in f.settings, false);
  assert.equal('closeHintShown' in f.settings, false);
});

test('export without the box: no secret anywhere in the file, what was left out is listed', () => {
  const text = JSON.stringify(buildExport(base(), { now: NOW }));
  for (const s of SECRETS) assert.ok(!text.includes(s), s);
  assert.ok(text.includes('http://stream.example.org:8000/live')); // the address stays, only user and password go
  const f = buildExport(base(), { now: NOW });
  assert.deepEqual(f.emptiedSecrets.sort(), ['email.pass', 'heartbeat.url', 'input:a1', 'telegram.botToken']);
});

test('export with the box: secrets are written in plain text', () => {
  const f = buildExport(base(), { includeSecrets: true, now: NOW });
  assert.equal(f.includesSecrets, true);
  const text = JSON.stringify(f);
  for (const s of SECRETS) assert.ok(text.includes(s), s);
  assert.equal('emptiedSecrets' in f, false);
});

test('import of a file with secrets, replace: everything comes from the file', () => {
  const f = buildExport(base(), { includeSecrets: true, now: NOW });
  const current = sanitizeSettings({ notifications: { email: { host: 'other.example.org', user: 'x', pass: 'OldPass99' } } });
  const r = prepareImport(JSON.stringify(f), current, { mode: 'replace' });
  assert.equal(r.ok, true);
  assert.equal(r.settings.notifications.email.pass, 'S3cretPass');
  assert.equal(r.settings.inputs.length, 2);
  assert.equal(r.settings.inputs[0].streamUrl, 'http://dj:hunter22@stream.example.org:8000/live');
  assert.equal(r.settings.language, 'it');
  assert.deepEqual(r.missing, []);
});

test('import of a file without secrets: the list of what to type again', () => {
  const f = buildExport(base(), { now: NOW });
  const r = prepareImport(f, sanitizeSettings({}), { mode: 'replace' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing.map((m) => m.id).sort(), ['email.pass', 'heartbeat.url', 'input:a1', 'telegram.botToken']);
  assert.equal(r.missing.find((m) => m.id === 'input:a1').name, 'Studio A');
  assert.equal(r.settings.notifications.email.pass, '');
});

test('import: the password of this PC is kept for the same server and user, not for another', () => {
  const f = buildExport(base(), { now: NOW });
  const same = prepareImport(f, base(), { mode: 'replace' });
  assert.equal(same.settings.notifications.email.pass, 'S3cretPass');
  assert.equal(same.settings.notifications.telegram.botToken, '123456789:AAEhBOweik6ad9r_QXMENQjcrvKa1B2c3d4');
  assert.equal(same.settings.heartbeat.url, 'https://ping.example.org/TOKEN123');
  assert.equal(same.settings.inputs[0].streamUrl, 'http://dj:hunter22@stream.example.org:8000/live');
  assert.deepEqual(same.missing, []);

  const otherUser = base();
  otherUser.notifications.email.user = 'someone-else';
  const r1 = prepareImport(f, otherUser, { mode: 'replace' });
  assert.equal(r1.settings.notifications.email.pass, '');
  assert.ok(r1.missing.some((m) => m.id === 'email.pass'));

  const otherServer = base();
  otherServer.notifications.email.host = 'smtp.other.org';
  assert.equal(prepareImport(f, otherServer, { mode: 'replace' }).settings.notifications.email.pass, '');

  const otherStream = base();
  otherStream.inputs[0].streamUrl = 'http://dj:hunter22@elsewhere.example.org/live';
  const r2 = prepareImport(f, otherStream, { mode: 'replace' });
  assert.ok(!r2.settings.inputs[0].streamUrl.includes('hunter22'));
  assert.ok(r2.missing.some((m) => m.id === 'input:a1'));
});

test('import: sealed values from a file are dropped (they cannot be opened here)', () => {
  const f = buildExport(base(), { includeSecrets: true, now: NOW });
  f.settings.notifications.email.pass = 'enc:v1:AAAA';
  f.inputs[0].streamUrl = 'enc:v1:BBBB';
  const r = prepareImport(f, sanitizeSettings({}), { mode: 'replace' });
  assert.equal(r.settings.notifications.email.pass, '');
  assert.equal(r.settings.inputs[0].streamUrl, '');
  assert.ok(r.missing.some((m) => m.id === 'email.pass'));
  assert.ok(r.missing.some((m) => m.id === 'input:a1'));
});

test('import, add only: just the inputs this PC does not have; the settings stay', () => {
  const f = buildExport(base(), { includeSecrets: true, now: NOW });
  f.inputs.push({ id: 'c3', type: 'stream', name: 'New one', streamUrl: 'http://new.example.org/live' });
  f.settings.language = 'es';
  const current = sanitizeSettings({ language: 'en', inputs: [{ id: 'a1', type: 'stream', name: 'Mine', streamUrl: 'http://mine.example.org/x' }] });
  const r = prepareImport(f, current, { mode: 'add' });
  assert.equal(r.ok, true);
  assert.equal(r.settings.language, 'en');
  assert.deepEqual(r.settings.inputs.map((i) => i.id), ['a1', 'b2', 'c3']);
  assert.equal(r.settings.inputs[0].name, 'Mine'); // the existing input is not touched
  assert.equal(r.added, 2);
  assert.equal(r.settings.notifications.email.host, ''); // settings untouched
});

test('import, replace: the "already told" flags of this PC are kept; the maximum number of inputs holds', () => {
  const f = buildExport(base(), { now: NOW });
  const current = sanitizeSettings({ micExplained: true, closeHintShown: true });
  const r = prepareImport(f, current, { mode: 'replace' });
  assert.equal(r.settings.micExplained, true);
  assert.equal(r.settings.closeHintShown, true);
  const big = buildExport(base(), { now: NOW });
  big.inputs = Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, type: 'stream', streamUrl: `http://h${i}.example.org/l` }));
  assert.equal(prepareImport(big, sanitizeSettings({}), { mode: 'replace' }).settings.inputs.length, MAX_INPUTS);
});

test('import: wrong app, damaged or oversized file are refused with a reason', () => {
  const cur = sanitizeSettings({});
  assert.equal(prepareImport({ app: 'flowcast', version: 1, settings: {} }, cur).error, 'wrong-app');
  assert.equal(prepareImport({ settings: {} }, cur).error, 'wrong-app');
  assert.equal(prepareImport('{not json', cur).error, 'invalid');
  assert.equal(prepareImport('[1,2]', cur).error, 'invalid');
  assert.equal(prepareImport('x'.repeat(2_000_001), cur).error, 'too-big');
});

test('import: hand-edited values are brought back inside the limits', () => {
  const f = buildExport(base(), { now: NOW });
  f.settings.notifications.email.port = 99999;
  f.settings.theme = 'pink';
  f.inputs[0].thresholdDb = 5;
  const r = prepareImport(f, sanitizeSettings({}), { mode: 'replace' });
  assert.equal(r.settings.notifications.email.port, 65535);
  assert.equal(r.settings.theme, 'dark');
  assert.equal(r.settings.inputs[0].thresholdDb, -10);
});

test('the one list of secrets covers email, Telegram, heartbeat and every stream address', () => {
  const s = base();
  assert.deepEqual(secretSlots(s).map((x) => x.id), ['email.pass', 'telegram.botToken', 'heartbeat.url', 'input:a1', 'input:b2']);
  const sealed = mapSecrets(s, (v) => `enc:v1:${Buffer.from(v).toString('base64')}`);
  assert.ok(sealed.notifications.email.pass.startsWith('enc:v1:'));
  assert.ok(sealed.heartbeat.url.startsWith('enc:v1:'));
  assert.ok(sealed.inputs.every((i) => i.streamUrl.startsWith('enc:v1:')));
  assert.equal(s.notifications.email.pass, 'S3cretPass'); // the original is not changed
  assert.equal(stripSecrets(s).settings.inputs[1].streamUrl, 'http://stream2.example.org/live'); // no credentials: nothing to remove
});

test('missingSecrets: nothing needed when nothing is configured', () => {
  assert.deepEqual(missingSecrets(sanitizeSettings({})), []);
});
