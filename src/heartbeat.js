// Dead man's switch: while monitoring runs, the app sends a plain GET to a URL chosen by the user
// every few minutes. A service that expects those requests (and alerts when they stop) can then
// warn about what the app itself cannot: computer off, asleep, app crashed, network down.
// No body, no identifiers: only the request itself and a User-Agent with the app version.

export const validPingUrl = (u) => /^https?:\/\/[^\s/$.?#][^\s]*$/i.test(String(u || ''));

export function createHeartbeat({ getSettings, fetchFn, version = '0', log = () => {}, setIntervalFn = setInterval, clearIntervalFn = clearInterval, now = Date.now }) {
  let timer = null;
  let last = null; // { at, ok, error? }

  async function ping(urlOverride) {
    const url = urlOverride ?? getSettings().heartbeat.url;
    if (!validPingUrl(url)) return { ok: false, error: 'bad-url' };
    try {
      const res = await fetchFn(url, { method: 'GET', headers: { 'User-Agent': `Dead-Air-Watchdog/${version}` }, signal: AbortSignal.timeout(15_000) });
      // the body is not needed; drain it so the connection is released
      await res.arrayBuffer?.().catch(() => {});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message).replace(/https?:\/\/\S+/g, '<url>') }; // the URL carries a secret: keep it out of messages
    }
  }

  async function tick() {
    const hb = getSettings().heartbeat;
    if (!hb.enabled || !validPingUrl(hb.url)) return;
    last = { at: now(), ...(await ping()) };
    if (!last.ok) log(`heartbeat failed: ${last.error}`, 'warn');
  }

  return {
    start() {
      this.stop();
      const hb = getSettings().heartbeat;
      if (!hb.enabled || !validPingUrl(hb.url)) return;
      tick();
      timer = setIntervalFn(tick, hb.intervalMin * 60_000);
    },
    stop() {
      if (timer !== null) clearIntervalFn(timer);
      timer = null;
    },
    restart() {
      if (timer !== null) this.start(); // only while monitoring is running
    },
    isActive: () => timer !== null,
    ping,
    last: () => last
  };
}
