import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isNewer, pickInstaller, checkForUpdate, downloadInstaller, sweepPartials, bannerState, remindLaterState, skipVersionState,
  makeSafetyCopy, installPlan, whatsNew, startupKind, releaseNotesSummary, PRODUCT
} from '../src/updater.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'daw-upd-'));
const NAME = 'Dead-Air-Watchdog-Setup-26.10.3.exe';
const payload = Buffer.alloc(300_000, 7);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// a fake GitHub: the sums file, and the installer in chunks (optionally failing, slow or never ending)
function fakeFetch({ body = payload, sums = `${sha(payload)}  ${NAME}\n`, failAfter = null, hang = false, status = 200 } = {}) {
  return async (url, { signal } = {}) => {
    if (url.endsWith('SHA256SUMS.txt')) return new Response(sums);
    let sent = 0;
    const stream = new ReadableStream({
      async pull(c) {
        if (signal?.aborted) return c.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (hang && sent > 0) {
          await new Promise((_, rej) => signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
        }
        if (failAfter !== null && sent >= failAfter) return c.error(new Error('network down'));
        if (sent >= body.length) return c.close();
        c.enqueue(body.subarray(sent, sent + 50_000));
        sent += 50_000;
      }
    });
    return new Response(stream, { status, headers: { 'content-length': String(body.length) } });
  };
}
const info = { installer: { name: NAME, url: `https://github.com/djgragra/dead-air-watchdog/releases/download/v26.10.3/${NAME}`, size: payload.length }, sumsUrl: 'https://github.com/djgragra/dead-air-watchdog/releases/download/v26.10.3/SHA256SUMS.txt' };
const leftovers = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.part'));

// ---- download and the .part file ----------------------------------------------------------------------

test('a good download is verified and gets its real name; no .part is left', async () => {
  const dir = tmp();
  const file = await downloadInstaller({ info, dir, fetchFn: fakeFetch(), current: '26.10.2' });
  assert.equal(path.basename(file), NAME);
  assert.equal(sha(fs.readFileSync(file)), sha(payload));
  assert.deepEqual(leftovers(dir), []);
});

test('a checksum that does not match deletes the file', async () => {
  const dir = tmp();
  await assert.rejects(downloadInstaller({ info, dir, fetchFn: fakeFetch({ sums: `${'0'.repeat(64)}  ${NAME}\n` }), current: '26.10.2' }), /checksum-mismatch/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('an interrupted download (network error half way) leaves no .part', async () => {
  const dir = tmp();
  await assert.rejects(downloadInstaller({ info, dir, fetchFn: fakeFetch({ failAfter: 100_000 }), current: '26.10.2' }), /network down/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('cancelling removes the .part and says "cancelled"', async () => {
  const dir = tmp();
  const ctl = new AbortController();
  const p = downloadInstaller({ info, dir, fetchFn: fakeFetch({ hang: true }), current: '26.10.2', signal: ctl.signal, onProgress: () => {} });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(leftovers(dir).length, 1, 'the .part exists while downloading');
  ctl.abort();
  await assert.rejects(p, (e) => e.message === 'cancelled' && e.cancelled === true);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a download that stalls is given up and cleaned', async () => {
  const dir = tmp();
  await assert.rejects(downloadInstaller({ info, dir, fetchFn: fakeFetch({ hang: true }), current: '26.10.2', stallMs: 120 }), /stalled/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a failed rename (a folder with the final name) still removes the .part', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, NAME)); // renaming a file onto a folder fails
  await assert.rejects(downloadInstaller({ info, dir, fetchFn: fakeFetch(), current: '26.10.2' }));
  assert.deepEqual(leftovers(dir), []);
});

test('HTTP error and missing checksums stop before anything is written', async () => {
  const dir = tmp();
  await assert.rejects(downloadInstaller({ info, dir, fetchFn: fakeFetch({ sums: 'nothing useful' }), current: '26.10.2' }), /no-checksums/);
  await assert.rejects(downloadInstaller({ info: { ...info, sumsUrl: null }, dir, fetchFn: fakeFetch(), current: '26.10.2' }), /no-checksums/);
  await assert.rejects(downloadInstaller({ info: { sumsUrl: info.sumsUrl }, dir, fetchFn: fakeFetch(), current: '26.10.2' }), /no-installer/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('sweepPartials removes Dead-Air-Watchdog .part files an earlier run left, and nothing else', () => {
  const dir = tmp();
  for (const n of [`${NAME}.part`, 'Dead-Air-Watchdog-26.10.2-arm64.dmg.part', 'Other-App-1.0.exe.part', NAME, 'notes.txt']) fs.writeFileSync(path.join(dir, n), 'x');
  assert.deepEqual(sweepPartials(dir).sort(), [`${NAME}.part`, 'Dead-Air-Watchdog-26.10.2-arm64.dmg.part'].sort());
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Other-App-1.0.exe.part', NAME, 'notes.txt'].sort());
  assert.deepEqual(sweepPartials(path.join(dir, 'missing')), []);
});

// ---- checking GitHub --------------------------------------------------------------------------------------

const release = (tag, names, body = '') => ({
  ok: true, status: 200,
  json: async () => ({ tag_name: tag, body, assets: names.map((n) => ({ name: n, size: 10, browser_download_url: `https://github.com/djgragra/dead-air-watchdog/releases/download/${tag}/${n}` })) })
});

test('versions: newer, equal, older', () => {
  assert.ok(isNewer('26.10.3', '26.10.2'));
  assert.ok(isNewer('26.11.1', '26.10.9'));
  assert.ok(!isNewer('26.10.2', '26.10.2'));
  assert.ok(!isNewer('26.9.9', '26.10.1'));
  assert.ok(isNewer('v26.10.10', '26.10.9'));
});

test('check: offers a newer release, ignores an older one, only this repository\'s URLs are followed', async () => {
  const names = [NAME, 'SHA256SUMS.txt'];
  const r = await checkForUpdate({ current: '26.10.2', fetchFn: async () => release('v26.10.3', names, '## Notes\n- one') });
  assert.equal(r.available, true);
  assert.equal(r.latest, '26.10.3');
  assert.equal(r.url, 'https://github.com/djgragra/dead-air-watchdog/releases/tag/v26.10.3');
  assert.equal(r.notes, 'Notes\none');
  const same = await checkForUpdate({ current: '26.10.3', fetchFn: async () => release('v26.10.3', names) });
  assert.equal(same.available, false);
  const evil = await checkForUpdate({ current: '26.10.2', fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ tag_name: 'v26.10.4', assets: [{ name: 'Dead-Air-Watchdog-Setup-26.10.4.exe', browser_download_url: 'https://evil.example/Dead-Air-Watchdog-Setup-26.10.4.exe' }] }) }) });
  assert.equal(evil.installer, null);
  assert.equal((await checkForUpdate({ current: '1', fetchFn: async () => ({ ok: false, status: 404 }) })).available, false);
  assert.equal((await checkForUpdate({ current: '1', fetchFn: async () => ({ ok: false, status: 500 }) })).ok, false);
  assert.equal((await checkForUpdate({ repo: 'not a repo', current: '1', fetchFn: async () => release('v1', []) })).error, 'invalid-repo');
});

test('installer choice per system, Intel Macs with or without the -x64 suffix', () => {
  const a = [{ name: 'Dead-Air-Watchdog-26.10.3-arm64.dmg' }, { name: 'Dead-Air-Watchdog-26.10.3.dmg' }, { name: NAME }, { name: 'Dead-Air-Watchdog-26.10.3.AppImage' }];
  assert.equal(pickInstaller(a, 'win32', 'x64').name, NAME);
  assert.equal(pickInstaller(a, 'darwin', 'arm64').name, 'Dead-Air-Watchdog-26.10.3-arm64.dmg');
  assert.equal(pickInstaller(a, 'darwin', 'x64').name, 'Dead-Air-Watchdog-26.10.3.dmg');
  assert.equal(pickInstaller([{ name: 'Dead-Air-Watchdog-26.10.4-x64.dmg' }], 'darwin', 'x64').name, 'Dead-Air-Watchdog-26.10.4-x64.dmg');
  assert.equal(pickInstaller([{ name: 'Dead-Air-Watchdog-26.10.4-x64.dmg' }], 'darwin', 'arm64'), null);
  assert.equal(pickInstaller(a, 'linux', 'x64').name, 'Dead-Air-Watchdog-26.10.3.AppImage');
  assert.equal(pickInstaller(a, 'linux', 'arm64'), null);
  assert.equal(PRODUCT, 'Dead-Air-Watchdog');
});

test('release notes summary is plain text and short', () => {
  assert.equal(releaseNotesSummary('# Title\n\n- **one**\n- two', 2), 'Title\none');
  assert.ok(releaseNotesSummary('x'.repeat(2000)).length <= 500);
});

// ---- remind later, skip, safety copy, install plan, what's new ----------------------------------------------

test('banner: shown, snoozed 24 hours, skipped until a newer version', () => {
  const i = { ok: true, available: true, latest: '26.10.3' };
  const t0 = 1_000_000;
  assert.equal(bannerState(i, {}, t0), 'show');
  const later = remindLaterState({}, t0);
  assert.equal(bannerState(i, later, t0 + 3_600_000), 'snoozed');
  assert.equal(bannerState(i, later, t0 + 86_400_001), 'show');
  const skipped = skipVersionState(later, '26.10.3');
  assert.equal(bannerState(i, skipped, t0), 'skipped');
  assert.equal(bannerState({ ...i, latest: '26.10.4' }, skipped, t0), 'show');
  assert.equal(bannerState({ ok: true, available: false }, {}, t0), 'none');
  assert.equal(bannerState(null, {}, t0), 'none');
});

test('safety copy is written before the install and only the last 3 are kept', async () => {
  const dir = tmp();
  const file = path.join(dir, 'dead-air-watchdog-data.json');
  fs.writeFileSync(file, '{"settings":{"language":"it"}}');
  const backups = path.join(dir, 'backups');
  for (const v of ['26.10.0', '26.10.1', '26.10.2', '26.10.3']) {
    const target = makeSafetyCopy({ file, dir: backups, version: v });
    assert.equal(fs.readFileSync(target, 'utf8'), '{"settings":{"language":"it"}}');
    const t = new Date(Date.now() + Number(v.split('.')[2]) * 1000);
    fs.utimesSync(target, t, t);
  }
  assert.deepEqual(fs.readdirSync(backups).sort(), ['pre-update-26.10.1.json', 'pre-update-26.10.2.json', 'pre-update-26.10.3.json']);
  assert.equal(makeSafetyCopy({ file: path.join(dir, 'missing.json'), dir: backups, version: 'x' }), null);
});

test('install plan per system', () => {
  assert.equal(installPlan('win32', 'a.exe').quit, true);
  assert.equal(installPlan('darwin', 'a.dmg').hint, 'mac');
  assert.equal(installPlan('linux', 'a.AppImage').kind, 'reveal');
});

test('what\'s new: the bullets of one version, first start after an update', () => {
  const log = '# Changelog\n\n## 26.10.3 — 2026-10-13\n\n- **A**: one\n- two\n\n## 26.10.2 — 2026-10-02\n\n- old\n';
  assert.deepEqual(whatsNew(log, '26.10.3'), { version: '26.10.3', date: '2026-10-13', bullets: ['**A**: one', 'two'] });
  assert.equal(whatsNew(log, '26.10.9'), null);
  assert.equal(startupKind('', '26.10.3', false), 'first');
  assert.equal(startupKind('', '26.10.3', true), 'updated');
  assert.equal(startupKind('26.10.2', '26.10.3'), 'updated');
  assert.equal(startupKind('26.10.3', '26.10.3'), 'same');
});

test('the changelog in the package has a What\'s new for the version in package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const log = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  assert.ok(whatsNew(log, pkg.version), `CHANGELOG.md has no bullets for ${pkg.version}`);
  assert.ok(pkg.build.files.includes('CHANGELOG.md'), 'CHANGELOG.md must be packaged with the app');
});
