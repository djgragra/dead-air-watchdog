// Screenshots for the README and the site. The content is invented (no real streams, names, paths or
// addresses). They are taken with Chromium (the engine Electron uses for the window) on the real files of
// renderer/, with a stand-in for the preload API: the packaged app, native dialogs and the keystore are NOT
// exercised. Run: node dev/make-screenshots.mjs [outputDir]
// Needs Playwright with a Chromium (not a dependency of the app): `npm i -g playwright` or PLAYWRIGHT_MODULE=<path>.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || path.join(root, 'docs', 'screenshots'));
fs.mkdirSync(outDir, { recursive: true });

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const tries = [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core', path.join(execSync('npm root -g').toString().trim(), 'playwright')].filter(Boolean);
  for (const m of tries) {
    try {
      return req(m);
    } catch {
      /* next */
    }
  }
  throw new Error('Playwright not found (npm i -g playwright, or set PLAYWRIGHT_MODULE)');
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }).end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- invented data -------------------------------------------------------------------------------------------
const NOW = Date.now();
const MIN = 60_000;
const settings = (theme) => ({
  language: 'en', theme,
  inputs: [
    { id: 'in-a', type: 'device', name: 'Studio A — on air', deviceId: '', deviceLabel: 'Line input 1-2', channelPair: 0, streamUrl: '', thresholdDb: -50, minSilenceSec: 30, enabled: true },
    { id: 'in-b', type: 'stream', name: 'Web stream', deviceId: '', deviceLabel: '', channelPair: 0, streamUrl: 'http://stream.example.org:8000/live', thresholdDb: -50, minSilenceSec: 20, enabled: true },
    { id: 'in-c', type: 'stream', name: 'Backup feed', deviceId: '', deviceLabel: '', channelPair: 0, streamUrl: 'http://backup.example.org:8000/live', thresholdDb: -45, minSilenceSec: 15, enabled: true }
  ],
  installationName: 'Control room',
  display: { edgeGlow: 'wall', startInWall: false, wallNameSize: 'auto', wallLogo: 'large', wallLogoOpacity: 0.2, wallClock: 'max' },
  notifications: {
    desktop: true, reminderMin: 10, sound: { enabled: true, volume: 0.6 },
    email: { enabled: true, host: 'smtp.example.org', port: 587, secure: false, user: 'watchdog', pass: '', from: 'watchdog@example.org', recipients: ['engineer@example.org', 'duty.manager@example.org', 'oncall@example.org'] },
    telegram: { enabled: true, botToken: '', recipients: [{ chatId: '100200300', note: 'Engineer on duty' }, { chatId: '100200301', note: 'Station manager' }] },
    webhook: { enabled: false, url: '', method: 'POST', authHeader: '' },
    updateAlert: true,
    grouping: { enabled: true, windowSec: 60, firstNow: true }
  },
  general: { microSilences: true, startOnBoot: true, startMinimized: false, autoStartMonitoring: true, keepAwake: true, retentionDays: 365, microRetentionDays: 30, checkUpdates: true, updateRepo: 'djgragra/dead-air-watchdog' },
  heartbeat: { enabled: true, url: 'https://ping.example.org/demo', intervalMin: 5 },
  micExplained: true, closeHintShown: true,
  updateState: { skipVersion: '', remindUntil: 0, lastCheck: { at: NOW - 3 * 3600_000, ok: true, error: '' } }, lastSeenVersion: '', window: { x: null, y: null, width: 1180, height: 780, compact: false, alwaysOnTop: false, maximized: false }
});
const mkStatus = (names) => ({
  running: true, overall: 'alarm', counts: { ok: 2, counting: 0, alarm: 1, starting: 0 }, startedAt: NOW - 3 * 3600_000 - 12 * MIN,
  inputs: [
    { id: 'in-a', name: names[0], type: 'device', enabled: true, thresholdDb: -50, minSilenceSec: 30, channelPair: 0, state: 'ok', cause: null, fault: null, elapsedMs: 0, remainingMs: 0, silenceStart: null },
    { id: 'in-b', name: names[1], type: 'stream', enabled: true, thresholdDb: -50, minSilenceSec: 20, channelPair: 0, state: 'ok', cause: null, fault: null, elapsedMs: 0, remainingMs: 0, silenceStart: null },
    { id: 'in-c', name: names[2], type: 'stream', enabled: true, thresholdDb: -45, minSilenceSec: 15, channelPair: 0, state: 'alarm', cause: 'silence', fault: null, elapsedMs: 94_000, remainingMs: 0, silenceStart: NOW - 94_000 }
  ]
});
const status = mkStatus(['Studio A — on air', 'Web stream', 'Backup feed']);
const statusLong = mkStatus(['Regional Studio A — main on-air programme feed', 'Web stream: the whole evening and weekend schedule', 'Backup relay for the mountain transmitter, second mount']);
const ev = (i, kind, cause, ago, dur, inputId, input) => ({ id: `e${i}`, kind, cause, start: NOW - ago * MIN, end: dur == null ? null : NOW - ago * MIN + dur * 1000, input, inputId, thresholdDb: -50, minSilenceSec: 30 });
const events = [
  ev(1, 'dead-air', 'silence', 1.6, null, 'in-c', 'Backup feed'),
  ev(2, 'dead-air', 'offline', 190, 214, 'in-b', 'Web stream'),
  ev(3, 'dead-air', 'silence', 26 * 60 + 40, 47, 'in-a', 'Studio A — on air'),
  ev(4, 'gap', 'offline', 30 * 60, 3 * 60, '', ''),
  ev(5, 'dead-air', 'silence', 2 * 1440 + 300, 128, 'in-b', 'Web stream'),
  ev(6, 'dead-air', 'silence', 4 * 1440 + 90, 35, 'in-a', 'Studio A — on air'),
  ev(7, 'dead-air', 'offline', 6 * 1440 + 600, 410, 'in-c', 'Backup feed'),
  { ...ev(8, 'blip', 'silence', 12, 3, 'in-b', 'Web stream') },
  { ...ev(9, 'blip', 'late', 47, 2, 'in-b', 'Web stream') },
  { ...ev(10, 'blip', 'nodata', 95, 4, 'in-b', 'Web stream') },
  { ...ev(11, 'blip', 'silence', 130, 1, 'in-a', 'Studio A — on air') },
  { ...ev(12, 'pause', 'maintenance', 240, 3600, 'in-c', 'Backup feed'), until: NOW - 180 * MIN }
].sort((a, b) => b.start - a.start);
const daily = Array.from({ length: 7 }, (_, i) => {
  const d = new Date(NOW - (6 - i) * 86_400_000);
  const count = [0, 1, 0, 2, 0, 1, 2][i];
  return { date: d.toISOString().slice(0, 10), count, totalMs: count * 95_000, longestMs: count ? 120_000 : 0 };
});

