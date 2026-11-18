// The window after an update (new engine + stations, once) and the banner of an engine that cannot start.
// xvfb-run -a node dev/e2e-intro.mjs [folder for screenshots]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import electronPath from 'electron';
import { root, enginePath } from './helpers.js';

const require = createRequire(path.join(execSync('npm root -g').toString().trim(), '/'));
const { _electron } = require('playwright');
const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'daw-e2e-in-'));
fs.mkdirSync(shots, { recursive: true });
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) process.exitCode = 1; };

async function launch(userData, engine) {
  const app = await _electron.launch({ executablePath: electronPath, args: [root, '--no-sandbox'], env: { ...process.env, DAW_USER_DATA: userData, DAW_ENGINE: engine } });
  await app.firstWindow();
  const find = () => app.windows().find((w) => w.url().endsWith('index.html'));
  for (let i = 0; i < 100 && !find(); i++) await new Promise((r) => setTimeout(r, 100));
  const page = find();
  await page.waitForFunction(() => !!window.api);
  return { app, page };
}

// an installation that ran an older version: settings file with lastSeenVersion
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'daw-ud-in-'));
const file = path.join(userData, 'dead-air-watchdog.json');
const write = (settings) => fs.writeFileSync(file, JSON.stringify({ version: 1, settings }));
write({ lastSeenVersion: '0.0.1', micExplained: true, inputs: [] });
let { app, page } = await launch(userData, enginePath);
await page.waitForSelector('#newDlg[open]', { timeout: 8000 });
check(!(await page.$eval('#newDlgIntro', (e) => e.classList.contains('hidden'))), 'after an update the window explains the new engine and the stations');
const txt = await page.$eval('#newDlgIntro', (e) => e.textContent);
check(/Rust/.test(txt) && /Stations/.test(txt) && /32 inputs/.test(txt), 'it names the engine, its gains and the stations');
await page.screenshot({ path: path.join(shots, 'intro.png') });
await page.click('#newDlgClose');
await new Promise((r) => setTimeout(r, 500));
await app.close();

// the next start of the same version: nothing; a later update: the list of changes, without the explanation
const saved = JSON.parse(fs.readFileSync(file, 'utf8')).settings;
check(saved.engineIntroSeen === true, 'the explanation is remembered as seen');
write({ ...saved, lastSeenVersion: '0.0.2' });
({ app, page } = await launch(userData, enginePath));
await page.waitForSelector('#newDlg[open]', { timeout: 8000 });
check(await page.$eval('#newDlgIntro', (e) => e.classList.contains('hidden')), 'seen once: a later update shows only the changes');
await page.click('#newDlgClose');
await app.close();

// an engine that cannot start for a missing library: the banner, with the commands
const fake = path.join(userData, 'fake-engine.sh');
fs.writeFileSync(fake, '#!/bin/sh\necho "fake: error while loading shared libraries: libasound.so.2: cannot open shared object file: No such file or directory" >&2\nexit 127\n', { mode: 0o755 });
({ app, page } = await launch(fs.mkdtempSync(path.join(os.tmpdir(), 'daw-ud-in2-')), fake));
await page.waitForFunction(() => !document.getElementById('engineBanner').classList.contains('hidden'), null, { timeout: 8000 });
const banner = await page.$eval('#engineBanner', (e) => e.textContent);
check(/libasound2/.test(banner) && /apt install/.test(banner) && /dnf install/.test(banner), `the banner names the library and the commands: ${banner.slice(0, 80)}…`);
await page.screenshot({ path: path.join(shots, 'banner.png') });
await app.close();
console.log(`screenshots: ${shots}`);
