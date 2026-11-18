// garage-common: backup 1
// Configuration backup: build the file, read it back, say what must be typed again.
// Electron-free and file-free (the main process asks for the file and applies the plan), so it can
// be tested. Settings here are the plain ones; sealed values (enc:v1:) never come out of a file.
import { sanitizeSettings, MAX_INPUTS } from './store.js';
import { SEALED_PREFIX, secretSlots, stripSecrets, withoutUserInfo, hasUserInfo } from './secrets.js';
import { decodeLogo } from './logos.js';

export const BACKUP_APP = 'dead-air-watchdog';
export const BACKUP_VERSION = 1;
// The logos (small PNG files, up to 400 kB each, 32 inputs at most) travel inside the file as data URLs.
export const MAX_BACKUP_BYTES = 20_000_000;
// The same limit applies to what is written and to what is read: a backup the app writes can always be read back.
export const backupTooBig = (text) => Buffer.byteLength(text) > MAX_BACKUP_BYTES;
// kept on this PC, not part of the file: what the user was told once
const RUNTIME_KEYS = ['micExplained', 'closeHintShown', 'updateState', 'lastSeenVersion', 'engineIntroSeen', 'window', 'compactWindow'];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const dateStamp = (ms) => new Date(ms).toISOString().slice(0, 10);

export const backupFileName = (now = Date.now()) => `${BACKUP_APP}-backup-${dateStamp(now)}.json`;

// settings: the plain settings of the app. logos: { logoId: PNG data URL } of the stored logos: only the ones the inputs
// in the file use go in, each once even if several inputs share it. Returns the object to write as JSON.
export function buildExport(settings, { includeSecrets = false, now = Date.now(), logos = {} } = {}) {
  let s = structuredClone(settings);
  let emptied = [];
  if (!includeSecrets) ({ settings: s, emptied } = stripSecrets(s));
  for (const k of RUNTIME_KEYS) delete s[k];
  const inputs = Array.isArray(s.inputs) ? s.inputs : [];
  delete s.inputs;
  const file = { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: new Date(now).toISOString(), includesSecrets: !!includeSecrets, settings: s, inputs };
  if (emptied.length) file.emptiedSecrets = emptied; // which secrets had a value and were left out
  const kept = {};
  const stationsOf = Array.isArray(s.stations) ? s.stations : [];
  for (const x of [...inputs, ...stationsOf]) { // the logos of the inputs and of the stations, each once
    if (x.logo && isObj(logos) && typeof logos[x.logo] === 'string') kept[x.logo] = logos[x.logo];
  }
  if (Object.keys(kept).length) file.logos = kept; // a file from a version without logos simply has no such key
  return file;
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return String(url || '').replace(/^[a-z]+:\/\//i, '').replace(/^.*@/, '').split(/[/?#]/)[0];
  }
};
const inputName = (i) => i.name || hostOf(i.streamUrl) || i.deviceLabel || '';

// What the user has to type again in `settings`: secrets that are needed and empty.
// `emptied` (ids from the file or from sealed values dropped) marks stream addresses that lost their credentials.
export function missingSecrets(settings, emptied = [], { onlyInputIds = null } = {}) {
  const out = [];
  const em = settings.notifications?.email || {};
  if ((em.enabled || em.host) && em.user && !em.pass) out.push({ id: 'email.pass', kind: 'email.pass' });
  const tg = settings.notifications?.telegram || {};
  if ((tg.enabled || (tg.recipients || []).length) && !tg.botToken) out.push({ id: 'telegram.botToken', kind: 'telegram.botToken' });
  if (settings.heartbeat?.enabled && !settings.heartbeat.url) out.push({ id: 'heartbeat.url', kind: 'heartbeat.url' });
  const wh = settings.notifications?.webhook || {};
  if (wh.enabled && !wh.url) out.push({ id: 'webhook.url', kind: 'webhook.url' });
  for (const i of settings.inputs || []) {
    if (onlyInputIds && !onlyInputIds.has(i.id)) continue;
    if (emptied.includes(`input:${i.id}`) && !hasUserInfo(i.streamUrl)) out.push({ id: `input:${i.id}`, kind: 'input', name: inputName(i) });
  }
  return out;
}

