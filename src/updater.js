// Guided update: asks GitHub for the latest release of the public repository, and on request
// downloads the installer for this system, checks it against the release's SHA256SUMS.txt and
// leaves it in the Downloads folder. Nothing is installed or started automatically.
// Electron-free: fetch and version are injected, so it can be tested.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_RE } from './store.js';

const PRODUCT = 'Dead-Air-Watchdog';

function parts(v) {
  return String(v || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
}

export function isNewer(latest, current) {
  const a = parts(latest);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// Only download URLs that belong to this repository's releases are ever followed.
function releaseAssets(repo, rel) {
  const prefix = `https://github.com/${repo}/releases/download/`;
  return (rel.assets || [])
    .filter((a) => typeof a.browser_download_url === 'string' && a.browser_download_url.startsWith(prefix))
    .map((a) => ({ name: String(a.name), url: a.browser_download_url, size: a.size || 0 }));
}

// Installer names are set in package.json (build.*.artifactName).
export function pickInstaller(assets, platform = process.platform, arch = process.arch) {
  const tests = {
    win32: (n) => new RegExp(`^${PRODUCT}-Setup-[\\d.]+\\.exe$`, 'i').test(n),
    darwin: (n) => new RegExp(`^${PRODUCT}-[\\d.]+-${arch === 'arm64' ? 'arm64' : 'x64'}\\.dmg$`, 'i').test(n),
    linux: (n) => arch === 'x64' && new RegExp(`^${PRODUCT}-[\\d.]+\\.AppImage$`, 'i').test(n)
  };
  const test = tests[platform];
  return (test && assets.find((a) => test(a.name))) || null;
}

export async function checkForUpdate({ repo, current, fetchFn }) {
  if (!REPO_RE.test(repo || '')) return { ok: false, current, error: 'invalid-repo' };
  try {
    const res = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `${PRODUCT}/${current}` },
      signal: AbortSignal.timeout(15_000)
    });
    if (res.status === 404) return { ok: true, current, available: false, note: 'no-release' };
    if (!res.ok) return { ok: false, current, error: `GitHub HTTP ${res.status}` };
    const rel = await res.json();
    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    const assets = releaseAssets(repo, rel);
    return {
      ok: true,
      current,
      latest,
      available: isNewer(latest, current),
      url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(rel.tag_name || '')}`,
      installer: pickInstaller(assets),
      sumsUrl: assets.find((a) => a.name === 'SHA256SUMS.txt')?.url || null
    };
  } catch (err) {
    return { ok: false, current, error: err.message };
  }
}

// Written as "<name>.part"; it gets its real name only when the checksum matches.
export async function downloadInstaller({ info, dir, fetchFn, current, onProgress }) {
  if (!info?.installer) throw new Error('no-installer');
  if (!info.sumsUrl) throw new Error('no-checksums');
  const { name, url } = info.installer;
  const headers = { 'User-Agent': `${PRODUCT}/${current}` };

  const sumsRes = await fetchFn(info.sumsUrl, { headers, signal: AbortSignal.timeout(30_000) });
  if (!sumsRes.ok) throw new Error(`SHA256SUMS.txt: HTTP ${sumsRes.status}`);
  const line = (await sumsRes.text()).split('\n').map((l) => l.trim().split(/\s+\*?/)).find((p) => p[1] === name);
  if (!line || !/^[0-9a-f]{64}$/i.test(line[0])) throw new Error('no-checksums');
  const expected = line[0].toLowerCase();

  const res = await fetchFn(url, { headers });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || info.installer.size || 0;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, path.basename(name));
  const partial = `${file}.part`;
  const out = fs.createWriteStream(partial);
  const hash = crypto.createHash('sha256');
  let received = 0;
  let lastReport = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      received += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
      const now = Date.now();
      if (onProgress && now - lastReport > 250) {
        lastReport = now;
        onProgress(received, total);
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    fs.rmSync(partial, { force: true });
    throw err;
  }
  onProgress?.(received, total);
  if (hash.digest('hex') !== expected) {
    fs.rmSync(partial, { force: true });
    throw new Error('checksum-mismatch');
  }
  fs.renameSync(partial, file);
  return file;
}
