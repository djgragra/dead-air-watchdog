// SNMP input helpers that need no network and no library (the window uses them too): the address, the OID, the normal values.
export const DEFAULT_PORT = 161;
export const DEFAULT_TRAP_PORT = 1162; // ports below 1024 need extra rights on Linux and macOS

// The address of an SNMP input is kept as snmp://community@host:port so that the community is handled like the
// credentials of a stream address (sealed with the OS keystore, left out of a backup, "type it again" after an import).
export function parseSnmpAddress(url) {
  const m = /^snmp:\/\/(?:([^@/]*)@)?([^:/?#@]+|\[[0-9a-f:.]+\])(?::(\d{1,5}))?\/?$/i.exec(String(url || '').trim());
  if (!m) return null;
  let community = '';
  try {
    community = decodeURIComponent(m[1] || '');
  } catch {
    return null;
  }
  const port = m[3] ? Number(m[3]) : DEFAULT_PORT;
  if (!(port >= 1 && port <= 65535)) return null;
  return { community, host: m[2].replace(/^\[|\]$/g, ''), port };
}

export function buildSnmpAddress({ host, port, community }) {
  const h = String(host || '').trim();
  if (!h) return '';
  const p = Number(port) > 0 && Number(port) !== DEFAULT_PORT ? `:${Math.min(65535, Math.round(Number(port)))}` : '';
  const c = community ? `${encodeURIComponent(community)}@` : '';
  return `snmp://${c}${h.includes(':') ? `[${h}]` : h}${p}`;
}

export const isValidOid = (oid) => /^\.?\d+(\.\d+){2,}$/.test(String(oid || '').trim());
export const cleanOid = (oid) => String(oid || '').trim().replace(/^\./, '');

// "1" or "1, 4" -> [1, 4]; empty or not numbers -> null
export function parseNormal(text) {
  const parts = String(text ?? '').split(/[\s,;]+/).filter(Boolean);
  if (!parts.length || parts.length > 16) return null;
  const nums = parts.map((p) => (/^-?\d+$/.test(p) ? Number(p) : NaN));
  return nums.every(Number.isFinite) ? nums : null;
}
