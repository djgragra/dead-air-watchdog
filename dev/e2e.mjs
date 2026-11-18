// End-to-end run of the real app: Electron 44, the Rust engine, a live stream made by ffmpeg, Playwright.
// Not part of `npm test` (it needs a display and Playwright): xvfb-run -a node dev/e2e.mjs [folder for screenshots]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import electronPath from 'electron';
import { liveServer, FORMATS, root, enginePath } from './helpers.js';
import { wallGrid } from '../src/core/wall-grid.js';

const require = createRequire(path.join(execSync('npm root -g').toString().trim(), '/'));
const { _electron } = require('playwright');
const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'daw-e2e-'));
fs.mkdirSync(shots, { recursive: true });

const { server, url } = await liveServer(FORMATS.mp3, { toneSec: 8, silenceSec: 60, peakDb: -20 });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'daw-ud-'));
const app = await _electron.launch({
  executablePath: electronPath,
  args: [root, '--no-sandbox'],
  env: { ...process.env, DAW_USER_DATA: userData, DAW_ENGINE: enginePath },
});
// the app has a hidden window that plays the alarm sound: the one to drive is the window of the interface
await app.firstWindow();
const findMain = () => app.windows().find((w) => w.url().endsWith('index.html'));
for (let i = 0; i < 100 && !findMain(); i++) await new Promise((r) => setTimeout(r, 100));
const page = findMain();
await page.waitForFunction(() => !!window.api);
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) process.exitCode = 1; };
const status = () => page.evaluate(() => window.api.monitor.status());
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};
await page.setViewportSize({ width: 1180, height: 780 });
await page.waitForSelector('body', { state: 'attached' });
await new Promise((r) => setTimeout(r, 1500));

const info = await page.evaluate(() => window.api.app?.info?.() ?? null);
check(true, `app started${info ? ` (${info.version})` : ''}`);


// ---- shared logos (0.2.2): two inputs of one station share a logo, a third one picks it from the library
const logoDir = path.join(userData, 'logos');
const dataUrl = (color) => page.evaluate((c) => { const cv = document.createElement('canvas'); cv.width = cv.height = 64; const g = cv.getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, 64, 64); return cv.toDataURL('image/png'); }, color);
const red = await dataUrl('#c0392b');
const id1 = (await page.evaluate((u) => window.api.logos.add(u), red)).id;
const id1again = (await page.evaluate((u) => window.api.logos.add(u), red)).id;
check(id1 && id1 === id1again, `the same picture added twice is one logo (${id1})`);
const id2 = (await page.evaluate((u) => window.api.logos.add(u), await dataUrl('#2980b9'))).id;
check(fs.readdirSync(logoDir).length === 2 && id2 !== id1, 'two different pictures are two files');
// (a logo nobody uses is deleted when the settings are saved: id2 is given to the third input below)

const base = { type: 'stream', thresholdDb: -50, minSilenceSec: 3, yellowDelaySec: 0, enabled: true };
await page.evaluate(({ url, base, id1, id2 }) => window.api.settings.update({
  micExplained: true, // the explanation of the microphone permission is a dialog: not the subject of this run
  inputs: [
    { ...base, id: 'live', name: 'Live stream', streamUrl: url, logo: id1 },
    { ...base, id: 'down', name: 'Unreachable stream', streamUrl: 'http://127.0.0.1:9/nothing', logo: id1 },
    { ...base, id: 'card', name: 'Missing card', type: 'device', deviceId: 'no-such-card', deviceLabel: 'A card that is gone', streamUrl: '', logo: id2 },
  ],
}), { url, base, id1, id2 });
await page.evaluate(() => window.api.monitor.start());

const ok = await until(async () => { const s = await status(); return s.inputs.find((i) => i.id === 'live')?.state === 'ok' && s; }, 20_000, 'the live stream is OK');
check(true, 'the live stream is OK while the tone plays');
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: path.join(shots, '1-ok.png') });
const st = await status();
const down = st.inputs.find((i) => i.id === 'down');
const card = st.inputs.find((i) => i.id === 'card');
check(down.fault === 'stream-error', `unreachable stream: fault ${down.fault}`);
check(card.fault === 'NotFoundError', `missing sound card: fault ${card.fault} (never swapped for another card)`);
check(['counting', 'alarm'].includes(down.state), `an input that delivers nothing is dead air: ${down.state}`);

await until(async () => (await status()).inputs.find((i) => i.id === 'live')?.state === 'alarm', 30_000, 'dead air on the live stream after the tone');
check(true, 'DEAD AIR on the live stream after the programme goes silent');
const events = await page.evaluate(() => window.api.events.list());
const dead = events.filter((e) => e.kind === 'dead-air' && e.inputId === 'live');
check(dead.length === 1 && dead[0].cause === 'silence', `one dead-air entry in the log, cause ${dead[0]?.cause}`);
await page.screenshot({ path: path.join(shots, '2-alarm.png') });


// the two inputs of the station show the same logo on their tiles
const withLogo = await page.evaluate(() => [...document.querySelectorAll('#tiles .tile')].map((t) => [t.dataset.id, t.classList.contains('has-logo')]));
check(withLogo.every((x) => x[1]), `every input has a logo on its tile: ${JSON.stringify(withLogo)}`);
await page.screenshot({ path: path.join(shots, '3-tiles-logo.png') });