// raw: the text or the parsed object of the file. current: the plain settings now in use.
// mode: 'replace' (settings and inputs from the file) | 'add' (only inputs this PC does not have).
// Returns { ok, settings, missing, added, logos } or { ok:false, error }. logos: { logoId: PNG data URL } of the logos in the
// file that the inputs taken from it use (each one checked again: a bad one is left out).
export function prepareImport(raw, current, { mode = 'replace' } = {}) {
  let file = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_BACKUP_BYTES) return { ok: false, error: 'too-big' };
    try {
      file = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'invalid' };
    }
  }
  if (!isObj(file) || !isObj(file.settings)) return { ok: false, error: 'invalid' };
  if (file.app !== BACKUP_APP) return { ok: false, error: 'wrong-app' };

  const fromFile = structuredClone({ ...file.settings, inputs: Array.isArray(file.inputs) ? file.inputs : file.settings.inputs });
  const emptied = new Set(Array.isArray(file.emptiedSecrets) ? file.emptiedSecrets.filter((x) => typeof x === 'string') : []);
  // a sealed value cannot be opened on another PC or account: drop it
  for (const slot of secretSlots(fromFile)) {
    const v = slot.get();
    if (typeof v === 'string' && v.startsWith(SEALED_PREFIX)) {
      slot.set('');
      emptied.add(slot.id);
    }
  }
  for (const k of RUNTIME_KEYS) delete fromFile[k];
  const incoming = sanitizeSettings(fromFile);
  // a file of 0.2.1 keys its logos by input and has no `logo` in the inputs: the logo is named after the input
  if (isObj(file.logos)) for (const i of incoming.inputs) if (!i.logo && typeof file.logos[i.id] === 'string') i.logo = i.id;

  // a secret the file does not carry is kept from this PC, only for the same server and user
  const e = incoming.notifications.email;
  const ce = current.notifications.email;
  if (!e.pass && ce.pass && e.host && e.host.toLowerCase() === ce.host.toLowerCase() && e.user === ce.user) e.pass = ce.pass;
  if (!incoming.notifications.telegram.botToken) incoming.notifications.telegram.botToken = current.notifications.telegram.botToken;
  if (!incoming.heartbeat.url) incoming.heartbeat.url = current.heartbeat.url;
  if (!incoming.notifications.webhook.url) {
    incoming.notifications.webhook.url = current.notifications.webhook.url;
    if (!incoming.notifications.webhook.authHeader) incoming.notifications.webhook.authHeader = current.notifications.webhook.authHeader;
  }
  for (const i of incoming.inputs) {
    const c = current.inputs.find((x) => x.id === i.id);
    if (c && !hasUserInfo(i.streamUrl) && hasUserInfo(c.streamUrl) && withoutUserInfo(c.streamUrl) === i.streamUrl) i.streamUrl = c.streamUrl;
  }

  let result;
  let addedIds = null;
  let addedStationIds = null;
  if (mode === 'add') {
    const have = new Set(current.inputs.map((i) => i.id));
    const extra = incoming.inputs.filter((i) => !have.has(i.id)).slice(0, Math.max(0, MAX_INPUTS - current.inputs.length));
    // the stations the added streams belong to come with them (unless this PC already has a station with that id)
    const haveStations = new Set((current.stations || []).map((st) => st.id));
    const extraStations = (incoming.stations || []).filter((st) => !haveStations.has(st.id) && extra.some((i) => i.stationId === st.id));
    result = sanitizeSettings({ ...structuredClone(current), stations: [...structuredClone(current.stations || []), ...extraStations], inputs: [...structuredClone(current.inputs), ...extra] });
    addedIds = new Set(extra.map((i) => i.id).filter((id) => result.inputs.some((r) => r.id === id)));
    addedStationIds = new Set(extraStations.map((st) => st.id));
  } else {
    result = incoming;
    for (const k of RUNTIME_KEYS) result[k] = current[k];
  }
  const missing = mode === 'add' ? missingSecrets(result, [...emptied], { onlyInputIds: addedIds }) .filter((m) => m.kind === 'input') : missingSecrets(result, [...emptied]);
  const taken = new Set([...result.inputs.filter((i) => !addedIds || addedIds.has(i.id)), ...result.stations.filter((st) => !addedStationIds || addedStationIds.has(st.id))].map((x) => x.logo).filter(Boolean));
  const logos = {};
  if (isObj(file.logos)) {
    for (const [id, url] of Object.entries(file.logos)) {
      if (!taken.has(id)) continue;
      try {
        decodeLogo(url);
        logos[id] = url;
      } catch {
        /* a damaged or oversized picture is left out, the rest of the file is still imported */
      }
    }
  }
  return { ok: true, settings: result, missing, added: addedIds ? addedIds.size : null, mode, logos };
}
