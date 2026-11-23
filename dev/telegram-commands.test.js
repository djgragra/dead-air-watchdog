// Silencing the alarm sound from Telegram: only the chats that receive the alerts, only the commands, old messages thrown away.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramCommands, parseCommand } from '../src/telegram-commands.js';

const TOKEN = '123456789:AAtesttesttesttesttesttesttesttest1';

function setup({ commands = true, enabled = true, recipients = [{ chatId: '111', note: 'me' }], lang = 'en', muteResult = true } = {}) {
  const calls = [];
  const queue = []; // updates waiting at Telegram
  let status = 200;
  const logs = [];
  let muted = 0;
  const settings = { language: lang, notifications: { telegram: { enabled, commands, botToken: TOKEN, recipients } } };
  const fetchFn = async (url, opts) => {
    const method = url.split('/').pop();
    const body = JSON.parse(opts.body);
    calls.push({ method, body });
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    if (method === 'getUpdates') {
      const mine = queue.filter((u) => body.offset < 0 || u.update_id >= body.offset);
      return { ok: true, status: 200, json: async () => ({ ok: true, result: body.offset < 0 ? mine.slice(-1) : mine }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  let active = true;
  const tg = createTelegramCommands({ getSettings: () => settings, isActive: () => active, fetchFn, onMute: () => { muted++; return muteResult; }, log: (m, l) => logs.push([m, l]), now: () => 1_800_000_000_000, setIntervalFn: () => 1, clearIntervalFn: () => {} });
  const msg = (id, chat, text) => queue.push({ update_id: id, message: { message_id: id * 10, chat: { id: chat }, text } });
  return { tg, calls, queue, msg, logs, settings, get muted() { return muted; }, setStatus: (s) => (status = s), setActive: (a) => (active = a) };
}

test('parseCommand: the three words, any case, with the bot name or more text; nothing else', () => {
  assert.equal(parseCommand('/silenzia'), '/silenzia');
  assert.equal(parseCommand('/Mute@MyWatchBot please'), '/mute');
  assert.equal(parseCommand('  /silencio'), '/silencio');
  assert.equal(parseCommand('silenzia'), '');
  assert.equal(parseCommand('/start'), '');
  assert.equal(parseCommand('/mutex'), '');
  assert.equal(parseCommand(undefined), '');
});

test('a command from a recipient silences the sound and is answered; old messages are thrown away at the start', async () => {
  const s = setup();
  s.msg(1, 111, '/silenzia'); // waiting before the app looked: must not fire
  await s.tg.poll(); // first poll: throws the old ones away
  assert.equal(s.muted, 0);
  s.msg(2, 111, '/silenzia');
  await s.tg.poll();
  assert.equal(s.muted, 1);
  const answer = s.calls.find((c) => c.method === 'sendMessage');
  assert.equal(answer.body.chat_id, '111');
  assert.equal(answer.body.text, 'Alarm sound silenced.');
  await s.tg.poll(); // the same update is not read twice
  assert.equal(s.muted, 1);
});

test('the answer says when nothing was sounding, in the language of the app', async () => {
  const s = setup({ muteResult: false, lang: 'it' });
  await s.tg.poll();
  s.msg(1, 111, '/mute');
  await s.tg.poll();
  assert.equal(s.calls.find((c) => c.method === 'sendMessage').body.text, 'Nessun suono in corso.');
});

test('a chat that is not a recipient is ignored and never answered; other text is ignored', async () => {
  const s = setup();
  await s.tg.poll();
  s.msg(1, 999, '/silenzia');
  s.msg(2, 111, 'hello');
  await s.tg.poll();
  assert.equal(s.muted, 0);
  assert.ok(!s.calls.some((c) => c.method === 'sendMessage'));
  assert.ok(s.logs.some(([m]) => m.includes('not a recipient')));
});

test('off by default and while monitoring is stopped: nothing is asked of Telegram', async () => {
  const off = setup({ commands: false });
  await off.tg.poll();
  assert.equal(off.calls.length, 0);
  const stopped = setup();
  stopped.setActive(false);
  await stopped.tg.poll();
  assert.equal(stopped.calls.length, 0);
});

test('409 (a webhook, or another program reads the bot): one warning, then it waits; the token is never in the log', async () => {
  const s = setup();
  s.setStatus(409);
  await s.tg.poll();
  await s.tg.poll(); // paused: not asked again at once
  assert.equal(s.calls.length, 1);
  assert.equal(s.logs.length, 1);
  assert.ok(!JSON.stringify(s.logs).includes(TOKEN));
  assert.match(s.logs[0][0], /another program/);
});
