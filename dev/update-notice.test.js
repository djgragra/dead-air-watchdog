import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAlertState } from '../src/alert-state.js';
import { createUpdateNotice } from '../src/update-notice.js';
import { pageUrl } from '../src/updater.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'daw-')), 'alert-state.json');
const INFO = { available: true, latest: '26.10.3', current: '26.10.2', url: 'https://github.com/djgragra/dead-air-watchdog/releases/tag/v26.10.3' };

function setup({ file = tmpFile(), settings = {}, failing = new Set() } = {}) {
  const s = { language: 'en', notifications: { desktop: true, updateAlert: true, email: { enabled: true }, telegram: { enabled: true } }, ...settings };
  const sent = [];
  const desktop = [];
  const notice = createUpdateNotice({
    getSettings: () => s,
    alertState: createAlertState({ file }),
    send: async (channel, subject, text) => {
      if (failing.has(channel)) throw new Error('network down');
      sent.push({ channel, subject, text });
    },
    notifyDesktop: (t) => desktop.push(t),
    delays: [0, 0, 0],
    sleep: async () => {}
  });
  return { s, sent, desktop, notice, file, failing };
}

test('update notice: once per version and per channel (email, Telegram and desktop)', async () => {
  const { sent, desktop, notice } = setup();
  await notice.announce(INFO);
  await notice.announce(INFO);
  assert.deepEqual(sent.map((x) => x.channel).sort(), ['email', 'telegram']);
  assert.equal(desktop.length, 1);
  assert.match(sent[0].subject, /New version 26\.10\.3 available/);
  assert.ok(sent[0].text.includes('https://onairgarage.com/tools/dead-air-watchdog/'));
  assert.ok(!sent[0].text.includes('github.com'));
});

test('update notice: the text follows the app language', async () => {
  const { sent, notice } = setup({ settings: { language: 'it' } });
  await notice.announce(INFO);
  assert.match(sent[0].subject, /Nuova versione 26\.10\.3 disponibile/);
});

test('update notice: a failed send is not marked as told and is tried again at the next check', async () => {
  const { sent, notice, failing } = setup({ failing: new Set(['telegram']) });
  await notice.announce(INFO);
  assert.deepEqual(sent.map((x) => x.channel), ['email']); // email delivered, Telegram failed after three tries
  failing.clear();
  await notice.announce(INFO);
  assert.deepEqual(sent.map((x) => x.channel), ['email', 'telegram']); // only the missing channel
});

test('update notice: three tries per send', async () => {
  let n = 0;
  const notice = createUpdateNotice({
    getSettings: () => ({ language: 'en', notifications: { desktop: false, updateAlert: true, email: { enabled: true }, telegram: { enabled: false } } }),
    alertState: createAlertState({ file: tmpFile() }),
    send: async () => {
      if (++n < 3) throw new Error('boom');
    },
    delays: [0, 10_000, 60_000],
    sleep: async () => {}
  });
  await notice.announce(INFO);
  assert.equal(n, 3);
});

test('update notice: a channel switched on later is told at the next check', async () => {
  const { s, sent, notice } = setup({ settings: { notifications: { desktop: false, updateAlert: true, email: { enabled: false }, telegram: { enabled: true } } } });
  await notice.announce(INFO);
  assert.deepEqual(sent.map((x) => x.channel), ['telegram']);
  s.notifications.email.enabled = true;
  await notice.announce(INFO);
  assert.deepEqual(sent.map((x) => x.channel), ['telegram', 'email']);
});

test('update notice: nothing without Telegram or email, nothing when switched off, nothing without an update', async () => {
  const none = setup({ settings: { notifications: { desktop: true, updateAlert: true, email: { enabled: false }, telegram: { enabled: false } } } });
  await none.notice.announce(INFO);
  assert.equal(none.sent.length + none.desktop.length, 0);
  const off = setup({ settings: { notifications: { desktop: true, updateAlert: false, email: { enabled: true }, telegram: { enabled: true } } } });
  await off.notice.announce(INFO);
  assert.equal(off.sent.length + off.desktop.length, 0);
  const same = setup();
  await same.notice.announce({ ...INFO, available: false });
  assert.equal(same.sent.length, 0);
});

test('update notice: what was told survives a restart; a newer version is told again', async () => {
  const first = setup();
  await first.notice.announce(INFO);
  const restarted = setup({ file: first.file }); // new objects, same alert-state.json
  await restarted.notice.announce(INFO);
  assert.equal(restarted.sent.length, 0);
  await restarted.notice.announce({ ...INFO, latest: '26.11.1' });
  assert.equal(restarted.sent.length, 2);
});

test('alert-state.json: damaged or missing file means nothing told yet; it is not the settings file', () => {
  const file = tmpFile();
  assert.equal(createAlertState({ file }).isTold('1', 'email'), false);
  fs.writeFileSync(file, '{not json');
  assert.equal(createAlertState({ file }).isTold('1', 'email'), false);
  const st = createAlertState({ file });
  st.markTold('1', 'email');
  assert.equal(path.basename(file), 'alert-state.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).updateNotice.told.email, true);
});

test('pageUrl: the app page on the site, in the language of the app', () => {
  assert.equal(pageUrl('dead-air-watchdog', 'en'), 'https://onairgarage.com/tools/dead-air-watchdog/');
  assert.equal(pageUrl('dead-air-watchdog', 'it'), 'https://onairgarage.com/it/tools/dead-air-watchdog/');
  assert.equal(pageUrl('dead-air-watchdog', 'es'), 'https://onairgarage.com/es/tools/dead-air-watchdog/');
  assert.equal(pageUrl(undefined, 'fr'), 'https://onairgarage.com/tools/dead-air-watchdog/');
});

test('update notice: the link of the site in Italian and Spanish, never the GitHub release', async () => {
  for (const [language, prefix] of [['it', '/it'], ['es', '/es']]) {
    const { sent, notice } = setup({ settings: { language } });
    await notice.announce(INFO);
    for (const m of sent) {
      assert.ok(m.text.includes(`https://onairgarage.com${prefix}/tools/dead-air-watchdog/`));
      assert.ok(!m.text.includes('github.com'));
    }
  }
});
