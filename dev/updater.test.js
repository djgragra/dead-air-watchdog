import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isNewer, pickInstaller, checkForUpdate, downloadInstaller } from '../src/updater.js';

test('isNewer compares year.month.number numerically', () => {
  assert.equal(isNewer('26.10.2', '26.10.1'), true);
  assert.equal(isNewer('26.10.1', '26.10.1'), false);
  assert.equal(isNewer('v26.11.1', '26.10.9'), true);
  assert.equal(isNewer('26.9.30', '26.10.1'), false);
  assert.equal(isNewer('27.1.1', '26.12.31'), true);
});

const A = (n) => ({ name: n, url: `https://github.com/o/r/releases/download/v1/${n}`, size: 1 });
test('pickInstaller chooses the file for platform and processor', () => {
  const assets = ['Dead-Air-Watchdog-Setup-26.10.2.exe', 'Dead-Air-Watchdog-26.10.2-arm64.dmg', 'Dead-Air-Watchdog-26.10.2-x64.dmg', 'Dead-Air-Watchdog-26.10.2.AppImage', 'SHA256SUMS.txt'].map(A);
  assert.match(pickInstaller(assets, 'win32', 'x64').name, /Setup.*\.exe$/);
  assert.match(pickInstaller(assets, 'darwin', 'arm64').name, /arm64\.dmg$/);
  assert.match(pickInstaller(assets, 'darwin', 'x64').name, /x64\.dmg$/);
  assert.match(pickInstaller(assets, 'linux', 'x64').name, /AppImage$/);
  assert.equal(pickInstaller(assets, 'linux', 'arm64'), null);
});

test('checkForUpdate rejects a malformed repository without any request', async () => {
  let called = false;
  const r = await checkForUpdate({ repo: '../evil', current: '26.10.1', fetchFn: () => (called = true) });
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

test('checkForUpdate ignores asset URLs from other places', async () => {
  const body = { tag_name: 'v26.10.2', assets: [{ name: 'Dead-Air-Watchdog-26.10.2.AppImage', browser_download_url: 'https://evil.example/x.AppImage', size: 1 }, { name: 'SHA256SUMS.txt', browser_download_url: 'https://github.com/o/r/releases/download/v26.10.2/SHA256SUMS.txt' }] };
  const r = await checkForUpdate({ repo: 'o/r', current: '26.10.1', fetchFn: async () => ({ ok: true, status: 200, json: async () => body }) });
  assert.equal(r.available, true);
  assert.equal(r.installer, null);
  assert.ok(r.sumsUrl);
});

test('downloadInstaller keeps the file only when the SHA-256 matches', async () => {
  const content = Buffer.from('installer bytes');
  const sum = crypto.createHash('sha256').update(content).digest('hex');
  const name = 'Dead-Air-Watchdog-26.10.2.AppImage';
  const mk = (sums) => async (url) => (url.endsWith('SHA256SUMS.txt') ? { ok: true, text: async () => `${sums}  ${name}\n` } : { ok: true, headers: { get: () => String(content.length) }, body: new Response(content).body });
  const info = { installer: { name, url: 'https://github.com/o/r/releases/download/v/' + name, size: content.length }, sumsUrl: 'https://github.com/o/r/releases/download/v/SHA256SUMS.txt' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daw-up-'));
  const file = await downloadInstaller({ info, dir, fetchFn: mk(sum), current: '1' });
  assert.deepEqual(fs.readFileSync(file), content);
  fs.rmSync(file);
  await assert.rejects(downloadInstaller({ info, dir, fetchFn: mk('0'.repeat(64)), current: '1' }), /checksum-mismatch/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

// 0.2.1: a backup imported from another version carries general.updateRepo and the check used that setting:
// the update check always asks this app's own repository.
test('the update check always asks this version\'s own repository, never the repository of a setting', async () => {
  const fs = await import('node:fs');
  const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /checkForUpdate\(\{\s*repo:\s*s\.general\.updateRepo/);
  assert.match(main, /checkForUpdate\(\{\s*repo:\s*REPO\b/);
  const { REPO } = await import('../src/updater.js');
  assert.equal(REPO, 'djgragra/dead-air-watchdog');
  const { DEFAULT_SETTINGS } = await import('../src/store.js');
  assert.equal(DEFAULT_SETTINGS.general.updateRepo, REPO);
});
