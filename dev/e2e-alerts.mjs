// An input without alerts and an indicator, in the real app (Electron + Rust engine + a live stream made by ffmpeg).
// xvfb-run -a node dev/e2e-alerts.mjs [folder for screenshots]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import electronPath from 'electron';
import { liveServer, FORMATS, root, enginePath } from './helpers.js';

const require = createRequire(path.join(execSync('npm root -g').toString().trim(), '/'));
const { _electron } = require('playwright');
const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'daw-e2e-al-'));
fs.mkdirSync(shots, { recursive: true });
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) process.exitCode = 1; };

const { server, url } = await liveServer(FORMATS.mp3, { toneSec: 120, silenceSec: 0, peakDb: -20 });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'daw-ud-al-'));
const app = await _electron.launch({ executablePath: electronPath, args: [root, '--no-sandbox'], env: { ...process.env, DAW_USER_DATA: userData, DAW_ENGINE: enginePath } });
await app.firstWindow();
const find = () => app.windows().find((w) => w.url().endsWith('index.html'));
for (let i = 0; i < 100 && !find(); i++) await new Promise((r) => setTimeout(r, 100));
const page = find();
await page.waitForFunction(() => !!window.api);
const until = async (fn, ms, what) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await new Promise((r) => setTimeout(r, 250)); } };

const base = { type: 'stream', thresholdDb: -50, minSilenceSec: 3, yellowDelaySec: 0, enabled: true };
await page.evaluate(({ url, base }) => window.api.settings.update({
  micExplained: true,
  inputs: [
    { ...base, id: 'main', name: 'On air', streamUrl: url },
    { ...base, id: 'quiet', name: 'Test feed', streamUrl: 'http://127.0.0.1:9/nothing', alerts: 'off' },
    { ...base, id: 'ind', name: 'Studio mic', streamUrl: url, alerts: 'indicator' },
  ],
}), { url, base });
await page.evaluate(() => window.api.monitor.start());
const st = () => page.evaluate(() => window.api.monitor.status());
await until(async () => { const s = await st(); return s.inputs.find((i) => i.id === 'quiet')?.state === 'alarm' && s.inputs.find((i) => i.id === 'ind')?.state === 'audio-yes'; }, 25_000, 'the input without alerts in alarm, the indicator saying yes');
const s = await st();
check(s.overall === 'ok' && s.counts.alarm === 0, `the input without alerts is outside the overall state: ${s.overall}`);
await new Promise((r) => setTimeout(r, 800));
const tiles = await page.evaluate(() => [...document.getElementById('tiles').children].map((c) => ({ id: c.dataset.id, state: c.dataset.state, kind: c.querySelector('.tile__type')?.textContent, text: c.querySelector('.tile__state')?.textContent })));
const tile = (id) => tiles.find((x) => x.id === id);
check(/alerts off/.test(tile('quiet')?.kind || '') && tile('quiet').state === 'alarm', `the tile says its alerts are off and still shows the alarm: ${JSON.stringify(tile('quiet'))}`);
check(tile('ind')?.text === 'AUDIO YES' && /indicator/.test(tile('ind').kind), `the indicator tile says AUDIO YES: ${JSON.stringify(tile('ind'))}`);
check(tile('main')?.text === 'AUDIO OK', 'the normal input is as always');
check((await page.evaluate(() => document.getElementById('heroState').textContent)) !== '' && (await page.evaluate(() => document.body.dataset.overall)) === 'ok', 'the big state is not red');
const events = await page.evaluate(() => window.api.events.list());
check(events.some((e) => e.kind === 'dead-air' && e.inputId === 'quiet') && !events.some((e) => e.inputId === 'ind'), 'the log has the input without alerts and not the indicator');
// the setting in the card
await page.click('.nav__item[data-view="settings"]');
await page.click('.tab[data-tab="inputs"]');
const card = page.locator('details.input[data-id="ind"]');
await card.locator(':scope > summary').click();
check((await card.locator('.in-alerts').inputValue()) === 'indicator' && (await card.locator('.in-ind-counts-row').isVisible()), 'the card shows Indicator and the "counts" box');
await card.locator('.in-alerts').selectOption('on');
check(!(await card.locator('.in-ind-counts-row').isVisible()), 'the box goes away with the other choices');
await card.locator('.in-alerts').selectOption('indicator');
await card.locator('.in-ind-counts').check();
await page.click('#saveBtn');
const saved = await until(async () => { const x = await page.evaluate(() => window.api.settings.get()); return x.inputs.find((i) => i.id === 'ind')?.indicatorCounts && x; }, 6000, 'saved');
check(saved.inputs.find((i) => i.id === 'ind').alerts === 'indicator', 'the choice is saved');
await page.screenshot({ path: path.join(shots, 'alerts-settings.png') });
await page.click('.nav__item[data-view="dashboard"]');
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: path.join(shots, 'alerts-dashboard.png') });
await page.evaluate(() => window.api.monitor.stop());
await app.close();
server.closeAllConnections?.();
server.close();
console.log(`screenshots: ${shots}`);
