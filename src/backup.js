// Configuration backup: build the file, read it back, say what must be typed again.
// Electron-free and file-free (the main process asks for the file and applies the plan), so it can
// be tested. Settings here are the plain ones; sealed values (enc:v1:) never come out of a file.
import { sanitizeSettings, MAX_INPUTS } from './store.js';
import { SEALED_PREFIX, secretSlots, stripSecrets, withoutUserInfo, hasUserInfo } from './secrets.js';

export const BACKUP_APP = 'dead-air-watchdog';
export const BACKUP_VERSION = 1;
export const MAX_BACKUP_BYTES = 2_000_000;
// kept on this PC, not part of the file: what the user was told once
const RUNTIME_KEYS = ['micExplained', 'closeHintShown'];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const dateStamp = (ms) => new Date(ms).toISOString().slice(0, 10);

export const backupFileName = (now = Date.now()) => `${BACKUP_APP}-backup-${dateStamp(now)}.json`;

// settings: the plain settings of the app. Returns the object to write as JSON.
export function buildExport(settings, { includeSecrets = false, now = Date.now() } = {}) {
  let s = structuredClone(settings);
  let emptied = [];
  if (!includeSecrets) ({ settings: s, emptied } = stripSecrets(s));
  for (const k of RUNTIME_KEYS) delete s[k];
  const inputs = Array.isArray(s.inputs) ? s.inputs : [];
  delete s.inputs;
  const file = { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: new Date(now).toISOString(), includesSecrets: !!includeSecrets, settings: s, inputs };
  if (emptied.length) file.emptiedSecrets = emptied; // which secrets had a value and were left out
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
  for (const i of settings.inputs || []) {
    if (onlyInputIds && !onlyInputIds.has(i.id)) continue;
    if (emptied.includes(`input:${i.id}`) && !hasUserInfo(i.streamUrl)) out.push({ id: `input:${i.id}`, kind: 'input', name: inputName(i) });
  }
  return out;
}

// raw: the text or the parsed object of the file. current: the plain settings now in use.
// mode: 'replace' (settings and inputs from the file) | 'add' (only inputs this PC does not have).
// Returns { ok, settings, missing, added } or { ok:false, error }.
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

  // a secret the file does not carry is kept from this PC, only for the same server and user
  const e = incoming.notifications.email;
  const ce = current.notifications.email;
  if (!e.pass && ce.pass && e.host && e.host.toLowerCase() === ce.host.toLowerCase() && e.user === ce.user) e.pass = ce.pass;
  if (!incoming.notifications.telegram.botToken) incoming.notifications.telegram.botToken = current.notifications.telegram.botToken;
  if (!incoming.heartbeat.url) incoming.heartbeat.url = current.heartbeat.url;
  for (const i of incoming.inputs) {
    const c = current.inputs.find((x) => x.id === i.id);
    if (c && !hasUserInfo(i.streamUrl) && hasUserInfo(c.streamUrl) && withoutUserInfo(c.streamUrl) === i.streamUrl) i.streamUrl = c.streamUrl;
  }

  let result;
  let addedIds = null;
  if (mode === 'add') {
    const have = new Set(current.inputs.map((i) => i.id));
    const extra = incoming.inputs.filter((i) => !have.has(i.id)).slice(0, Math.max(0, MAX_INPUTS - current.inputs.length));
    result = sanitizeSettings({ ...structuredClone(current), inputs: [...structuredClone(current.inputs), ...extra] });
    addedIds = new Set(extra.map((i) => i.id).filter((id) => result.inputs.some((r) => r.id === id)));
  } else {
    result = incoming;
    for (const k of RUNTIME_KEYS) result[k] = current[k];
  }
  const missing = mode === 'add' ? missingSecrets(result, [...emptied], { onlyInputIds: addedIds }) .filter((m) => m.kind === 'input') : missingSecrets(result, [...emptied]);
  return { ok: true, settings: result, missing, added: addedIds ? addedIds.size : null, mode };
}
