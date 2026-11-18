// End-to-end run of the view by station in the real app (Electron + Rust engine + live streams made by ffmpeg).
// xvfb-run -a node dev/e2e-stations.mjs [folder for screenshots]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import electronPath from 'electron';
import { liveServer, FORMATS, root, enginePath } from './helpers.js';

const require = createRequire(path.join(execSync('npm root -g').toString().trim(), '/'));
const { _electron } = require('playwright');
const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'daw-e2e-st-'));
fs.mkdirSync(shots, { recursive: true });

const { server, url } = await liveServer(FORMATS.mp3, { toneSec: 120, silenceSec: 0, peakDb: -20 });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'daw-ud-st-'));
const app = await _electron.launch({ executablePath: electronPath, args: [root, '--no-sandbox'], env: { ...process.env, DAW_USER_DATA: userData, DAW_ENGINE: enginePath } });
await app.firstWindow();
const findMain = () => app.windows().find((w) => w.url().endsWith('index.html'));
for (let i = 0; i < 100 && !findMain(); i++) await new Promise((r) => setTimeout(r, 100));
const page = findMain();
await page.waitForFunction(() => !!window.api);
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) process.exitCode = 1; };
const until = async (fn, ms, what) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await new Promise((r) => setTimeout(r, 250)); } };
await new Promise((r) => setTimeout(r, 1500));

const dataUrl = (color) => page.evaluate((c) => { const cv = document.createElement('canvas'); cv.width = cv.height = 64; const g = cv.getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, 64, 64); return cv.toDataURL('image/png'); }, color);
const logoGR = (await page.evaluate((u) => window.api.logos.add(u), await dataUrl('#c0392b'))).id;
const logoNews = (await page.evaluate((u) => window.api.logos.add(u), await dataUrl('#2980b9'))).id;
const logoOwn = (await page.evaluate((u) => window.api.logos.add(u), await dataUrl('#27ae60'))).id;

const base = { type: 'stream', thresholdDb: -50, minSilenceSec: 60, yellowDelaySec: 0, enabled: true };
await page.evaluate(({ url, base, logoGR, logoNews, logoOwn }) => window.api.settings.update({
  micExplained: true,
  display: { view: 'stations' },
  stations: [
    { id: 'gr', name: 'Giornale Radio', logo: logoGR, featured: 'gr2' },
    { id: 'news', name: 'GRNews', logo: logoNews, featured: '' },
  ],
  inputs: [
    { ...base, id: 'gr1', name: 'Rete 1', streamUrl: url, stationId: 'gr' },
    { ...base, id: 'gr2', name: 'Rete 2', streamUrl: url, stationId: 'gr', logo: logoOwn },
    { ...base, id: 'n1', name: 'News main', streamUrl: url, stationId: 'news' },
    { ...base, id: 'n2', name: 'News backup', streamUrl: 'http://127.0.0.1:9/nothing', stationId: 'news' },
    { ...base, id: 'solo', name: 'Radio Podcast', streamUrl: url },
  ],
}), { url, base, logoGR, logoNews, logoOwn });
await page.evaluate(() => window.api.monitor.start());
await until(async () => { const s = await page.evaluate(() => window.api.monitor.status()); return ['gr1', 'gr2', 'n1', 'solo'].every((id) => s.inputs.find((i) => i.id === id)?.state === 'ok'); }, 25_000, 'the healthy streams are OK');
await new Promise((r) => setTimeout(r, 1500));

