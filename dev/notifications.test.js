import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendEmail, sendTelegram, TELEGRAM_TOKEN_RE } from '../src/notifications.js';
import { parseAddresses } from '../src/addresses.js';
// Built at run time so that no token-shaped text sits in the repository (secret scanners flag it); same shape as a real one.
const FAKE_TELEGRAM_TOKEN = ['123456789', 'A'.repeat(35)].join(':');
import { sanitizeSettings, createStore } from '../src/store.js';
import { MESSAGES } from '../src/messages.js';

// fake nodemailer: remembers the options of the transport and of the message
function fakeMail({ rejected = [], fail = null } = {}) {
  const calls = { options: null, message: null, closed: false };
  const factory = (options) => {
    calls.options = options;
    return {
      sendMail: async (message) => {
        calls.message = message;
        if (fail) throw new Error(fail);
        return { rejected };
      },
      close: () => (calls.closed = true)
    };
  };
  return { calls, factory };
}

const MAIL = { enabled: true, host: 'smtp.example.org', port: 587, secure: false, user: 'watchdog', pass: 'S3cretPass', from: 'watchdog@example.org', recipients: ['a@example.org', 'b@example.org', 'c@example.org'] };

test('email: one message, all recipients in Bcc, "to" is the sender', async () => {
  const m = fakeMail();
  await sendEmail(MAIL, 'subject', 'body', 'en', m.factory);
  assert.deepEqual(m.calls.message.bcc, ['a@example.org', 'b@example.org', 'c@example.org']);
  assert.equal(m.calls.message.to, 'watchdog@example.org');
  assert.equal(m.calls.message.from, 'watchdog@example.org');
  assert.equal(m.calls.closed, true);
});

test('email: with a user name and no TLS from the start, STARTTLS is required', async () => {
  const m = fakeMail();
  await sendEmail(MAIL, 's', 'b', 'en', m.factory);
  assert.equal(m.calls.options.requireTLS, true);
  assert.equal(m.calls.options.secure, false);
  assert.deepEqual(m.calls.options.auth, { user: 'watchdog', pass: 'S3cretPass' });
});

test('email: no user name means no authentication and no forced TLS; TLS from the start is passed on', async () => {
  const m = fakeMail();
  await sendEmail({ ...MAIL, user: '', pass: '' }, 's', 'b', 'en', m.factory);
  assert.equal(m.calls.options.requireTLS, false);
  assert.equal(m.calls.options.auth, undefined);
  const m2 = fakeMail();
  await sendEmail({ ...MAIL, secure: true, port: 465 }, 's', 'b', 'en', m2.factory);
  assert.equal(m2.calls.options.secure, true);
  assert.equal(m2.calls.options.requireTLS, false);
  assert.equal(m2.calls.options.port, 465);
});

test('email: timeouts are 15 s connection, 15 s greeting, 20 s socket', async () => {
  const m = fakeMail();
  await sendEmail(MAIL, 's', 'b', 'en', m.factory);
  assert.equal(m.calls.options.connectionTimeout, 15_000);
  assert.equal(m.calls.options.greetingTimeout, 15_000);
  assert.equal(m.calls.options.socketTimeout, 20_000);
});

test('email: addresses refused by the server are named in the error', async () => {
  const m = fakeMail({ rejected: ['b@example.org'] });
  await assert.rejects(sendEmail(MAIL, 's', 'b', 'en', m.factory), /b@example\.org: rejected by the server/);
});

test('email: the password is masked in errors (short ones are not)', async () => {
  const m = fakeMail({ fail: 'Invalid login: 535 bad password S3cretPass for watchdog' });
  await assert.rejects(sendEmail(MAIL, 's', 'b', 'en', m.factory), (err) => {
    assert.match(err.message, /^Email not sent: /);
    assert.ok(!err.message.includes('S3cretPass'));
    assert.match(err.message, /\*\*\*/);
    return true;
  });
  const short = fakeMail({ fail: 'login failed for abc' });
  await assert.rejects(sendEmail({ ...MAIL, pass: 'abc' }, 's', 'b', 'en', short.factory), /login failed for abc/);
});

test('email: incomplete settings and disabled channel', async () => {
  await assert.rejects(sendEmail({ ...MAIL, recipients: [] }, 's', 'b', 'it', fakeMail().factory), /destinatari mancanti/);
  await assert.rejects(sendEmail({ ...MAIL, host: '' }, 's', 'b', 'es', fakeMail().factory), /Ajustes de correo incompletos/);
  const m = fakeMail();
  await sendEmail({ ...MAIL, enabled: false }, 's', 'b', 'en', m.factory);
  assert.equal(m.calls.message, null);
});

test('recipients: commas, semicolons, spaces and new lines; invalid and repeated addresses are left out; at most 20', () => {
  const r = parseAddresses('a@x.org, b@x.org;c@x.org\nd@x.org  A@X.ORG not-an-address');
  assert.deepEqual(r.valid, ['a@x.org', 'b@x.org', 'c@x.org', 'd@x.org']);
  assert.deepEqual(r.dropped, ['A@X.ORG', 'not-an-address']);
  const many = Array.from({ length: 30 }, (_, i) => `u${i}@x.org`);
  assert.equal(parseAddresses(many).valid.length, 20);
});

test('settings: the old single field "to" becomes the list of recipients', () => {
  const s = sanitizeSettings({ notifications: { email: { enabled: true, host: 'h', to: 'a@x.org, b@x.org; a@x.org' } } });
  assert.deepEqual(s.notifications.email.recipients, ['a@x.org', 'b@x.org']);
  assert.equal('to' in s.notifications.email, false);
  // both old and new keys: nothing is lost, nothing is repeated
  const both = sanitizeSettings({ notifications: { email: { recipients: ['c@x.org'], to: 'c@x.org, d@x.org' } } });
  assert.deepEqual(both.notifications.email.recipients, ['c@x.org', 'd@x.org']);
});

