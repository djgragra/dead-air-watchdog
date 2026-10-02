// Settings, event log and small runtime metadata in one JSON file, written atomically.
// Passwords and tokens can be sealed (encrypted) by the caller-supplied seal/open functions;
// the Electron main process passes safeStorage-based ones (OS keystore), tests pass none.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_INPUTS = 32;

export const DEFAULT_INPUT = Object.freeze({
  id: '',
  name: '', // empty = derived from the stream host or the device name
  type: 'stream', // 'stream' | 'device'
  deviceId: '', // device only; '' = system default input
  deviceLabel: '',
  channelPair: 0, // device only: 0 = channels 1-2, 1 = 3-4, 2 = 5-6, 3 = 7-8
  streamUrl: '',
  thresholdDb: -50,
  minSilenceSec: 30,
  enabled: true
});

export const DEFAULT_SETTINGS = Object.freeze({
  language: 'en', // 'en' | 'it' | 'es' — the app always starts in English until the user changes it
  theme: 'dark', // 'dark' | 'light' | 'auto'
  inputs: [], // see DEFAULT_INPUT: at most one sound card and any number of streams (MAX_INPUTS in total)
  display: {
    edgeGlow: 'wall', // screen-edge glow: 'wall' (only in wall display) | 'always' | 'off'
    startInWall: false // open straight into the full-screen wall display (control-room monitor)
  },
  notifications: {
    desktop: true,
    reminderMin: 0, // 0 = no reminders while the alarm lasts
    sound: { enabled: false, volume: 0.6 }, // audible alarm on this computer while dead air lasts
    email: { enabled: false, host: '', port: 587, secure: false, user: '', pass: '', from: '', to: '' },
    telegram: { enabled: false, botToken: '', recipients: [] } // recipients: [{ chatId, note }]
  },
  general: {
    startOnBoot: true,
    startMinimized: false,
    autoStartMonitoring: true,
    keepAwake: true,
    retentionDays: 365,
    checkUpdates: true,
    updateRepo: 'djgragra/dead-air-watchdog'
  },
  heartbeat: { enabled: false, url: '', intervalMin: 5 }, // dead man's switch: GET to a service that alerts when pings stop
  micExplained: false, // the permission explanation was shown and accepted
  closeHintShown: false
});

const SECRET_PATHS = [
  ['notifications', 'email', 'pass'],
  ['notifications', 'telegram', 'botToken'],
  ['heartbeat', 'url'] // ping URLs usually carry a secret token
];
// inputs[].streamUrl may carry credentials (user:pass@host) and is sealed as well
const PREFIX = 'enc:v1:';