const info = () => page.evaluate(() => {
  const box = document.getElementById('tiles');
  const rows = [...box.children].map((c) => ({
    station: c.dataset.station || '', id: c.dataset.id || '', hidden: c.hidden, state: c.dataset.state,
    name: c.querySelector('.tile__name')?.textContent, note: c.querySelector('.tile__note:not(.hidden)')?.textContent || '', np: c.querySelector('.tile__np:not(.hidden)')?.textContent || '',
    logo: !!c.querySelector('.tile__logo:not(.hidden)'), open: c.classList.contains('is-open'),
    lvl: c.querySelector('.meter__num')?.textContent || ''
  }));
  return { view: document.body.dataset.view, rows };
});
let i = await info();
check(i.view === 'stations', 'the dashboard shows the view by station');
const st = (id) => i.rows.find((r) => r.station === id);
const mem = (id) => i.rows.find((r) => r.id === id);
check(st('gr') && st('news') && !st('gr').hidden && !st('news').hidden, 'two station tiles');
check(st('gr').name === 'Giornale Radio' && st('gr').logo, 'a station has its name and its logo');
check(['gr1', 'gr2'].every((id) => mem(id).hidden) && !mem('solo').hidden, 'closed stations hide their streams; a stream that is in no station is a tile of its own');
check(st('gr').state === 'ok', `station Giornale Radio is ${st('gr').state}`);
check(st('news').state === 'counting' && /1/.test(st('news').note), `GRNews shows yellow before any alarm: "${st('news').note}"`);
const dotsOf = (id) => page.evaluate((sid) => [...document.querySelectorAll(`.tile--station[data-station="${sid}"] .sdot`)].map((d) => d.dataset.state), id);
check((await dotsOf('gr')).join() === 'ok,ok', `a closed station shows a dot for each stream: ${(await dotsOf('gr')).join()}`);
check(/-2\d\.\d/.test(st('gr').lvl), `a closed station shows the level of its featured stream: ${st('gr').lvl}`);
await page.screenshot({ path: path.join(shots, '1-closed.png') });

// click: open and close
await page.click('.tile--station[data-station="gr"]');
await new Promise((r) => setTimeout(r, 300));
i = await info();
check(!mem('gr1').hidden && !mem('gr2').hidden && st('gr').open, 'a click opens the station: its streams appear');
check(mem('gr1').name === 'Rete 1' && mem('gr2').name === 'Rete 2', 'each stream has its own name');
await page.screenshot({ path: path.join(shots, '2-open.png') });
await page.click('.tile--station[data-station="gr"]');
await new Promise((r) => setTimeout(r, 300));
i = await info();
check(mem('gr1').hidden && !st('gr').open, 'another click closes it');

// dead air on a stream: the station opens by itself (the unreachable stream gets 3 s of patience)
await page.evaluate(async () => { const s = await window.api.settings.get(); await window.api.settings.update({ inputs: s.inputs.map((x) => (x.id === 'n2' ? { ...x, minSilenceSec: 3 } : x)) }); });
await until(async () => { i = await info(); return mem('n2') && st('news').open; }, 15_000, 'the station with the fallen stream opens by itself');
check(!mem('n1').hidden && !mem('n2').hidden && mem('n2').state === 'alarm', 'dead air on a stream opens its station on all its streams, in their states');
check(st('news').state === 'alarm' && mem('n1').state === 'ok', 'the station is in alarm, the healthy stream is still ok');
await page.click('.tile--station[data-station="news"]');
await new Promise((r) => setTimeout(r, 300));
i = await info();
check(st('news').open, 'a station in dead air cannot be closed');
check(mem('gr1').hidden, 'the other station stays closed');
await page.screenshot({ path: path.join(shots, '3-alarm.png') });

// the alert uses the name of the stream
const events = await page.evaluate(() => window.api.events.list());
const dead = events.find((e) => e.kind === 'dead-air' && e.inputId === 'n2');
check(dead && dead.input === 'GRNews · News backup', `the log and the alerts say station and stream: ${dead?.input}`);

