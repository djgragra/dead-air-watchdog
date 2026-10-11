// Tells, once per version and per channel, that a new version is out: desktop, Telegram and email.
// Only runs when Telegram or email is switched on and `notifications.updateAlert` is not off.
// A channel is marked as told only after the message was delivered; a failed send is tried again
// at the next check (every 24 hours) or as soon as the settings change.
import { t } from './messages.js';

export function createUpdateNotice({ getSettings, alertState, send, notifyDesktop = () => {}, log = () => {}, delays = [0, 10_000, 60_000], sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const busy = new Set();

  // three tries: right away, after 10 s, after 60 s
  async function sendWithRetries(channel, subject, text) {
    let last;
    for (const d of delays) {
      if (d) await sleep(d);
      try {
        return await send(channel, subject, text);
      } catch (err) {
        last = err;
      }
    }
    throw last;
  }

  // info: { available, latest, current, url } as returned by checkForUpdate
  async function announce(info) {
    if (!info?.available || !info.latest) return;
    const s = getSettings();
    const n = s.notifications;
    if (n.updateAlert === false) return;
    const channels = ['telegram', 'email'].filter((c) => n[c]?.enabled);
    if (!channels.length) return;
    const lang = s.language;
    const vars = { latest: info.latest, current: info.current, url: info.url || '' };
    const subject = t(lang, 'update.subject', vars);
    const text = t(lang, 'update.body', vars);

    if (n.desktop && !alertState.isTold(info.latest, 'desktop')) {
      notifyDesktop(subject.replace(/^\[[^\]]+\]\s*/, ''));
      alertState.markTold(info.latest, 'desktop');
    }
    await Promise.all(
      channels.map(async (channel) => {
        const key = `${info.latest}:${channel}`;
        if (alertState.isTold(info.latest, channel) || busy.has(key)) return;
        busy.add(key);
        try {
          await sendWithRetries(channel, subject, text);
          alertState.markTold(info.latest, channel);
          log(`update notice sent by ${channel}`, 'info');
        } catch (err) {
          log(`update notice by ${channel} failed (retried at the next check): ${err.message}`, 'warn');
        } finally {
          busy.delete(key);
        }
      })
    );
  }

  return { announce };
}
