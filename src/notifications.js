// Alert delivery: email (SMTP via nodemailer) and Telegram (Bot API), with retry.
// Credentials come from the user's settings only; nothing is hard-coded.
import { t, alertPrefix, withPrefix, hasPrefix, installationName } from './messages.js';
import { parseAddresses } from './addresses.js';
import { sendWebhook } from './webhook.js';

const TG_PREFIX = '[Dead Air Watchdog]';

// Telegram caps messages at 4096 characters; alerts are far shorter, this is only a guard.
const clip = (s) => (s.length > 4000 ? s.slice(0, 3997) + '…' : s);

export const TELEGRAM_TOKEN_RE = /^\d+:[\w-]{20,}$/;

export async function sendEmail(cfg, subject, text, lang = 'en', transportFactory = null) {
  if (!cfg?.enabled) return;
  const to = parseAddresses(cfg.recipients ?? cfg.to).valid;
  if (!cfg.host || !to.length || !(cfg.from || cfg.user)) throw new Error(t(lang, 'err.emailIncomplete'));
  // loaded on first use: keeps start-up light and lets the tests run without the package
  const create = transportFactory || (await import('nodemailer')).default.createTransport;
  const transporter = create({
    host: cfg.host,
    port: Number(cfg.port) || 587,
    secure: !!cfg.secure, // true = TLS from the start (usually port 465); false = STARTTLS
    requireTLS: !cfg.secure && !!cfg.user, // with a user name the password never travels in clear text
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000
  });
  try {
    // one message, all recipients in Bcc: they do not see each other's addresses
    const info = await transporter.sendMail({ from: cfg.from || cfg.user, to: 'undisclosed-recipients:;', bcc: to, subject, text });
    const rejected = info?.rejected || [];
    if (rejected.length) throw new Error(`${rejected.join(', ')}: ${t(lang, 'err.emailRejected')}`);
  } catch (err) {
    // the password never shows; very short ones are not masked or the text would be unreadable
    const msg = cfg.pass && cfg.pass.length >= 4 ? String(err.message).split(cfg.pass).join('***') : String(err.message);
    throw new Error(t(lang, 'err.emailFailed') + msg);
  } finally {
    transporter.close?.();
  }
}

export async function sendTelegram(cfg, text, lang = 'en', fetchFn = globalThis.fetch, prefix = TG_PREFIX) {
  if (!cfg?.enabled) return;
  const recipients = (cfg.recipients || []).filter((r) => String(r?.chatId || '').trim());
  if (!cfg.botToken || !recipients.length) throw new Error(t(lang, 'err.telegramIncomplete'));
  if (!TELEGRAM_TOKEN_RE.test(cfg.botToken)) throw new Error(t(lang, 'err.telegramToken'));
  // the bot may be shared with other programs: always say who is writing
  const body = clip(hasPrefix(text) ? text : `${prefix} ${text}`);
  const failures = [];
  for (const r of recipients) {
    try {
      const res = await fetchFn(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: String(r.chatId).trim(), text: body, link_preview_options: { is_disabled: true } }),
        signal: AbortSignal.timeout(15_000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    } catch (err) {
      // one bad recipient must not stop the others; the token must never end up in a log line
      failures.push(`${r.note ? r.note + ' ' : ''}(${r.chatId}): ${String(err.message).split(cfg.botToken).join('***')}`);
    }
  }
  if (failures.length) throw new Error(t(lang, 'err.telegramFailed') + failures.join(' | '));
}

// Sends one message on every enabled channel and retries the channels that failed.
// During an outage the network is often down too, so a failed alert is retried with growing
// pauses (30 s, 1 min, then every 2 min) for up to `maxAgeMs`; each channel stops when delivered.
export function createDispatcher({ getSettings, host = '', version = '', log = () => {}, onResult = () => {}, delays = [30_000, 60_000, 120_000], maxAgeMs = 30 * 60_000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, deps = {} }) {
  const mail = deps.sendEmail || sendEmail;
  const tg = deps.sendTelegram || sendTelegram;
  const wh = deps.sendWebhook || sendWebhook;
  const pending = new Set();

  function dispatch({ subject, text, label, event }) {
    const lang = getSettings().language;
    const prefix = alertPrefix(getSettings(), host); // [Dead Air Watchdog · installation name]
    subject = withPrefix(subject, prefix);
    const started = now();
    const state = { email: 'todo', telegram: 'todo', webhook: 'todo' };
    const errors = {};
    const channels = [
      ['email', (s) => mail(s.notifications.email, subject, text, lang)],
      ['telegram', (s) => tg(s.notifications.telegram, text, lang, undefined, prefix)],
      ['webhook', (s) => wh(s.notifications.webhook, { event, subject, text, installation: installationName(s, host), host, version, now: now() }, lang)]
    ];

    return new Promise((resolve) => {
      async function attempt(n) {
        const s = getSettings();
        for (const [name, send] of channels) {
          if (state[name] === 'done') continue;
          if (!s.notifications[name]?.enabled) {
            state[name] = 'done';
            continue;
          }
          try {
            await send(s);
            state[name] = 'done';
            log(`${label}: ${name} sent`, 'info');
            onResult({ channel: name, ok: true, label });
          } catch (err) {
            state[name] = 'failed';
            errors[name] = String(err.message).slice(0, 300);
            log(`${label}: ${name} failed (attempt ${n + 1}): ${err.message}`, 'warn');
            onResult({ channel: name, ok: false, label, error: String(err.message).slice(0, 300), attempt: n + 1 });
          }
        }
        const failed = Object.values(state).includes('failed');
        if (!failed) return resolve(true);
        const delay = delays[Math.min(n, delays.length - 1)];
        if (now() - started + delay > maxAgeMs) {
          log(`${label}: giving up`, 'error');
          for (const [name, st] of Object.entries(state)) if (st === 'failed') onResult({ channel: name, ok: false, label, giveUp: true, error: errors[name] || '' });
          return resolve(false);
        }
        const h = setTimer(() => {
          pending.delete(h);
          attempt(n + 1);
        }, delay);
        pending.add(h);
      }
      attempt(0);
    });
  }

  return { dispatch, cancelPending: () => {
      for (const h of pending) clearTimer(h);
      pending.clear();
    }
  };
}