// the wall display: the streams of an open station stand apart, closed stations are one tile
await page.click('#wallBtn');
await page.waitForFunction(() => document.body.classList.contains('wall'));
await new Promise((r) => setTimeout(r, 1500));
i = await info();
const visible = i.rows.filter((r) => !r.hidden);
check(visible.length === 5 && visible.some((r) => r.station === 'gr') && visible.some((r) => r.station === 'news') && visible.filter((r) => r.id === 'n1' || r.id === 'n2').length === 2, `wall: ${visible.length} tiles: the two stations (the open one stays), its two streams, the free stream`);
check(visible.find((r) => r.id === 'n2')?.name === 'News backup', `in the wall under its station a stream shows its own name: ${visible.find((r) => r.id === 'n2')?.name}`);
const grid = await page.evaluate(() => { const b = document.getElementById('tiles'); return { cols: getComputedStyle(b).gridTemplateColumns.split(' ').length, rows: getComputedStyle(b).gridTemplateRows.split(' ').length }; });
check(grid.cols * grid.rows >= 5 && grid.cols * grid.rows < 5 + Math.max(grid.cols, grid.rows), `wall grid ${grid.cols}x${grid.rows} for 5 tiles`);
// the layout of the wall header: the clock and the state on one row, the buttons together on the right
const head = await page.evaluate(() => { const c = document.getElementById('wallClock').getBoundingClientRect(); const s = document.getElementById('wallState').getBoundingClientRect(); return { sameRow: Math.abs(c.top - s.top) < c.height, stacked: document.getElementById('wallHead').classList.contains('is-stacked') }; });
check(head.sameRow && !head.stacked, 'wall: the clock and TUTTO OK are on one row, as before');
// a closed station opens by a click in the wall and closes again (the way back)
await page.click('.tile--station[data-station="gr"]');
await new Promise((r) => setTimeout(r, 300));
i = await info();
check(i.rows.filter((r) => !r.hidden).length === 7 && i.rows.find((r) => r.station === 'gr' && !r.hidden), 'wall: a click opens a station and its tile stays');
await page.click('.tile--station[data-station="gr"]');
await new Promise((r) => setTimeout(r, 300));
i = await info();
check(i.rows.filter((r) => !r.hidden).length === 5, 'wall: another click closes it again');
await page.screenshot({ path: path.join(shots, '4-wall.png') });
await page.click('#wallExit');
await page.waitForFunction(() => !document.body.classList.contains('wall'));

// the switch gives the view by input back, and the choice is saved
await page.click('#viewBtn');
await new Promise((r) => setTimeout(r, 400));
i = await info();
check(i.view === 'inputs' && i.rows.length === 5 && i.rows.every((r) => !r.hidden && !r.station), 'the switch gives one tile for each input');
check((await page.evaluate(() => window.api.settings.get())).display.view === 'inputs', 'the choice is saved');
check(i.rows.find((r) => r.id === 'gr1')?.name === 'Giornale Radio · Rete 1' && i.rows.find((r) => r.id === 'solo')?.name === 'Radio Podcast', `by input the station comes before the name of its streams: ${i.rows.find((r) => r.id === 'gr1')?.name}`);
await page.click('#viewBtn');
await new Promise((r) => setTimeout(r, 400));
check((await info()).view === 'stations', 'and back to the stations');



// ---- the compact view shows the stations too
await page.evaluate(() => window.api.window.setView('compact', true));
await new Promise((r) => setTimeout(r, 1200));
i = await info();
check(i.view === 'stations' && i.rows.filter((r) => !r.hidden && r.station).length === 2, 'compact view: the two stations are rows');
check(i.rows.some((r) => r.id === 'n1' && !r.hidden) && i.rows.some((r) => r.id === 'gr1' && r.hidden), 'compact view: the station in dead air is open, the other closed');
await page.screenshot({ path: path.join(shots, '5-compact.png') });
await page.click('.tile--station[data-station="gr"]');
await new Promise((r) => setTimeout(r, 300));
await page.screenshot({ path: path.join(shots, '5-compact-open.png') });
await page.click('.tile--station[data-station="gr"]');
await page.evaluate(() => window.api.window.setView('compact', false));
await new Promise((r) => setTimeout(r, 1200));

