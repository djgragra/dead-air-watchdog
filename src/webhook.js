// Alert delivery by HTTP: one request per alert to an address chosen by the user (a studio screen, Node-RED,
// Home Assistant, a status page...). POST sends JSON, GET puts the same fields in the address.
// The address usually carries a secret token and so does the optional Authorization value: neither ever
// appears in an error message or a log line.
import { t } from './messages.js';
import { validPingUrl } from './heartbeat.js';

export const validWebhookUrl = validPingUrl;
export const WEBHOOK_METHODS = ['POST', 'GET'];

const iso = (ts) => (Number.isFinite(ts) ? new Date(ts).toISOString() : null);

// What the receiver gets. `event`: { kind: 'alarm' | 'reminder' | 'recovered' | 'test', items: [{ input, cause, start, end, durationMs }] }.
// Field names are part of the interface: new fields may be added, existing ones are not renamed.
export function buildWebhookPayload({ event, subject, text, installation = '', host = '', version = '', now = Date.now() }) {
  const items = Array.isArray(event?.items) ? event.items : [];
  return {
    app: 'Dead Air Watchdog',
    version,
    event: event?.kind || 'info',
    time: iso(now),
    installation,
    host,
    subject,
    message: text,
    inputs: items.map((i) => ({
      name: String(i.input ?? ''),
      cause: String(i.cause || 'silence'),
      since: iso(i.start),
      until: iso(i.end),
      durationSec: Number.isFinite(i.durationMs) ? Math.round(i.durationMs / 1000) : null
    }))
  };
}

// GET: the same facts as plain query fields (inputs joined, the first cause).
export function webhookGetUrl(url, p) {
  const u = new URL(url);
  const q = {
    event: p.event,
    time: p.time,
    installation: p.installation,
    host: p.host,
    count: String(p.inputs.length),
    input: p.inputs.map((i) => i.name).join(', '),
    cause: p.inputs[0]?.cause || '',
    message: p.message
  };
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v ?? '');
  return u.toString();
}

export async function sendWebhook(cfg, msg, lang = 'en', fetchFn = globalThis.fetch) {
  if (!cfg?.enabled) return;
  if (!validWebhookUrl(cfg.url)) throw new Error(t(lang, 'err.webhookIncomplete'));
  const payload = buildWebhookPayload(msg);
  const get = cfg.method === 'GET';
  const headers = { 'User-Agent': `Dead-Air-Watchdog/${msg.version || '0'}` };
  if (cfg.authHeader) headers.Authorization = cfg.authHeader;
  if (!get) headers['Content-Type'] = 'application/json';
  // errors may repeat what the library was given: hide the address and the token wherever they appear
  const hide = (s) => {
    let out = String(s);
    for (const secret of [cfg.url, cfg.authHeader, safe(() => new URL(cfg.url).host)]) if (secret && String(secret).length >= 4) out = out.split(secret).join('***');
    return out.replace(/https?:\/\/\S+/g, '<url>');
  };
  try {
    const res = await fetchFn(get ? webhookGetUrl(cfg.url, payload) : cfg.url, {
      method: get ? 'GET' : 'POST',
      headers,
      body: get ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000)
    });
    await res.arrayBuffer?.().catch(() => {}); // release the connection
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    throw new Error(t(lang, 'err.webhookFailed') + hide(err.message));
  }
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return '';
  }
}
