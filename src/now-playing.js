// "Now playing": the song title that Icecast and Shoutcast servers send inside the stream (ICY metadata).
// The audio engine plays the stream in a hidden <audio> element, which does not show this information, so for the
// inputs that switched it on the main process opens a second, short request with "Icy-MetaData: 1", reads the first
// metadata block (a few KB of audio and a line of text) and closes it. It is asked again every INTERVAL_MS.
// Nothing is stored: the title lives in memory and is shown on the tiles; the audio read here is thrown away.
// Everything with side effects is injected (fetch, timers, clock), so tests drive it with a local server.

export const INTERVAL_MS = 20_000; // how often the title of one input is asked again
export const STALE_MS = 90_000; // a title that could not be renewed for this long is no longer shown
const TIMEOUT_MS = 8000; // one request: connect, read up to 3 metadata blocks, close
const MAX_METAINT = 262_144; // a server that announces a longer interval is not read
const MAX_BLOCKS = 3; // Icecast sends the title in the first block; a few more in case it sends an empty one first
const MAX_TITLE = 200;
const MAX_PARALLEL = 4;
const TICK_MS = 5000;

// "StreamTitle='Artist - Song';StreamUrl='';" -> "Artist - Song". The title may itself contain apostrophes, so the end is
// the quote followed by ";" (or the end of the block).
export function parseStreamTitle(meta) {
  const m = /StreamTitle='([\s\S]*?)'\s*(?:;|$)/.exec(String(meta || ''));
  return m ? cleanTitle(m[1]) : '';
}

export function cleanTitle(s) {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE);
}

// Metadata is text in the encoding of the server: most send UTF-8, some Latin-1.
function decode(bytes) {
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  return utf8.includes('�') ? new TextDecoder('latin1').decode(bytes) : utf8;
}

// Opens the stream, reads until the first metadata block that has text, closes it. Returns { ok, title }:
// ok false = this server does not send metadata (or could not be read); title '' = it does, but nothing is announced now.
export async function readNowPlaying(url, fetchFn, { timeoutMs = TIMEOUT_MS } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let reader = null;
  try {
    const res = await fetchFn(url, { headers: { 'Icy-MetaData': '1', Accept: '*/*' }, signal: ctl.signal });
    if (!res.ok || !res.body) return { ok: false, title: '' };
    const interval = Number(res.headers.get('icy-metaint'));
    if (!Number.isInteger(interval) || interval <= 0 || interval > MAX_METAINT) return { ok: false, title: '' };
    reader = res.body.getReader();
    let buf = new Uint8Array(0);
    const need = async (n) => {
      while (buf.length < n) {
        const { done, value } = await reader.read();
        if (done) return false;
        const next = new Uint8Array(buf.length + value.length);
        next.set(buf);
        next.set(value, buf.length);
        buf = next;
      }
      return true;
    };
    for (let block = 0; block < MAX_BLOCKS; block++) {
      if (!(await need(interval + 1))) return { ok: false, title: '' };
      const len = buf[interval] * 16;
      if (!(await need(interval + 1 + len))) return { ok: false, title: '' };
      if (len > 0) {
        const title = parseStreamTitle(decode(buf.subarray(interval + 1, interval + 1 + len)));
        return { ok: true, title };
      }
      buf = buf.subarray(interval + 1); // an empty block: the audio goes on, the next block is `interval` bytes further
    }
    return { ok: true, title: '' };
  } catch {
    return { ok: false, title: '' };
  } finally {
    clearTimeout(timer);
    try { await reader?.cancel(); } catch { /* already closed */ }
    ctl.abort();
  }
}

const wanted = (inp) => inp.enabled && inp.type === 'stream' && inp.nowPlaying === true && /^https?:\/\/[^\s]+$/i.test(inp.streamUrl || '');

// The titles of the inputs that asked for them. `publish(map)` gets { inputId: title } (only inputs with a title) whenever it changes.
export function createNowPlaying({ getSettings, isActive = () => true, fetchFn, publish = () => {}, now = Date.now, read = readNowPlaying, setIntervalFn = setInterval, clearIntervalFn = clearInterval, log = () => {} }) {
  const state = new Map(); // input id -> { url, title, at (last good answer), asked (last request), busy }
  let timer = null;
  let lastKey = '{}'; // nothing shown yet

  const snapshot = () => {
    const t = now();
    const out = {};
    for (const [id, s] of state) if (s.title && t - s.at < STALE_MS) out[id] = s.title;
    return out;
  };
  const emit = () => {
    const snap = snapshot();
    const key = JSON.stringify(snap);
    if (key === lastKey) return;
    lastKey = key;
    publish(snap);
  };

  async function ask(inp, s) {
    s.busy = true;
    s.asked = now();
    try {
      const r = await read(inp.streamUrl, fetchFn);
      if (state.get(inp.id) !== s) return; // the input was removed or its address changed meanwhile
      if (r.ok) { s.title = r.title; s.at = now(); }
      else log(`now playing: no metadata from ${inp.name || inp.id}`, 'info');
    } finally {
      s.busy = false;
    }
    emit();
  }

  // One pass: forgets the inputs that no longer ask for it, asks the ones that are due (at most MAX_PARALLEL at a time).
  function tick() {
    const inputs = getSettings().inputs.filter(wanted);
    const ids = new Set(inputs.map((i) => i.id));
    for (const [id, s] of state) if (!ids.has(id) || s.url !== inputs.find((i) => i.id === id).streamUrl) state.delete(id);
    if (isActive()) {
      let busy = [...state.values()].filter((s) => s.busy).length;
      for (const inp of inputs) {
        let s = state.get(inp.id);
        if (!s) { s = { url: inp.streamUrl, title: '', at: 0, asked: 0, busy: false }; state.set(inp.id, s); }
        if (s.busy || busy >= MAX_PARALLEL || now() - s.asked < INTERVAL_MS) continue;
        busy++;
        ask(inp, s);
      }
    }
    emit();
  }

  return {
    start() { if (!timer) { timer = setIntervalFn(tick, TICK_MS); timer?.unref?.(); tick(); } },
    stop() { clearIntervalFn(timer); timer = null; state.clear(); emit(); },
    refresh() { for (const s of state.values()) s.asked = 0; tick(); }, // the window is visible again: ask now
    get: snapshot,
    tick
  };
}