// ---- Settings → Inputs → Stations: create, give a logo and a stream, choose the featured stream, save, delete
await page.click('.nav__item[data-view="settings"]');
await page.click('.tab[data-tab="inputs"]');
const cards = await page.locator('#stationsList .station-card').count();
check(cards === 2, `Settings lists the two stations (${cards})`);
const gr = page.locator('#stationsList .station-card[data-id="gr"]');
await gr.locator(':scope > summary').click();
check((await gr.locator('.st-name').inputValue()) === 'Giornale Radio', 'a station card shows its name');
const opts = await gr.locator('.st-featured option').allTextContents();
check(opts.includes('Rete 1') && opts.includes('Rete 2') && (await gr.locator('.st-featured').inputValue()) === 'gr2', `the featured stream is chosen among the station's streams: ${opts.join(' | ')}`);
check((await gr.locator('.st-streams > details.input').count()) === 2 && (await page.locator('#inputsList > details.input').count()) === 1, 'the streams of a station are inside its card, the free ones are in the other list');
const colors = await page.evaluate(() => window.api.settings.get().then((x) => x.stations.map((s) => s.color)));
check(colors.every((c) => /^#[0-9a-f]{6}$/.test(c)) && new Set(colors).size === colors.length, `each station has its own colour: ${colors.join(' ')}`);

await page.click('#addStation');
const created = page.locator('#stationsList .station-card').last();
await created.locator('.st-name').fill('Radio X');
await created.locator('.in-logo-pick').click();
check((await created.locator('.logo-pick').count()) >= 3, 'the picker offers the logos already loaded');
await created.locator(`.logo-pick[data-logo="${logoGR}"]`).click();
// the free stream "Radio Podcast" joins the new station
const soloCard = page.locator('details.input[data-id="solo"]');
await soloCard.locator(':scope > summary').click();
const choices = await soloCard.locator('.in-station option').allTextContents();
check(choices.includes('Radio X') && choices.includes('GRNews'), `a stream can choose a station, also one not saved yet: ${choices.join(' | ')}`);
await soloCard.locator('.in-station').selectOption({ label: 'Radio X' });
check((await created.locator('.st-streams > details.input[data-id="solo"]').count()) === 1 && (await page.locator('#inputsList > details.input[data-id="solo"]').count()) === 0, 'the stream that chose the station is moved inside its card and is no longer among the free ones');
await created.locator('.st-featured').selectOption({ index: 1 });
// a stream already set up goes into the station from the station card (and back, from its own card)
const attachOpts = await created.locator('.st-attach option').allTextContents();
check(attachOpts.some((o) => /^News main \(GRNews\)$/.test(o)) && !attachOpts.includes('Radio Podcast'), `the station offers the streams that are not in it, with their station: ${attachOpts.join(' | ')}`);
await created.locator('.st-attach').selectOption('n1');
check((await created.locator('.st-streams > details.input[data-id="n1"]').count()) === 1, 'the stream added from the station card is moved inside it');
const n1Card = page.locator('details.input[data-id="n1"]');
await n1Card.locator(':scope > summary').click();
check((await n1Card.locator('.in-station').inputValue()) === (await created.getAttribute('data-id')), 'and its own card now says that station');
await n1Card.locator('.in-station').selectOption('news');
await page.screenshot({ path: path.join(shots, '5-settings.png') });
await page.click('#saveBtn');
const saved = await until(async () => { const x = await page.evaluate(() => window.api.settings.get()); return x.stations.length === 3 && x; }, 6000, 'three stations saved');
const sx = saved.stations.find((x) => x.name === 'Radio X');
check(sx && sx.logo === logoGR && sx.featured === 'solo', `the station is saved with its logo and its featured stream: ${JSON.stringify(sx)}`);
check(saved.inputs.find((x) => x.id === 'solo').stationId === sx.id, 'the stream is in the station');
check(saved.inputs.find((x) => x.id === 'gr1').stationId === 'gr' && saved.stations.find((x) => x.id === 'gr').featured === 'gr2', 'the other stations are as they were');

// the logo of a station stays: a picture from a file is saved, and the card shows it after the save and when the form is filled again
const png = path.join(shots, 'logo-x.png');
fs.writeFileSync(png, Buffer.from((await dataUrl('#ff00ff')).split(',')[1], 'base64'));
const radioX = page.locator(`#stationsList .station-card[data-id="${sx.id}"]`);
await radioX.locator('.in-logo-file').first().setInputFiles(png);
await radioX.locator('.logo-box img:not(.hidden)').first().waitFor({ state: 'attached', timeout: 4000 });
await page.click('#saveBtn');
const withLogo = await until(async () => { const x = await page.evaluate(() => window.api.settings.get()); const st2 = x.stations.find((y) => y.id === sx.id); return st2 && st2.logo && st2.logo !== logoGR && st2; }, 6000, 'the new logo of the station saved');
check(!!withLogo.logo, `the station keeps the picture chosen from a file: ${withLogo.logo}`);
check(await page.evaluate((sid) => !document.querySelector(`#stationsList .station-card[data-id="${sid}"] .logo-box img`).classList.contains('hidden'), sx.id), 'the station card shows its logo after the save');
await page.evaluate(() => document.querySelector('.tab[data-tab="inputs"]').click());
await page.click('#revertBtn');
const ownLogo = (id) => page.evaluate((sid) => { const c = document.querySelector(`#stationsList .station-card[data-id="${sid}"]`); return !c.querySelector('.logo-box img').classList.contains('hidden'); }, id);
check((await ownLogo(sx.id)) && (await ownLogo('gr')), 'and every station shows its logo when the form is filled again');

// drag a stream out of a station and into another one (and the menu and the buttons do the same)
await radioX.locator(':scope > summary').click(); // only this station is open, so that the stations and the streams are in view together for the mouse
await page.locator(`details.input[data-id="solo"]`).scrollIntoViewIfNeeded();
const grip = 'details.input[data-id="solo"] > summary .input__grip';
await page.dragAndDrop(grip, '#freeZone');
check((await page.locator('#inputsList > details.input[data-id="solo"]').count()) === 1, 'dragging a stream onto the free ones takes it out of its station');
// the station is far above in the page (a drag by mouse across it needs the page to scroll while dragging): the three events of the drag are sent by hand
await page.evaluate(() => {
  const dt = new DataTransfer();
  const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  const g = document.querySelector('details.input[data-id="solo"] > summary .input__grip');
  const target = document.querySelector('#stationsList .station-card[data-id="gr"] > summary');
  fire(g, 'dragstart');
  fire(target, 'dragover');
  fire(target, 'drop');
  fire(g, 'dragend');
});
check((await page.locator('#stationsList .station-card[data-id="gr"] .st-streams > details.input[data-id="solo"]').count()) === 1, 'dragging it onto a station moves it inside that station');
await page.locator('details.input[data-id="solo"]').locator(':scope > summary').click();
await page.locator('details.input[data-id="solo"] .in-unstation').click();
check((await page.locator('#inputsList > details.input[data-id="solo"]').count()) === 1, 'the button "Take out of the station" does the same');
await page.locator('details.input[data-id="solo"] .in-station').selectOption(sx.id);
check((await page.locator(`#stationsList .station-card[data-id="${sx.id}"] .st-streams > details.input[data-id="solo"]`).count()) === 1, 'and so does the menu Station');
// the colour of a station can be changed
await radioX.locator('.st-swatch').nth(5).click();
await page.click('#saveBtn');
const recolor = await until(async () => { const x = await page.evaluate(() => window.api.settings.get()); const st2 = x.stations.find((y) => y.id === sx.id); return st2 && st2.color === '#e879f9' && st2; }, 6000, 'the colour saved');
check(!!recolor, 'the colour chosen is saved');
await page.setViewportSize({ width: 1180, height: 780 });

// delete a station: its streams stay and are free again
const news = page.locator('#stationsList .station-card[data-id="news"]');
await news.locator(':scope > summary').click();
await news.locator('.st-del').click();
await page.click('#saveBtn');
const after = await until(async () => { const x = await page.evaluate(() => window.api.settings.get()); return x.stations.length === 2 && x; }, 6000, 'a station deleted');
check(after.inputs.filter((i) => i.id === 'n1' || i.id === 'n2').every((i) => i.stationId === ''), 'the streams of a deleted station stay, free');
await page.click('.nav__item[data-view="dashboard"]');
await new Promise((r) => setTimeout(r, 600));
i = await info();
check(!!st(sx.id) || i.rows.some((r) => r.station === sx.id), 'the new station is a tile on the dashboard');
check(i.rows.some((r) => r.id === 'n1' && !r.hidden) && i.rows.some((r) => r.id === 'n2' && !r.hidden), 'the free streams are tiles of their own');

await page.evaluate(() => window.api.monitor.stop());
check(errors.length === 0, `no errors in the window console ${errors.length ? JSON.stringify(errors) : ''}`);
await app.close();
server.closeAllConnections?.();
server.close();
console.log(`screenshots: ${shots}`);
