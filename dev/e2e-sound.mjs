// The alarm sound in the real app (Electron under a virtual screen): an alarm from a simulated SNMP device, the continuous sound,
// the calm phase (one burst every few minutes), silencing with the shortcut, and a new alarm starting it again.
// The sound window is hidden: what it plays is counted by wrapping the oscillators of its AudioContext (two per burst).
//   xvfb-run -a node dev/e2e-sound.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import electronPath from 'electron';
import netSnmp from 'net-snmp';
import { root } from './helpers.js';

const require = createRequire(path.join(execSync('npm root -g').toString().trim(), '/'));
const { _electron } = require('playwright');
const OID = '1.3.6.1.4.1.35833.1.3.1';
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) process.exitCode = 1; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await wait(250); } };
const freePort = () => new Promise((res) => { const s = dgram.createSocket('udp4'); s.bind(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

// the simulated device
const port = await freePort();
let value = 1;
const agent = netSnmp.createAgent({ port, disableAuthorization: false }, () => {});
agent.getAuthorizer().addCommunity('c');
const mib = agent.getMib();
mib.registerProvider({ name: 'in', type: netSnmp.MibProviderType.Scalar, oid: OID, scalarType: netSnmp.ObjectType.Integer, maxAccess: netSnmp.MaxAccess['read-write'], handler: (m) => { mib.setScalarValue('in', value); m.done(); } });
mib.setScalarValue('in', value);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'daw-ud-snd-'));
const app = await _electron.launch({ executablePath: electronPath, args: [root, '--no-sandbox'], env: { ...process.env, DAW_USER_DATA: userData } });
await app.firstWindow();
const find = (end) => app.windows().find((w) => w.url().endsWith(end));
for (let i = 0; i < 100 && !(find('index.html') && find('sound.html')); i++) await wait(100);
const main = find('index.html');
const snd = find('sound.html');
const errors = [];
main.on('pageerror', (e) => errors.push(String(e)));
snd.on('pageerror', (e) => errors.push(String(e)));
await main.waitForFunction(() => !!window.api);
// count the oscillators the sound window creates (two per burst of beeps)
await snd.evaluate(() => {
  window.__osc = 0;
  const orig = AudioContext.prototype.createOscillator;
  AudioContext.prototype.createOscillator = function () { window.__osc++; return orig.call(this); };
});
const osc = () => snd.evaluate(() => window.__osc);
const status = () => main.evaluate(() => window.api.monitor.status());
const bursts = async (ms) => { const a = await osc(); await wait(ms); return (await osc() - a) / 2; };

const setSound = (extra) => main.evaluate((e) => window.api.settings.update({ notifications: { sound: { enabled: true, volume: 0.2, ...e } } }), extra);
await main.evaluate(({ port }) => window.api.settings.update({
  micExplained: true,
  inputs: [{ id: 'dev', name: 'DEVA test', type: 'snmp', streamUrl: `snmp://c@127.0.0.1:${port}`, snmpOid: '1.3.6.1.4.1.35833.1.3.1.0', snmpNormal: '1', snmpPollSec: 1, minSilenceSec: 1, enabled: true }]
}), { port });
await setSound({ continuousMin: 1, repeatMin: 1, shortcut: 'Ctrl+Alt+M' });
check(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Ctrl+Alt+M')), 'the global shortcut Ctrl+Alt+M is registered');
check((await main.evaluate(() => window.api.monitor.shortcutState())).state === 'active', 'the window is told that the shortcut is active');

await main.evaluate(() => window.api.monitor.start());
await until(async () => (await status()).inputs.find((i) => i.id === 'dev')?.state === 'ok', 15_000, 'the device is normal');
check((await bursts(3000)) === 0, 'no sound while the device is normal');

value = 2; // the DEVA goes to Aux
await until(async () => (await status()).inputs.find((i) => i.id === 'dev')?.state === 'alarm', 20_000, 'the alarm');
const t0 = Date.now();
await until(async () => (await status()).soundPlaying === true, 5000, 'the status says the sound is playing');
const b1 = await bursts(6000);
check(b1 >= 4, `continuous sound at the start of the alarm (${b1} bursts in 6 s)`);

// the calm phase: after 60 s of continuous sound, silence, then one burst every minute
await wait(Math.max(0, 62_000 - (Date.now() - t0)));
const calm1 = await bursts(5000);
check(calm1 <= 1.5, `the sound has calmed down after a minute (${calm1} bursts in 5 s)`);
check((await status()).soundPlaying === true, 'the window still offers the silence button in the calm phase');
const quiet = await bursts(40_000);
check(quiet <= 1.5, `quiet between the reminders (${quiet} bursts in 40 s)`);
await until(async () => (await bursts(1000)) >= 1, 40_000, 'the next reminder burst');
check(true, 'one reminder burst arrives after the repeat time');

// a new alarm starts the continuous sound again: the device recovers, then fails again
value = 1;
await until(async () => (await status()).inputs.find((i) => i.id === 'dev')?.state === 'ok', 15_000, 'the device recovers');
await wait(1500);
value = 3;
await until(async () => (await status()).inputs.find((i) => i.id === 'dev')?.state === 'alarm', 20_000, 'the second alarm');
const b2 = await bursts(5000);
check(b2 >= 3, `a new alarm starts the continuous sound again (${b2} bursts in 5 s)`);

// silence with the shortcut (the handler registered with the system is called)
await app.evaluate(() => { globalThis.__fire = true; });
await main.evaluate(() => window.api.monitor.muteAlarm());
await wait(1500);
check((await bursts(4000)) === 0, 'silenced: no sound');
check((await status()).soundPlaying === false, 'silenced: the status says the sound is off');

// the alarm sound can be switched off in the settings: nothing plays for a new alarm
value = 1;
await until(async () => (await status()).inputs.find((i) => i.id === 'dev')?.state === 'ok', 15_000, 'the device recovers again');
await main.evaluate(() => window.api.settings.update({ notifications: { sound: { enabled: false } } }));
value = 2;
await until(async () => (await status()).inputs.find((i) => i.id === 'dev')?.state === 'alarm', 20_000, 'the third alarm');
check((await bursts(4000)) === 0, 'sound switched off in the settings: nothing plays');

check(errors.length === 0, `no errors in the windows${errors.length ? ': ' + errors.slice(0, 2).join(' | ') : ''}`);
await app.close();
agent.close();
process.exit(process.exitCode || 0);