const initScript = ({ settings, status, events, daily, APP_VERSION, extra }) => {
  Object.assign(window, extra || {});
  if (window.__withLogos) {
    // invented logos: a transparent PNG each (round badge with letters), the last one with its own white background
    const make = (letters, colour, opaque) => {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const g = c.getContext('2d');
      if (opaque) {
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, 256, 256);
      }
      g.fillStyle = colour;
      g.beginPath();
      g.arc(128, 128, 118, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#fff';
      g.font = 'bold 96px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(letters, 128, 136);
      return c.toDataURL('image/png');
    };
    window.__logos = Object.fromEntries(settings.inputs.map((inp, i) => [inp.id, make(['SA', 'WS', 'BF'][i % 3], ['#2f4fa8', '#1d8a6a', '#a8552f'][i % 3], i === 2)]));
  }
  const h = () => () => {};
  const resolved = (v) => () => Promise.resolve(v);
  window.__fire = {};
  const on = (name) => (cb) => ((window.__fire[name] = cb), h());
  window.api = {
    platform: 'win32',
    settings: { get: resolved(settings), update: (p) => Promise.resolve({ ...settings, ...p }) },
    monitor: { start: resolved(status), stop: resolved(status), status: resolved(status), muteAlarm: resolved(), pause: resolved({ ok: true }) },
    events: { list: resolved(events), export: resolved({ ok: false }), clear: resolved() },
    stats: { daily: resolved(daily) },
    wall: { set: resolved() },
    window: { setView: (key, on) => Promise.resolve({ ...settings, window: { ...settings.window, [key]: on } }) },
    audio: { devices: resolved({ granted: true, devices: [] }), accessStatus: resolved('granted'), testSound: resolved() },
    notifications: { test: resolved({ ok: true }) },
    backup: { export: resolved({ ok: true, file: 'C:\\Users\\Demo\\Documents\\dead-air-watchdog-backup-2026-10-11.json' }), import: resolved({ ok: false, canceled: true }) },
    logos: { all: resolved(window.__logos || {}), set: resolved({ ok: true }), remove: resolved({ ok: true }) },
    heartbeat: { test: resolved({ ok: true }) },
    updates: {
      check: resolved(window.__update || { info: { ok: true, available: false, current: APP_VERSION, latest: APP_VERSION }, banner: 'none', lastCheck: settings.updateState.lastCheck, downloaded: null }),
      state: resolved(window.__update || { info: null, banner: 'none', lastCheck: settings.updateState.lastCheck, downloaded: null }),
      download: resolved({ ok: true, file: 'x' }), cancel: resolved(true), remind: resolved(), skip: resolved(), install: resolved({ ok: true, kind: 'run-installer' }), reveal: resolved(), openPage: resolved(),
      whatsNew: resolved(window.__whatsNew || null), whatsNewSeen: resolved(true)
    },
    delivery: { get: resolved([]) },
    app: { info: resolved({ version: APP_VERSION, platform: 'win32', arch: 'x64', packaged: true, host: 'STUDIO-PC', logsDir: '' }), openExternal: resolved(), supportInfo: resolved('Dead Air Watchdog'), openLogs: resolved() },
    on: { status: on('status'), levels: on('levels'), eventsChanged: on('eventsChanged'), updateAvailable: on('updateAvailable'), updateProgress: on('updateProgress'), settingsChanged: on('settingsChanged'), delivery: on('delivery'), wallExit: on('wallExit') }
  };
};