// GitHub "owner/repo": owner letters, digits, hyphens; repo letters, digits, "_", "-", "." (not "." or "..").
export const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_][\w.-]{0,99}$/;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function deepMerge(base, patch) {
  if (!isObj(base) || !isObj(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const k of Object.keys(patch)) out[k] = isObj(base[k]) && isObj(patch[k]) ? deepMerge(base[k], patch[k]) : patch[k];
  return out;
}

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

// Settings of versions that had a single input ("input" + "detection") become one entry of "inputs".
function migrateLegacy(raw) {
  if (!raw || Array.isArray(raw.inputs) || !isObj(raw.input)) return raw;
  const { input, detection, ...rest } = raw;
  const configured = input.type === 'stream' ? !!input.streamUrl : true;
  return { ...rest, inputs: configured ? [{ ...input, thresholdDb: detection?.thresholdDb, minSilenceSec: detection?.minSilenceSec }] : [] };
}

function sanitizeInput(raw, usedIds, hasDevice) {
  const d = DEFAULT_INPUT;
  const i = { ...d, ...(isObj(raw) ? raw : {}) };
  i.type = i.type === 'device' ? 'device' : 'stream';
  if (i.type === 'device' && hasDevice) return null; // only one sound card
  let id = String(i.id || '');
  if (!/^[\w-]{1,64}$/.test(id) || usedIds.has(id)) id = randomUUID();
  usedIds.add(id);
  i.id = id;
  i.name = String(i.name || '').trim().slice(0, 60);
  i.deviceId = String(i.deviceId || '');
  i.deviceLabel = String(i.deviceLabel || '').slice(0, 200);
  i.channelPair = Math.round(clamp(i.channelPair, 0, 3, 0));
  i.streamUrl = String(i.streamUrl || '').trim().slice(0, 2000);
  i.thresholdDb = clamp(i.thresholdDb, -90, -10, d.thresholdDb);
  i.minSilenceSec = Math.round(clamp(i.minSilenceSec, 1, 3600, d.minSilenceSec));
  i.enabled = i.enabled !== false;
  return Object.fromEntries(Object.keys(d).map((k) => [k, i[k]]));
}

// Keeps stored values inside what the rest of the app can handle (also for hand-edited files).
export function sanitizeSettings(s) {
  const d = DEFAULT_SETTINGS;
  const out = deepMerge(structuredClone(d), migrateLegacy(s) || {});
  if (!['en', 'it', 'es'].includes(out.language)) out.language = d.language;
  if (!['dark', 'light', 'auto'].includes(out.theme)) out.theme = d.theme;
  if (!['wall', 'always', 'off'].includes(out.display.edgeGlow)) out.display.edgeGlow = d.display.edgeGlow;
  out.display.startInWall = !!out.display.startInWall;
  const used = new Set();
  let hasDevice = false;
  out.inputs = (Array.isArray(out.inputs) ? out.inputs : [])
    .slice(0, MAX_INPUTS)
    .map((raw) => {
      const i = sanitizeInput(raw, used, hasDevice);
      if (i?.type === 'device') hasDevice = true;
      return i;
    })
    .filter(Boolean);
  out.notifications.reminderMin = Math.round(clamp(out.notifications.reminderMin, 0, 1440, 0));
  out.notifications.sound.enabled = !!out.notifications.sound.enabled;
  out.notifications.sound.volume = Math.round(clamp(out.notifications.sound.volume, 0.05, 1, 0.6) * 100) / 100;
  out.heartbeat.enabled = !!out.heartbeat.enabled;
  out.heartbeat.url = String(out.heartbeat.url || '').trim().slice(0, 2000);
  out.heartbeat.intervalMin = Math.round(clamp(out.heartbeat.intervalMin, 1, 60, 5));
  out.notifications.email.port = Math.round(clamp(out.notifications.email.port, 1, 65535, 587));
  const rec = Array.isArray(out.notifications.telegram.recipients) ? out.notifications.telegram.recipients : [];
  out.notifications.telegram.recipients = rec
    .map((r) => ({ chatId: String(r?.chatId ?? '').trim(), note: String(r?.note ?? '').trim().slice(0, 80) }))
    .filter((r) => r.chatId)
    .slice(0, 20);
  out.general.retentionDays = Math.round(clamp(out.general.retentionDays, 30, 3650, 365));
  if (!REPO_RE.test(out.general.updateRepo || '')) out.general.updateRepo = d.general.updateRepo;
  delete out.input;
  delete out.detection;
  return out;
}

function mapSecrets(settings, fn) {
  const s = structuredClone(settings);
  for (const p of SECRET_PATHS) {
    let o = s;
    for (let i = 0; i < p.length - 1; i++) o = o?.[p[i]];
    if (o && typeof o[p.at(-1)] === 'string' && o[p.at(-1)]) o[p.at(-1)] = fn(o[p.at(-1)]);
  }
  for (const i of Array.isArray(s.inputs) ? s.inputs : []) if (i && typeof i.streamUrl === 'string' && i.streamUrl) i.streamUrl = fn(i.streamUrl);
  if (isObj(s.input) && typeof s.input.streamUrl === 'string' && s.input.streamUrl) s.input.streamUrl = fn(s.input.streamUrl); // legacy
  return s;
}

export function createStore({ file, seal = (v) => v, open = (v) => v, now = Date.now } = {}) {
  let data = load();
  let timer = null;

  function empty() {
    return { settings: structuredClone(DEFAULT_SETTINGS), events: [], meta: { lastHeartbeat: null, cleanExit: true } };
  }

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const d = empty();
      d.settings = sanitizeSettings(mapSecrets(raw.settings || {}, open));
      d.events = Array.isArray(raw.events) ? raw.events.filter((e) => e && typeof e.start === 'number') : [];
      d.meta = { ...d.meta, ...(isObj(raw.meta) ? raw.meta : {}) };
      return d;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // unreadable or corrupt: keep the file for inspection instead of silently overwriting it
        try {
          fs.renameSync(file, `${file}.corrupt-${now()}`);
        } catch {
          /* ignore */
        }
      }
      return empty();
    }
  }

  function writeNow() {
    clearTimeout(timer);
    timer = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    const out = { version: 1, settings: mapSecrets(data.settings, seal), events: data.events, meta: data.meta };
    fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function schedule() {
    if (!timer) timer = setTimeout(writeNow, 300);
  }

  return {
    getSettings: () => structuredClone(data.settings),
    updateSettings(patch) {
      data.settings = sanitizeSettings(deepMerge(data.settings, patch));
      schedule();
      return structuredClone(data.settings);
    },
    getMeta: () => ({ ...data.meta }),
    setMeta(patch) {
      data.meta = { ...data.meta, ...patch };
      schedule();
    },
    listEvents: () => data.events.map((e) => ({ ...e })),
    addEvent(ev) {
      const e = { id: randomUUID(), ...ev };
      data.events.push(e);
      schedule();
      return e;
    },
    updateEvent(id, patch) {
      const e = data.events.find((x) => x.id === id);
      if (!e) return null;
      Object.assign(e, patch);
      schedule();
      return { ...e };
    },
    clearEvents() {
      data.events = [];
      schedule();
    },
    pruneEvents(retentionDays) {
      const cutoff = now() - retentionDays * 86_400_000;
      const before = data.events.length;
      data.events = data.events.filter((e) => (e.end ?? e.start) >= cutoff);
      if (data.events.length !== before) schedule();
      return before - data.events.length;
    },
    flush: writeNow
  };
}
