// Settings, event log and small runtime metadata in one JSON file, written atomically.
// Passwords and tokens can be sealed (encrypted) by the caller-supplied seal/open functions;
// the Electron main process passes safeStorage-based ones (OS keystore), tests pass none.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mapSecrets } from './secrets.js';
import { parseAddresses } from './addresses.js';
import { DEFAULT_SCHEDULE, sanitizeSchedule } from './core/schedule.js';

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
  yellowDelaySec: 2, // the traffic light of the input stays green until the audio has been below the threshold this long (0 = at once)
  frozenSec: 0, // 0 = off; otherwise: a level that stays (almost) the same for this long above the threshold is an alarm ("frozen audio")
  frozenToleranceDb: 1, // how much the level may vary and still count as the same
  schedule: DEFAULT_SCHEDULE, // monitoring hours: see src/core/schedule.js
  enabled: true
});

export const DEFAULT_SETTINGS = Object.freeze({
  language: 'en', // 'en' | 'it' | 'es' — the app always starts in English until the user changes it
  theme: 'dark', // 'dark' | 'light' | 'auto'
  inputs: [], // see DEFAULT_INPUT: at most one sound card and any number of streams (MAX_INPUTS in total)
  installationName: '', // shown in alerts as [Dead Air Watchdog · name]; empty = the computer name
  display: {
    edgeGlow: 'wall', // screen-edge glow: 'wall' (only in wall display) | 'always' | 'off'
    startInWall: false, // open straight into the full-screen wall display (control-room monitor)
    wallNameSize: 'auto', // size of the input names in the wall display: 'auto' (shrinks long names to fit) | 'large' | 'medium' | 'small'
    wallLogo: 'large', // logo of an input in the wall display: 'small' | 'large' | 'faded' (big, soft, behind the tile)
    wallLogoOpacity: 0.2, // how strong the 'faded' logo is (0.05 to 0.5)
    wallClock: 'max' // size of the clock and date in the wall display: 'max' (as large as fits) | 'large' | 'normal'
  },
  notifications: {
    desktop: true,
    reminderMin: 0, // 0 = no reminders while the alarm lasts
    sound: { enabled: false, volume: 0.6 }, // audible alarm on this computer while dead air lasts
    email: { enabled: false, host: '', port: 587, secure: false, user: '', pass: '', from: '', recipients: [] }, // recipients: [address], all sent in Bcc
    telegram: { enabled: false, botToken: '', recipients: [] }, // recipients: [{ chatId, note }]
    webhook: { enabled: false, url: '', method: 'POST', authHeader: '' }, // one HTTP request per alert (src/webhook.js); url and authHeader are secrets
    updateAlert: true, // tell by email / Telegram, once per version, that a new version is out
    grouping: { enabled: true, windowSec: 60, firstNow: true } // several inputs failing (or coming back) together: one message with the list
  },
  general: {
    startOnBoot: true,
    startMinimized: false,
    autoStartMonitoring: true,
    keepAwake: true,
    retentionDays: 365,
    microRetentionDays: 30, // brief drops below the threshold (micro-silences) are kept for less time than the alarms
    checkUpdates: true,
    updateRepo: 'djgragra/dead-air-watchdog'
  },
  heartbeat: { enabled: false, url: '', intervalMin: 5 }, // dead man's switch: GET to a service that alerts when pings stop
  micExplained: false, // the permission explanation was shown and accepted
  closeHintShown: false,
  updateState: { skipVersion: '', remindUntil: 0, lastCheck: null }, // what the user decided about a new version; lastCheck { at, ok, error }
  lastSeenVersion: '', // the version that last ran: a newer one at start-up means "updated" (What's new window)
  window: { x: null, y: null, width: 1180, height: 780, maximized: false } // remembered place and size of the main window
});

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
  i.yellowDelaySec = Math.round(clamp(i.yellowDelaySec, 0, 60, d.yellowDelaySec) * 10) / 10;
  const fz = Number(i.frozenSec);
  i.frozenSec = Number.isFinite(fz) && fz > 0 ? Math.round(clamp(fz, 10, 3600, 60)) : 0;
  i.frozenToleranceDb = Math.round(clamp(i.frozenToleranceDb, 0.1, 6, d.frozenToleranceDb) * 10) / 10;
  i.schedule = sanitizeSchedule(i.schedule, { thresholdDb: i.thresholdDb, minSilenceSec: i.minSilenceSec });
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
  if (!['auto', 'large', 'medium', 'small'].includes(out.display.wallNameSize)) out.display.wallNameSize = d.display.wallNameSize;
  if (!['small', 'large', 'faded'].includes(out.display.wallLogo)) out.display.wallLogo = d.display.wallLogo;
  out.display.wallLogoOpacity = Math.round(clamp(out.display.wallLogoOpacity, 0.05, 0.5, d.display.wallLogoOpacity) * 100) / 100;
  if (!['max', 'large', 'normal'].includes(out.display.wallClock)) out.display.wallClock = d.display.wallClock;
  out.installationName = String(out.installationName || '').trim().slice(0, 60);
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
  const em = out.notifications.email;
  em.port = Math.round(clamp(em.port, 1, 65535, 587));
  em.secure = !!em.secure;
  // settings of versions up to 26.10.1 had one text field "to": it becomes the list of recipients
  em.recipients = parseAddresses([...(Array.isArray(em.recipients) ? em.recipients : [em.recipients]), em.to]).valid;
  delete em.to;
  out.notifications.updateAlert = out.notifications.updateAlert !== false;
  const rec = Array.isArray(out.notifications.telegram.recipients) ? out.notifications.telegram.recipients : [];
  out.notifications.telegram.recipients = rec
    .map((r) => ({ chatId: String(r?.chatId ?? '').trim(), note: String(r?.note ?? '').trim().slice(0, 80) }))
    .filter((r) => r.chatId)
    .slice(0, 20);
  const wh = out.notifications.webhook;
  wh.enabled = !!wh.enabled;
  wh.url = String(wh.url || '').trim().slice(0, 2000);
  wh.method = wh.method === 'GET' ? 'GET' : 'POST';
  wh.authHeader = String(wh.authHeader || '').trim().slice(0, 500);
  const gr = out.notifications.grouping;
  gr.enabled = gr.enabled !== false;
  gr.windowSec = Math.round(clamp(gr.windowSec, 10, 600, 60));
  gr.firstNow = gr.firstNow !== false;
  out.general.retentionDays = Math.round(clamp(out.general.retentionDays, 30, 3650, 365));
  out.general.microRetentionDays = Math.round(clamp(out.general.microRetentionDays, 1, 365, 30));
  const us = isObj(out.updateState) ? out.updateState : {};
  const lc = isObj(us.lastCheck) && Number.isFinite(us.lastCheck.at) ? { at: us.lastCheck.at, ok: !!us.lastCheck.ok, error: String(us.lastCheck.error || '').slice(0, 300) } : null;
  out.updateState = { skipVersion: String(us.skipVersion || '').slice(0, 40), remindUntil: Number.isFinite(us.remindUntil) ? us.remindUntil : 0, lastCheck: lc };
  out.lastSeenVersion = String(out.lastSeenVersion || '').slice(0, 40);
  const w = isObj(out.window) ? out.window : {};
  const hasPos = Number.isFinite(w.x) && Number.isFinite(w.y);
  out.window = { x: hasPos ? Math.round(w.x) : null, y: hasPos ? Math.round(w.y) : null, width: Math.round(clamp(w.width, 760, 8000, 1180)), height: Math.round(clamp(w.height, 560, 8000, 780)), maximized: !!w.maximized };
  if (!REPO_RE.test(out.general.updateRepo || '')) out.general.updateRepo = d.general.updateRepo;
  delete out.input;
  delete out.detection;
  return out;
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
    // retentionDays: alarms, gaps and pauses. Micro-silences (kind 'blip') are many and small: they are kept for
    // `blipDays` and never more than `blipMax` of them (the oldest go first).
    pruneEvents(retentionDays, { blipDays = 30, blipMax = 5000 } = {}) {
      const t = now();
      const cutoff = t - retentionDays * 86_400_000;
      const blipCutoff = t - blipDays * 86_400_000;
      const before = data.events.length;
      data.events = data.events.filter((e) => (e.end ?? e.start) >= (e.kind === 'blip' ? blipCutoff : cutoff));
      const blips = data.events.filter((e) => e.kind === 'blip');
      if (blips.length > blipMax) {
        const drop = new Set(blips.sort((a, b) => a.start - b.start).slice(0, blips.length - blipMax));
        data.events = data.events.filter((e) => !drop.has(e));
      }
      if (data.events.length !== before) schedule();
      return before - data.events.length;
    },
    flush: writeNow
  };
}