// n invented stations (a big installation): all in a good state, a few in trouble, one switched off
const bigSetup = (n, theme) => {
  const names = ['Main', 'North', 'South', 'East', 'West', 'City', 'Coast', 'Hills', 'Lake', 'Valley', 'Port', 'Metro', 'Sport', 'News', 'Classic', 'Rock'];
  const inputs = Array.from({ length: n }, (_, i) => ({ id: `big-${i}`, type: 'stream', name: `${names[i % names.length]} FM ${String(i + 1).padStart(2, '0')}`, deviceId: '', deviceLabel: '', channelPair: 0, streamUrl: `http://stream${(i % 3) + 1}.example.org:8000/mount${i + 1}`, thresholdDb: -50, minSilenceSec: 20, enabled: i !== n - 3 }));
  const st = {
    running: true, overall: 'alarm', counts: { ok: n - 3, counting: 0, alarm: 1, starting: 0 }, startedAt: NOW - 3600_000,
    inputs: inputs.map((inp, i) => ({ id: inp.id, name: inp.name, type: 'stream', enabled: inp.enabled, thresholdDb: -50, minSilenceSec: 20, channelPair: 0, state: !inp.enabled ? 'off' : i === 4 ? 'alarm' : 'ok', cause: i === 4 ? 'offline' : null, fault: null, elapsedMs: i === 4 ? 61_000 : 0, remainingMs: 0, silenceStart: i === 4 ? NOW - 61_000 : null }))
  };
  return { settings: { ...settings(theme), inputs }, status: st };
};

const APP_VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; // the version shown in the window
const { chromium } = loadPlaywright();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
async function shoot(file, theme, steps, st = status, cfg = null, extra = {}, size = { width: 1240, height: 800 }) {
  const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 2, colorScheme: theme === 'light' ? 'light' : 'dark' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.addInitScript(initScript, { settings: cfg || settings(theme), status: st, events, daily, APP_VERSION, extra });
  await page.goto(`${base}/renderer/index.html`);
  await page.waitForSelector('.nav__item', { state: 'attached' });
  await page.waitForTimeout(400);
  await steps(page);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(outDir, file) });
  await ctx.close();
  console.log('wrote', file);
}
const view = (page, name) => page.click(`.nav__item[data-view="${name}"]`);
const levels = (page) => page.evaluate(() => window.__fire.levels?.({ 'in-a': { rms: [-21, -23], peak: [-9, -11] }, 'in-b': { rms: [-24, -24], peak: [-12, -13] }, 'in-c': { rms: [-78, -80], peak: [-70, -72] } }));