// Settings → Inputs: the third input picks the logo that is already loaded
await page.click('.nav__item[data-view="settings"]');
await page.click('.tab[data-tab="inputs"]');
const card3 = page.locator('#inputsList details.input[data-id="card"]');
await card3.locator(':scope > summary').click();
await card3.locator('.in-logo-pick').click();
const thumbs = await card3.locator('.logo-pick').count();
check(thumbs === 2, `the picker shows the logos already loaded (${thumbs}), not one per input`);
const title = await card3.locator(`.logo-pick[data-logo="${id1}"]`).getAttribute('title');
check(/Live stream/.test(title) && /Unreachable stream/.test(title), `a logo says which inputs use it: ${title}`);
await page.screenshot({ path: path.join(shots, '4-picker.png') });
await card3.locator(`.logo-pick[data-logo="${id1}"]`).click();
await page.click('#saveBtn');
await until(async () => (await page.evaluate(() => window.api.settings.get())).inputs.find((i) => i.id === 'card')?.logo === id1, 5000, 'the third input has the shared logo');
check(JSON.stringify(fs.readdirSync(logoDir)) === JSON.stringify([`${id1}.png`]), 'the logo the third input left is deleted (nobody uses it); the shared one stays, once');

// the backup has the choice of the logos, on by default
await page.click('.tab[data-tab="backup"]');
check(await page.locator('#bkLogos').isChecked(), 'Backup: "Include the logos" is there, on by default');
await page.screenshot({ path: path.join(shots, '5-backup.png') });
await page.click('.tab[data-tab="inputs"]');

// removing the logo of one input does not touch the others; the unused logo is cleaned up
await page.evaluate(() => { document.querySelector('#inputsList details.input[data-id="card"]').open = true; }); // saving rebuilt the form: the card is closed again
await card3.locator('.in-logo-remove').click();
await page.click('#saveBtn');
await until(async () => (await page.evaluate(() => window.api.settings.get())).inputs.find((i) => i.id === 'card')?.logo === '', 5000, 'logo removed from the third input');
const st2 = await page.evaluate(() => window.api.settings.get());
check(st2.inputs.find((i) => i.id === 'live').logo === id1, 'the others keep the shared logo');
check(JSON.stringify(fs.readdirSync(logoDir)) === JSON.stringify([`${id1}.png`]), 'the shared logo is still there for the other two');


// ---- Wall display (0.2.3): the grid follows the real size of the area, not only the resize of the window. On the Mac the
// area was still changing while the window went full screen and the grid stayed on the first size for a few seconds.
await page.click('.nav__item[data-view="dashboard"]');
await page.click('#wallBtn');
await page.waitForFunction(() => document.body.classList.contains('wall'));
const gridNow = () => page.evaluate(() => {
  const b = document.getElementById('tiles');
  const cols = getComputedStyle(b).gridTemplateColumns.split(' ').length;
  const rows = getComputedStyle(b).gridTemplateRows.split(' ').length;
  return { w: b.clientWidth, h: b.clientHeight, cols, rows, n: b.children.length };
});
await new Promise((r) => setTimeout(r, 1500));
let g = await gridNow();
let want = wallGrid(g.n, g.w, g.h);
check(g.cols === want.cols && g.rows === want.rows, `wall: ${g.n} tiles in ${g.w}x${g.h} are ${g.cols}x${g.rows} (the best is ${want.cols}x${want.rows})`);
await page.screenshot({ path: path.join(shots, '6-wall.png') });
// the area gets another height WITHOUT a resize of the window: the grid has to follow by itself
await page.evaluate(() => { const b = document.getElementById('tiles'); b.style.flex = 'none'; b.style.height = '150px'; });
await new Promise((r) => setTimeout(r, 600));
g = await gridNow();
want = wallGrid(g.n, g.w, g.h);
check(g.h <= 160 && g.cols === want.cols && g.rows === want.rows, `wall: after the area became ${g.w}x${g.h} the grid is ${g.cols}x${g.rows} (the best is ${want.cols}x${want.rows})`);
await page.evaluate(() => { const b = document.getElementById('tiles'); b.style.flex = ''; b.style.height = ''; });
await new Promise((r) => setTimeout(r, 600));
g = await gridNow();
want = wallGrid(g.n, g.w, g.h);
check(g.cols === want.cols && g.rows === want.rows, `wall: back to ${g.w}x${g.h}: ${g.cols}x${g.rows} (the best is ${want.cols}x${want.rows})`);
await page.click('#wallExit');
await page.waitForFunction(() => !document.body.classList.contains('wall'));

await page.evaluate(() => window.api.monitor.stop());
await until(async () => !(await status()).running, 5000, 'stopped');
check(true, 'monitoring stopped; the engine closed the inputs');
check(errors.length === 0, `no errors in the window console ${errors.length ? JSON.stringify(errors) : ''}`);
await app.close();
server.closeAllConnections?.();
server.close();
console.log(`screenshots: ${shots}`);