test('settings: an old file on disk is read, rewritten in the new shape and keeps the recipients', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'daw-')), 'data.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, settings: { notifications: { email: { enabled: true, host: 'h', to: 'a@x.org, b@x.org' } } }, events: [], meta: {} }));
  const st = createStore({ file });
  assert.deepEqual(st.getSettings().notifications.email.recipients, ['a@x.org', 'b@x.org']);
  st.updateSettings({});
  st.flush();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.settings.notifications.email.recipients, ['a@x.org', 'b@x.org']);
  assert.equal('to' in saved.settings.notifications.email, false);
});

const TG = { enabled: true, botToken: FAKE_TELEGRAM_TOKEN, recipients: [{ chatId: '111', note: 'Anna' }, { chatId: '222', note: 'Luca' }] };

test('telegram: token format is checked and the page preview is off', async () => {
  assert.ok(TELEGRAM_TOKEN_RE.test(TG.botToken));
  assert.ok(!TELEGRAM_TOKEN_RE.test('PLACEHOLDER-TOKEN'));
  await assert.rejects(sendTelegram({ ...TG, botToken: 'not-a-token' }, 'x', 'en', async () => ({ ok: true })), /bot token not valid/);
  const bodies = [];
  await sendTelegram(TG, 'hello', 'en', async (_u, o) => {
    bodies.push(JSON.parse(o.body));
    return { ok: true };
  });
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].link_preview_options, { is_disabled: true });
  assert.ok(bodies[0].text.startsWith('[Dead Air Watchdog] '));
});

test('telegram: one failing recipient does not stop the others; the token never shows', async () => {
  const sent = [];
  const fetchFn = async (url, o) => {
    const chat = JSON.parse(o.body).chat_id;
    if (chat === '111') throw new Error(`fetch failed for ${url}`);
    sent.push(chat);
    return { ok: true };
  };
  await assert.rejects(sendTelegram(TG, 'x', 'en', fetchFn), (err) => {
    assert.match(err.message, /Anna \(111\)/);
    assert.ok(!err.message.includes(TG.botToken));
    assert.match(err.message, /bot\*\*\*/);
    return true;
  });
  assert.deepEqual(sent, ['222']);
});

test('notification texts: English, Italian and Spanish have the same keys and placeholders', () => {
  const keys = Object.keys(MESSAGES.en).sort();
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
  for (const l of ['it', 'es']) {
    assert.deepEqual(Object.keys(MESSAGES[l]).sort(), keys, l);
    for (const k of keys) assert.equal(ph(MESSAGES[l][k]), ph(MESSAGES.en[k]), `${l} ${k}`);
  }
  for (const k of ['err.emailFailed', 'err.emailRejected', 'err.telegramToken', 'update.subject', 'update.body']) assert.ok(MESSAGES.es[k], k);
});

// the real nodemailer against a local server that does not offer STARTTLS: with a user name the send must
// be refused and the password must never be sent
import net from 'node:net';
test('email (real nodemailer): a server without encryption is refused when there is a user name', async () => {
  const received = [];
  const server = net.createServer((sock) => {
    sock.write('220 test ESMTP\r\n');
    sock.on('data', (d) => {
      const line = d.toString();
      received.push(line);
      if (/^EHLO/i.test(line)) sock.write('250-test\r\n250 AUTH PLAIN LOGIN\r\n'); // no STARTTLS offered
      else if (/^QUIT/i.test(line)) sock.end('221 bye\r\n');
      else sock.write('250 ok\r\n');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const cfg = { ...MAIL, host: '127.0.0.1', port: server.address().port, secure: false, pass: 'S3cretPass' };
    await assert.rejects(sendEmail(cfg, 's', 'b', 'en'), /Email not sent: /);
    assert.ok(!received.join('').includes(Buffer.from('\0watchdog\0S3cretPass').toString('base64')), 'the password was sent in clear');
    assert.ok(!received.some((l) => /^AUTH/i.test(l)), 'no AUTH command before encryption');
  } finally {
    server.close();
  }
});

test('email (real nodemailer): one message, every recipient in the envelope, no Bcc line in the message', async () => {
  const seen = [];
  const server = net.createServer((sock) => {
    sock.write('220 test ESMTP\r\n');
    let inData = false;
    sock.on('data', (d) => {
      for (const line of d.toString().split('\r\n').filter(Boolean)) {
        seen.push(line);
        if (inData) {
          if (line === '.') {
            inData = false;
            sock.write('250 queued\r\n');
          }
        } else if (/^EHLO/i.test(line)) sock.write('250-test\r\n250 8BITMIME\r\n');
        else if (/^DATA/i.test(line)) {
          inData = true;
          sock.write('354 go\r\n');
        } else if (/^QUIT/i.test(line)) sock.end('221 bye\r\n');
        else sock.write('250 ok\r\n');
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await sendEmail({ enabled: true, host: '127.0.0.1', port: server.address().port, user: '', from: 'w@example.org', recipients: ['a@example.org', 'b@example.org'] }, 'subj', 'body', 'en');
    assert.deepEqual(seen.filter((l) => /^RCPT/i.test(l)), ['RCPT TO:<w@example.org>', 'RCPT TO:<a@example.org>', 'RCPT TO:<b@example.org>']);
    assert.equal(seen.filter((l) => /^DATA/i.test(l)).length, 1);
    assert.ok(!seen.some((l) => /^Bcc:/i.test(l)));
    assert.ok(seen.some((l) => /^To: w@example\.org/i.test(l)));
  } finally {
    server.close();
  }
});
