// Silencing the alarm sound from Telegram: a message "/silenzia" (or "/mute", "/silencio") sent to the bot by one of the chats
// that are already recipients of the alerts. Off by default (Settings → Alerts → Telegram), and only while monitoring.
// The app asks Telegram for new messages every few seconds (getUpdates, no webhook). Messages from any other chat are ignored
// and never answered. Messages that were waiting before the app started are thrown away (an old command must not fire).
// A bot that another program already reads with getUpdates (or that has a webhook) answers 409: the app then waits a minute.
import { t } from './messages.js';

export const COMMANDS = ['/silenzia', '/mute', '/silencio'];
const POLL_MS = 5000;
const BACKOFF_MS = 60_000;

// "/Silenzia@MyBot extra" -> "/silenzia"; anything else -> ''
export function parseCommand(text) {
  const m = /^\s*(\/[a-z]+)(?:@\w+)?(?:\s|$)/i.exec(String(text ?? ''));
  const cmd = m ? m[1].toLowerCase() : '';
  return COMMANDS.includes(cmd) ? cmd : '';
}

export function createTelegramCommands({ getSettings, isActive = () => true, fetchFn = globalThis.fetch, onMute, log = () => {}, setIntervalFn = setInterval, clearIntervalFn = clearInterval, now = Date.now, pollMs = POLL_MS }) {
  let timer = null;
  let offset = null; // null: the old updates have not been thrown away yet
  let busy = false;
  let pauseUntil = 0;
  let warned = false;

  const cfg = () => {
    const tg = getSettings().notifications?.telegram || {};
    return { on: !!(tg.enabled && tg.commands && tg.botToken), token: tg.botToken, chats: (tg.recipients || []).map((r) => String(r?.chatId ?? '').trim()).filter(Boolean) };
  };
  const call = async (token, method, body) => {
    const res = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  };
  const scrub = (e, token) => String(e?.message || e).split(token).join('***'); // the token never ends up in a log line

  async function poll() {
    if (busy) return;
    const c = cfg();
    if (!c.on || !isActive() || now() < pauseUntil) return;
    busy = true;
    try {
      if (offset === null) {
        const r = await call(c.token, 'getUpdates', { offset: -1, limit: 1, timeout: 0 });
        const last = r.result?.at(-1);
        offset = last ? last.update_id + 1 : 0;
        return;
      }
      const r = await call(c.token, 'getUpdates', { offset, timeout: 0, allowed_updates: ['message'] });
      warned = false;
      for (const u of r.result || []) {
        offset = Math.max(offset, u.update_id + 1);
        const msg = u.message;
        if (!msg?.chat) continue;
        const chat = String(msg.chat.id);
        if (!c.chats.includes(chat)) {
          log(`Telegram command from a chat that is not a recipient (${chat}) ignored`, 'warn');
          continue; // no answer: a stranger gets nothing
        }
        if (!parseCommand(msg.text)) continue;
        const was = !!onMute();
        const lang = getSettings().language;
        await call(c.token, 'sendMessage', { chat_id: chat, text: t(lang, was ? 'tg.cmd.muted' : 'tg.cmd.nothing'), reply_to_message_id: msg.message_id }).catch((e) => log(`Telegram answer failed: ${scrub(e, c.token)}`, 'warn'));
        log(`alarm sound silenced from Telegram (${was ? 'it was sounding' : 'nothing was sounding'})`, 'info');
      }
    } catch (e) {
      if (e.status === 409) pauseUntil = now() + BACKOFF_MS; // a webhook, or another program reads this bot
      if (!warned) log(`Telegram commands: ${scrub(e, c.token)}${e.status === 409 ? ' (another program reads this bot, or it has a webhook)' : ''}`, 'warn');
      warned = true;
      offset = offset === null ? null : offset;
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setIntervalFn(poll, pollMs);
      timer?.unref?.();
    },
    stop() {
      if (timer) clearIntervalFn(timer);
      timer = null;
      offset = null; // next time the old messages are thrown away again
    },
    poll
  };
}
