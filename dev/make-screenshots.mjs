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
  display: { edgeGlow: 'wall', startInWall: false, wallNameSize: 'auto' },
  notifications: {
    desktop: true, reminderMin: 10, sound: { enabled: true, volume: 0.6 },
    email: { enabled: true, host: 'smtp.example.org', port: 587, secure: false, user: 'watchdog', pass: '', from: 'watchdog@example.org', recipients: ['engineer@example.org', 'duty.manager@example.org', 'oncall@example.org'] },
    telegram: { enabled: true, botToken: '', recipients: [{ chatId: '100200300', note: 'Engineer on duty' }, { chatId: '100200301', note: 'Station manager' }] },
    updateAlert: true
  },
  general: { startOnBoot: true, startMinimized: false, autoStartMonitoring: true, keepAwake: true, retentionDays: 365, checkUpdates: true, updateRepo: 'djgragra/dead-air-watchdog' },
  heartbeat: { enabled: true, url: 'https://ping.example.org/demo', intervalMin: 5 },
  micExplained: true, closeHintShown: true
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
  ev(7, 'dead-air', 'offline', 6 * 1440 + 600, 410, 'in-c', 'Backup feed')
];
const daily = Array.from({ length: 7 }, (_, i) => {
  const d = new Date(NOW - (6 - i) * 86_400_000);
  const count = [0, 1, 0, 2, 0, 1, 2][i];
  return { date: d.toISOString().slice(0, 10), count, totalMs: count * 95_000, longestMs: count ? 120_000 : 0 };
});

const initScript = ({ settings, status, events, daily }) => {
  const h = () => () => {};
  const resolved = (v) => () => Promise.resolve(v);
  window.__fire = {};
  const on = (name) => (cb) => ((window.__fire[name] = cb), h());
  window.api = {
    platform: 'win32',
    settings: { get: resolved(settings), update: (p) => Promise.resolve({ ...settings, ...p }) },
    monitor: { start: resolved(status), stop: resolved(status), status: resolved(status), muteAlarm: resolved() },
    events: { list: resolved(events), export: resolved({ ok: false }), clear: resolved() },
    stats: { daily: resolved(daily) },
    wall: { set: resolved() },
    audio: { devices: resolved({ granted: true, devices: [] }), accessStatus: resolved('granted'), testSound: resolved() },
    notifications: { test: resolved({ ok: true }) },
    backup: { export: resolved({ ok: true, file: 'C:\\Users\\Demo\\Documents\\dead-air-watchdog-backup-2026-10-11.json' }), import: resolved({ ok: false, canceled: true }) },
    logos: { all: resolved({}), set: resolved({ ok: true }), remove: resolved({ ok: true }) },
    heartbeat: { test: resolved({ ok: true }) },
    updates: { check: resolved({ ok: true, available: false, current: '26.10.2', latest: '26.10.2' }), download: resolved({ ok: false }), reveal: resolved(), openPage: resolved() },
    delivery: { get: resolved([]) },
    app: { info: resolved({ version: '26.10.2', platform: 'win32', arch: 'x64', packaged: true, host: 'STUDIO-PC' }), openExternal: resolved() },
    on: { status: on('status'), levels: on('levels'), eventsChanged: on('eventsChanged'), updateAvailable: on('updateAvailable'), updateProgress: on('updateProgress'), settingsChanged: on('settingsChanged'), delivery: on('delivery'), wallExit: on('wallExit') }
  };
};

const { chromium } = loadPlaywright();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
async function shoot(file, theme, steps, st = status) {
  const ctx = await browser.newContext({ viewport: { width: 1240, height: 800 }, deviceScaleFactor: 2, colorScheme: theme === 'light' ? 'light' : 'dark' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.addInitScript(initScript, { settings: settings(theme), status: st, events, daily });
  await page.goto(`${base}/renderer/index.html`);
  await page.waitForSelector('.nav__item');
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
  await page.evaluate(() => document.getElementById('mTo').scrollIntoView({ block: 'center' }));
});
await shoot('04-backup.png', 'light', async (page) => {
  await view(page, 'settings');
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
await browser.close();
server.close();