await shoot('01-dashboard.png', 'dark', async (page) => {
  await levels(page);
});
await shoot('02-event-log.png', 'dark', async (page) => view(page, 'log'));
await shoot('03-alerts.png', 'light', async (page) => {
  await view(page, 'settings');
  await page.click('.tab[data-tab="alerts"]');
  await page.evaluate(() => document.getElementById('mTo').scrollIntoView({ block: 'center' }));
});
await shoot('04-backup.png', 'light', async (page) => {
  await view(page, 'settings');
  await page.click('.tab[data-tab="backup"]');
  await page.check('#bkSecrets');
  await page.click('#bkExport');
  await page.locator('#bkCard').scrollIntoViewIfNeeded();
});
await shoot('05-wall-display.png', 'dark', async (page) => {
  await page.click('#wallBtn');
  await page.waitForTimeout(500);
  await levels(page);
}, statusLong);
await shoot('06-inputs-order.png', 'light', async (page) => {
  await view(page, 'settings');
  await page.evaluate(() => document.querySelectorAll('#inputsList .input').forEach((d) => (d.open = false)));
  await page.evaluate(() => document.querySelector('#view-settings').scrollIntoView({ block: 'start' }));
}, statusLong);
const big = bigSetup(32, 'dark');
await shoot('07-wall-32-inputs.png', 'dark', async (page) => {
  await page.click('#wallBtn');
  await page.waitForTimeout(500);
  await page.evaluate((ids) => window.__fire.levels?.(Object.fromEntries(ids.map((id, i) => [id, { rms: [-18 - (i % 9) * 2.5, -19 - (i % 7) * 2.5], peak: [-8, -9] }]))), big.status.inputs.map((i) => i.id));
}, big.status, big.settings);
await shoot('08-invalid-field.png', 'light', async (page) => {
  await view(page, 'settings');
  await page.evaluate(() => document.querySelectorAll('#inputsList .input')[1].setAttribute('open', ''));
  await page.fill('#inputsList .input:nth-child(2) .in-url', 'stream.example.org/live');
  await page.click('#saveBtn, button[type="submit"]');
  await page.waitForTimeout(300);
}, status);
// ---- 26.10.6: micro-silences, update banner, logos in the wall display, welcome ----
await shoot('09-micro-silences.png', 'dark', async (page) => {
  await view(page, 'log');
  await page.click('[data-filter="blip"]');
});
const upd = (phase) => ({ info: { ok: true, available: true, current: APP_VERSION, latest: '26.10.7', notes: 'Micro-silences, pause of the alerts for one input, grouped alerts', installer: { name: 'x', size: 1 }, canDownload: true }, banner: 'show', lastCheck: settings('dark').updateState.lastCheck, downloaded: phase === 'ready' ? 'Dead-Air-Watchdog-Setup-26.10.7.exe' : null });
await shoot('10-update-banner.png', 'dark', async () => {}, status, null, { __update: upd('idle') });
await shoot('11-update-settings.png', 'light', async (page) => {
  await view(page, 'settings');
  await page.click('.tab[data-tab="updates"]');
}, status, null, { __update: upd('ready') });
await shoot('12-wall-large-logo.png', 'dark', async (page) => {
  await page.click('#wallBtn');
  await page.waitForTimeout(500);
  await levels(page);
}, status, null, { __withLogos: true });
const fadedCfg = settings('dark');
fadedCfg.display.wallLogo = 'faded';
fadedCfg.display.wallClock = 'large';
await shoot('13-wall-faded-logo.png', 'dark', async (page) => {
  await page.click('#wallBtn');
  await page.waitForTimeout(500);
  await levels(page);
}, status, fadedCfg, { __withLogos: true });
const pausedStatus = JSON.parse(JSON.stringify(status));
Object.assign(pausedStatus.inputs[2], { state: 'paused', pausedUntil: NOW + 50 * MIN, cause: null, elapsedMs: 0, silenceStart: null });
Object.assign(pausedStatus, { overall: 'ok', counts: { ok: 2, counting: 0, alarm: 0, starting: 0 } });
await shoot('14-paused-input.png', 'dark', async (page) => {
  await levels(page);
  await page.click('.tile:nth-child(2) .tile__pause');
}, pausedStatus);
await shoot('15-welcome.png', 'dark', async () => {}, { running: false, overall: 'idle', counts: {}, inputs: [], startedAt: null }, { ...settings('dark'), inputs: [] });
await shoot('16-settings-general.png', 'light', async (page) => {
  await view(page, 'settings');
  await page.click('.tab[data-tab="general"]');
});
// ---- 26.10.11: compact view and micro-silences switched off for one input ----
const compactCfg = settings('dark');
compactCfg.window = { ...compactCfg.window, compact: true, alwaysOnTop: true };
await shoot('19-compact-view.png', 'dark', async (page) => {
  await levels(page);
}, status, compactCfg, {}, { width: 400, height: 190 });
const microCfg = settings('dark');
microCfg.general.microSilences = true;
microCfg.inputs[1].microSilences = 'off';
await shoot('20-micro-silences-off.png', 'light', async (page) => {
  await view(page, 'settings');
  await page.evaluate(() => {
    const card = document.querySelectorAll('#inputsList .input')[1];
    card.setAttribute('open', '');
    card.querySelector('.input__adv').setAttribute('open', '');
    card.querySelector('.in-micro').scrollIntoView({ block: 'center' });
  });
}, status, microCfg);
await browser.close();
server.close();
