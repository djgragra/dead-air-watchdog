// The common "signature" of OnAir Garage apps (apps/COMMON-FEATURES.md, section 5): logs, support info, window, shared-module headers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger, LOG_FILE_RE, MAX_LOG_BYTES } from '../src/logs.js';
import { buildSupportInfo, tidy } from '../src/support.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'daw-sig-'));
const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');

test('log file names: one file per day, app prefix, the line has date, level and scope', async () => {
  const dir = tmp();
  const log = createLogger({ dir, now: () => new Date(2026, 9, 15, 21, 5, 9) });
  log.log('info', 'started', 'app');
  await log.flush();
  assert.deepEqual(fs.readdirSync(dir), ['dead-air-watchdog_15-10-2026.log']);
  assert.match(fs.readFileSync(path.join(dir, 'dead-air-watchdog_15-10-2026.log'), 'utf8'), /^2026-10-15 21:05:09 \| INFO {2}\| app \| started\n$/);
  assert.equal(MAX_LOG_BYTES, 5 * 1024 * 1024);
});

test('a file that reaches the limit is closed and a new one starts; at most 4 files for one day', async () => {
  const dir = tmp();
  const log = createLogger({ dir, maxBytes: 200, now: () => new Date(2026, 9, 15, 12, 0, 0) });
  for (let i = 0; i < 40; i++) log.log('info', 'x'.repeat(60) + i);
  await log.flush();
  const files = fs.readdirSync(dir);
  assert.ok(files.length > 1 && files.length <= 4, files.join());
  assert.ok(files.every((f) => LOG_FILE_RE.test(f)));
});

test('logs older than the retention are removed, other files are not touched', () => {
  const dir = tmp();
  for (const n of ['dead-air-watchdog_01-10-2026.log', 'dead-air-watchdog_14-10-2026.log', 'other.log', 'dead-air-watchdog_05-10-2026_1.log']) fs.writeFileSync(path.join(dir, n), 'x');
  const log = createLogger({ dir, retentionDays: 7, now: () => new Date(2026, 9, 15, 12, 0, 0) });
  assert.equal(log.prune(), 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['dead-air-watchdog_14-10-2026.log', 'other.log']);
});

test('the log keeps the last lines in memory for the support info', () => {
  const log = createLogger({ dir: tmp(), ringSize: 3 });
  for (let i = 0; i < 5; i++) log.log(i === 4 ? 'error' : 'info', `m${i}`);
  assert.deepEqual(log.entries().map((e) => e.message), ['m2', 'm3', 'm4']);
  assert.equal(log.entries().at(-1).level, 'error');
});

test('support info: version, system, installation name, last check and error; the home folder as ~; no settings', () => {
  const text = buildSupportInfo({
    app: 'Dead Air Watchdog', version: '26.10.6', electron: '44.4.3', chrome: '140.0', platform: 'win32', arch: 'x64', osRelease: '10.0.19045', language: 'it', installationName: 'Regia',
    lastCheck: { at: Date.UTC(2026, 9, 15, 8, 0, 0), ok: false, error: 'ENOENT C:\\Users\\Mario Rossi\\Downloads\\x' },
    lastError: { t: Date.UTC(2026, 9, 15, 9, 0, 0), message: 'failed at /home/mario/watchdog/x.json' },
    home: ''
  });
  assert.match(text, /^Dead Air Watchdog 26\.10\.6\nElectron 44\.4\.3 \(Chrome 140\.0\)\nSystem: win32 x64 10\.0\.19045\nLanguage: it\nInstallation: Regia\n/);
  assert.match(text, /Last update check: 2026-10-15T08:00:00\.000Z \(ENOENT ~\\Downloads\\x\)/);
  assert.match(text, /Last error: .* failed at ~\/watchdog\/x\.json/);
  assert.ok(!/Rossi|mario/.test(text));
  assert.match(buildSupportInfo({ app: 'Dead Air Watchdog', version: '1', electron: '2', platform: 'linux', arch: 'x64', language: 'en' }), /Last update check: never\nLast error: none$/);
  assert.equal(tidy('open /root/secret/a.txt', '/root'), 'open ~/secret/a.txt');
});

test('shared modules carry their garage-common header (apps/COMMON-FEATURES.md, 5.8)', () => {
  const header = (f) => fs.readFileSync(path.join(root, 'src', f), 'utf8').split('\n')[0];
  assert.equal(header('updater.js'), '// garage-common: updater 2');
  assert.equal(header('support.js'), '// garage-common: support 1');
  assert.equal(header('logs.js'), '// garage-common: logs 1');
});

test('the changelog is packaged (What\'s new reads it) and has the entry of the version in package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('CHANGELOG.md'));
  assert.match(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), new RegExp(`^## ${pkg.version.replace(/\./g, '\\.')} — \\d{4}-\\d{2}-\\d{2}$`, 'm'));
});

test('the logo and every icon file made from it exist (app icons for Windows, macOS and Linux, tray colours, menu-bar glyph)', () => {
  const a = (f) => path.join(root, 'assets', f);
  const png = (f) => {
    const b = fs.readFileSync(a(f));
    assert.equal(b.subarray(1, 4).toString(), 'PNG', f);
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  };
  assert.match(fs.readFileSync(a('logo.svg'), 'utf8'), /^<svg /);
  assert.match(fs.readFileSync(a('tray.svg'), 'utf8'), /^<svg /);
  assert.equal(fs.readFileSync(a('logo.svg'), 'utf8'), fs.readFileSync(path.join(root, 'renderer', 'logo.svg'), 'utf8'), 'the window shows the same logo');
  assert.deepEqual(png('icon.png'), { w: 1024, h: 1024 });
  for (const s of [16, 32, 48, 64, 128, 256, 512]) assert.deepEqual(png(`linux-icons/${s}x${s}.png`), { w: s, h: s });
  for (const st of ['idle', 'ok', 'counting', 'alarm']) assert.deepEqual(png(`tray-${st}.png`), { w: 32, h: 32 });
  assert.deepEqual(png('trayTemplate.png'), { w: 22, h: 22 });
  assert.deepEqual(png('trayTemplate@2x.png'), { w: 44, h: 44 });
  const ico = fs.readFileSync(a('icon.ico'));
  assert.equal(ico.readUInt16LE(2), 1); // type: icon
  assert.equal(ico.readUInt16LE(4), 6); // six sizes
  const icns = fs.readFileSync(a('icon.icns'));
  assert.equal(icns.subarray(0, 4).toString(), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
});
