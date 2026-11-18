import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExport, prepareImport, missingSecrets, backupFileName, backupTooBig, BACKUP_APP, MAX_BACKUP_BYTES } from '../src/backup.js';
import { sanitizeSettings, MAX_INPUTS } from '../src/store.js';
import { secretSlots, mapSecrets, stripSecrets } from '../src/secrets.js';

// Built at run time so that no token-shaped text sits in the repository (secret scanners flag it); same shape as a real one.
const FAKE_TELEGRAM_TOKEN = ['123456789', 'A'.repeat(35)].join(':');
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
      telegram: { enabled: true, botToken: FAKE_TELEGRAM_TOKEN, recipients: [{ chatId: '111', note: 'Anna' }] }
    },
    heartbeat: { enabled: true, url: 'https://ping.example.org/TOKEN123', intervalMin: 5 }
  });
const SECRETS = ['S3cretPass', FAKE_TELEGRAM_TOKEN, 'TOKEN123', 'hunter22'];
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
  assert.equal(same.settings.notifications.telegram.botToken, FAKE_TELEGRAM_TOKEN);
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
  assert.equal(prepareImport('x'.repeat(MAX_BACKUP_BYTES + 1), cur).error, 'too-big');
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

test('the one list of secrets covers email, Telegram, heartbeat, HTTP alerts and every stream address', () => {
  const s = base();
  assert.deepEqual(secretSlots(s).map((x) => x.id), ['email.pass', 'telegram.botToken', 'heartbeat.url', 'webhook.url', 'webhook.authHeader', 'input:a1', 'input:b2']);
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

// ---- logos travel inside the backup (0.2.1): the public app left them out, so a configuration moved to another
// installation lost them
// a PNG with a valid header (signature + IHDR) of w x h pixels, as the logo store checks them
const png = (w, h) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return `data:image/png;base64,${b.toString('base64')}`;
};

// the two inputs of base() with logos of the library
const withLogo = (map) => {
  const s = base();
  for (const i of s.inputs) i.logo = map[i.id] ?? '';
  return s;
};

test('logos: only the logos the inputs use go into the file, once each even if several inputs share one; none, no key', () => {
  assert.equal('logos' in buildExport(base(), { now: NOW }), false);
  assert.equal('logos' in buildExport(withLogo({ a1: 'lgA' }), { now: NOW, logos: {} }), false);
  const f = buildExport(withLogo({ a1: 'lgA', b2: 'lgA' }), { now: NOW, logos: { lgA: png(64, 64), lgUnused: png(8, 8) } });
  assert.deepEqual(Object.keys(f.logos), ['lgA'], 'a logo shared by two inputs is in the file once; one nobody uses is not');
  assert.deepEqual(f.inputs.map((i) => i.logo), ['lgA', 'lgA']);
});

test('logos: a logo that was removed from its input (empty reference) is never exported, even if a file with the input name is still there', () => {
  const f = buildExport(base(), { now: NOW, logos: { a1: png(64, 64), b2: png(64, 64) } });
  assert.equal('logos' in f, false);
});

test('logos: replace brings the logos of every imported input back, shared ones once; each one is checked again', () => {
  const f = buildExport(withLogo({ a1: 'lgA', b2: 'lgB' }), { now: NOW, logos: { lgA: png(256, 128), lgB: png(32, 32) } });
  f.logos.lgB = 'data:image/png;base64,AAAA'; // damaged
  f.logos.stranger = png(8, 8); // a logo no input of the file uses
  const plan = prepareImport(JSON.parse(JSON.stringify(f)), sanitizeSettings({}));
  assert.ok(plan.ok);
  assert.deepEqual(Object.keys(plan.logos), ['lgA'], 'the damaged one and the stranger are left out, the import goes on');
  assert.equal(plan.settings.inputs.length, 2);
  assert.deepEqual(plan.settings.inputs.map((i) => i.logo), ['lgA', 'lgB']);
});

test('logos: a picture that is too big (side above 512 px) is left out', () => {
  const f = buildExport(withLogo({ a1: 'lgA', b2: 'lgB' }), { now: NOW, logos: { lgA: png(600, 100), lgB: png(512, 512) } });
  const plan = prepareImport(JSON.parse(JSON.stringify(f)), sanitizeSettings({}));
  assert.deepEqual(Object.keys(plan.logos), ['lgB']);
});

test('logos: "add" brings the logos of the inputs it adds only, never those of inputs the PC already has', () => {
  const f = buildExport(withLogo({ a1: 'lgA', b2: 'lgB' }), { now: NOW, logos: { lgA: png(64, 64), lgB: png(64, 64) } });
  const cur = sanitizeSettings({ inputs: [{ id: 'a1', type: 'stream', name: 'Mine', streamUrl: 'http://x.example.org/live' }] });
  const plan = prepareImport(JSON.parse(JSON.stringify(f)), cur, { mode: 'add' });
  assert.equal(plan.added, 1);
  assert.deepEqual(Object.keys(plan.logos), ['lgB']);
});

test('logos: a file of 0.2.1 (logos keyed by input, no reference in the inputs) still brings its logos, named after the input', () => {
  const old = buildExport(base(), { now: NOW });
  old.logos = { a1: png(64, 64), b2: png(64, 64), zzz: png(8, 8) };
  const plan = prepareImport(JSON.parse(JSON.stringify(old)), sanitizeSettings({}));
  assert.deepEqual(Object.keys(plan.logos).sort(), ['a1', 'b2']);
  assert.deepEqual(plan.settings.inputs.map((i) => i.logo), ['a1', 'b2']);
});

test('logos: a file without any (made by the public version) imports as before, with an empty list and no logo', () => {
  const plan = prepareImport(buildExport(base(), { now: NOW }), sanitizeSettings({}));
  assert.ok(plan.ok);
  assert.deepEqual(plan.logos, {});
  assert.deepEqual(plan.settings.inputs.map((i) => i.logo), ['', '']);
});

test('logos: a hand-edited "logos" that is not an object does no harm', () => {
  const f = buildExport(base(), { now: NOW });
  f.logos = ['x'];
  assert.deepEqual(prepareImport(f, sanitizeSettings({})).logos, {});
  f.logos = 'text';
  assert.deepEqual(prepareImport(f, sanitizeSettings({})).logos, {});
});

test('logos: what the app writes it can read: 32 different logos of the largest size fit, and a file above the limit is refused', () => {
  assert.ok(MAX_BACKUP_BYTES >= 32 * Math.ceil(400_000 * 4 / 3) + 100_000);
  assert.equal(backupTooBig('x'.repeat(MAX_BACKUP_BYTES)), false);
  assert.equal(backupTooBig('x'.repeat(MAX_BACKUP_BYTES + 1)), true);
  assert.equal(backupTooBig('à'.repeat(MAX_BACKUP_BYTES / 2)), false, 'the size is counted in bytes, not characters');
  assert.equal(backupTooBig('à'.repeat(MAX_BACKUP_BYTES / 2 + 1)), true);
});
