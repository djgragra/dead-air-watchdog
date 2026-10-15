// garage-common: secrets 1
// The one list of every place that holds a secret. Sealing at rest, opening, the backup and the
// "type it again" list all use it, so a new secret cannot be forgotten in one of them.
// Settings here are the plain ones (as the app uses them), never the sealed ones on disk.

export const SEALED_PREFIX = 'enc:v1:';

// Fixed slots: id, path inside the settings. Input stream URLs are slots too (one per input).
export const SECRET_PATHS = [
  { id: 'email.pass', path: ['notifications', 'email', 'pass'] },
  { id: 'telegram.botToken', path: ['notifications', 'telegram', 'botToken'] },
  { id: 'heartbeat.url', path: ['heartbeat', 'url'] } // ping URLs usually carry a secret token
];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// "user:password@" in a stream URL is a secret; the rest of the address is not.
export function splitUserInfo(url) {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*@)?(.*)$/i.exec(String(url || ''));
  return m ? { head: m[1], userInfo: m[2] ? m[2].slice(0, -1) : '', rest: m[3] } : { head: '', userInfo: '', rest: String(url || '') };
}
export const withoutUserInfo = (url) => {
  const p = splitUserInfo(url);
  return p.head + p.rest;
};
export const hasUserInfo = (url) => !!splitUserInfo(url).userInfo;

const getAt = (obj, path) => path.reduce((o, k) => (isObj(o) ? o[k] : undefined), obj);
function setAt(obj, path, value) {
  let o = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (!isObj(o[path[i]])) return;
    o = o[path[i]];
  }
  o[path.at(-1)] = value;
}

// Every slot that currently exists: { id, kind, get(), set(v) } on the given settings object.
export function secretSlots(settings) {
  const slots = SECRET_PATHS.map(({ id, path }) => ({ id, kind: id, get: () => getAt(settings, path), set: (v) => setAt(settings, path, v) }));
  (Array.isArray(settings?.inputs) ? settings.inputs : []).forEach((inp) => {
    if (isObj(inp)) slots.push({ id: `input:${inp.id}`, kind: 'input', input: inp, get: () => inp.streamUrl, set: (v) => (inp.streamUrl = v) });
  });
  if (isObj(settings?.input)) slots.push({ id: 'input:legacy', kind: 'input', input: settings.input, get: () => settings.input.streamUrl, set: (v) => (settings.input.streamUrl = v) }); // old single-input files
  return slots;
}

// Copy of the settings with fn applied to every non-empty secret (seal / open).
// For a stream address the whole text is the secret (it may hold credentials).
export function mapSecrets(settings, fn) {
  const s = structuredClone(settings);
  for (const slot of secretSlots(s)) {
    const v = slot.get();
    if (typeof v === 'string' && v) slot.set(fn(v));
  }
  return s;
}

// A stream address counts as secret only when it carries credentials; the other secrets always.
export const isSecretValue = (slot, value) => typeof value === 'string' && !!value && (slot.kind !== 'input' || hasUserInfo(value));

// Copy without any secret, plus the ids of the slots that had one ("to type again").
export function stripSecrets(settings) {
  const s = structuredClone(settings);
  const emptied = [];
  for (const slot of secretSlots(s)) {
    const v = slot.get();
    if (!isSecretValue(slot, v)) continue;
    emptied.push(slot.id);
    slot.set(slot.kind === 'input' ? withoutUserInfo(v) : '');
  }
  return { settings: s, emptied };
}
