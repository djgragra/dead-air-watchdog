// Alert delivery: email (SMTP via nodemailer) and Telegram (Bot API), with retry.
// Credentials come from the user's settings only; nothing is hard-coded.
import { t } from './messages.js';

const TG_PREFIX = '[Dead Air Watchdog]';

// Telegram caps messages at 4096 characters; alerts are far shorter, this is only a guard.
const clip = (s) => (s.length > 4000 ? s.slice(0, 3997) + '…' : s);

export async function sendEmail(cfg, subject, text, lang = 'en', transportFactory = null) {
  if (!cfg?.enabled) return;
  if (!cfg.host || !cfg.to) throw new Error(t(lang, 'err.emailIncomplete'));
  // loaded on first use: keeps start-up light and lets the tests run without the package
  const create = transportFactory || (await import('nodemailer')).default.createTransport;
  const transporter = create({
    host: cfg.host,
    port: Number(cfg.port) || 587,
    secure: !!cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000
  });
  await transporter.sendMail({ from: cfg.from || cfg.user, to: cfg.to, subject, text });
}

export async function sendTelegram(cfg, text, lang = 'en', fetchFn = globalThis.fetch) {
  if (!cfg?.enabled) return;
  const recipients = (cfg.recipients || []).filter((r) => String(r?.chatId || '').trim());
  if (!cfg.botToken || !recipients.length) throw new Error(t(lang, 'err.telegramIncomplete'));
  // the bot may be shared with other programs: always say who is writing
  const body = clip(text.startsWith(TG_PREFIX) ? text : `${TG_PREFIX} ${text}`);
  const failures = [];
  for (const r of recipients) {
    try {
      const res = await fetchFn(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: String(r.chatId).trim(), text: body }),
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
export function createDispatcher({ getSettings, log = () => {}, delays = [30_000, 60_000, 120_000], maxAgeMs = 30 * 60_000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, deps = {} }) {
  const mail = deps.sendEmail || sendEmail;
  const tg = deps.sendTelegram || sendTelegram;
  const pending = new Set();

  function dispatch({ subject, text, label }) {
    const lang = getSettings().language;
    const started = now();
    const state = { email: 'todo', telegram: 'todo' };
    const channels = [
      ['email', (s) => mail(s.notifications.email, subject, text, lang)],
      ['telegram', (s) => tg(s.notifications.telegram, text, lang)]
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
          } catch (err) {
            state[name] = 'failed';
            log(`${label}: ${name} failed (attempt ${n + 1}): ${err.message}`, 'warn');
          }
        }
        const failed = Object.values(state).includes('failed');
        if (!failed) return resolve(true);
        const delay = delays[Math.min(n, delays.length - 1)];
        if (now() - started + delay > maxAgeMs) {
          log(`${label}: giving up`, 'error');
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
