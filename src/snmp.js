// SNMP inputs: the state of a device (for example a DEVA DB8000 audio switch or an Orban processor) read over the network.
// DAW is the *manager*: it asks the device for one value (an OID) every few seconds (polling) and, when the trap listener is on,
// also takes the traps the device sends (a trap makes the next poll happen at once). It never writes to a device.
// The monitor turns the value into a state: the value is "normal" or it is not; no answer is "offline".
// Only SNMP v1/v2c (a community, sent in clear on the network: use it on a LAN or a VPN, never over the open internet).
import dgram from 'node:dgram';
import netSnmp from 'net-snmp';
import { DEFAULT_PORT, DEFAULT_TRAP_PORT, parseSnmpAddress, buildSnmpAddress, isValidOid, cleanOid, parseNormal, parseLabels, formatLabels, valueText } from './core/snmp-address.js';

export { DEFAULT_PORT, DEFAULT_TRAP_PORT, parseSnmpAddress, buildSnmpAddress, isValidOid, cleanOid, parseNormal, parseLabels, formatLabels, valueText };

const TIMEOUT_MS = 3000;

// Some devices (the DEVA DB8000 among them) answer an SNMP v2c request with an EMPTY community string in the reply. The library
// refuses such a reply ("Community 'x' in request does not match community '' in response"), and the input would be offline
// for ever. The empty community of a reply is put back to the one of the request before the library sees it. Only an empty one
// is changed (a reply with another community is still refused), and only the reply of a request we sent ourselves.
const berLen = (n) => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]));
export function fixEmptyCommunity(buf, community) {
  try {
    if (!community || buf.length < 8 || buf[0] !== 0x30) return buf;
    let p = 1;
    let len = buf[p++];
    if (len & 0x80) {
      const n = len & 0x7f;
      if (n < 1 || n > 2) return buf;
      len = 0;
      for (let i = 0; i < n; i++) len = (len << 8) | buf[p++];
    }
    if (p + len !== buf.length) return buf;
    if (buf[p] !== 0x02 || buf[p + 1] !== 0x01) return buf; // version
    const ver = buf.subarray(p, p + 3);
    p += 3;
    if (buf[p] !== 0x04 || buf[p + 1] !== 0x00) return buf; // community present and not empty: nothing to do
    const rest = buf.subarray(p + 2);
    const c = Buffer.from(community, 'utf8');
    const body = Buffer.concat([ver, Buffer.from([0x04]), berLen(c.length), c, rest]);
    return Buffer.concat([Buffer.from([0x30]), berLen(body.length), body]);
  } catch {
    return buf;
  }
}

// A dgram module for the library: the same sockets, with the replies passed through fixEmptyCommunity.
const quirkDgram = (community) => ({
  createSocket(type) {
    const sock = dgram.createSocket(type);
    const on = sock.on.bind(sock);
    sock.on = (ev, fn) => (ev === 'message' ? on(ev, (b, r) => fn(fixEmptyCommunity(b, community), r)) : on(ev, fn));
    return sock;
  }
});

// The value of a varbind as a number (INTEGER, Gauge, Counter ...) or null (text, NULL, error).
export function numericValue(vb) {
  if (!vb || netSnmp.isVarbindError(vb)) return null;
  if (typeof vb.value === 'number') return vb.value;
  if (typeof vb.value === 'bigint') return Number(vb.value);
  if (Buffer.isBuffer(vb.value)) {
    const s = vb.value.toString('utf8').trim();
    return /^-?\d+$/.test(s) ? Number(s) : null;
  }
  return null;
}

const sameOid = (a, b) => {
  const x = cleanOid(a);
  const y = cleanOid(b);
  return x === y || `${x}.0` === y || x === `${y}.0`; // a scalar is asked as ...0, the MIB names it without
};

// list: [{ id, address, oid, pollSec }]. Result of each poll goes to onResult(id, { value } | { error }).
// onTrap(id, value|null) is told that a trap from that device arrived (value: the varbind of the watched OID, if it carried one).
export function createSnmpWatcher({ lib = netSnmp, onResult, onTrap = () => {}, log = () => {}, setIntervalFn = setInterval, clearIntervalFn = clearInterval, now = Date.now } = {}) {
  const probes = new Map(); // id -> { key, cfg, session, timer, busy }
  let receiver = null;
  let receiverKey = '';
  let trapState = { state: 'off' }; // off | listening | error (with code)
  let trapWanted = { enabled: false, port: DEFAULT_TRAP_PORT };
  let current = [];

  function open(cfg) {
    const a = parseSnmpAddress(cfg.address);
    if (!a || !isValidOid(cfg.oid)) return null;
    // v2c, no retries: the poll interval is the retry
    const session = lib.createSession(a.host, a.community, { port: a.port, version: lib.Version2c, timeout: TIMEOUT_MS, retries: 0, transport: a.host.includes(':') ? 'udp6' : 'udp4', dgramModule: quirkDgram(a.community) });
    session.on('error', (err) => log(`SNMP ${a.host}: ${err.message}`, 'warn'));
    return { a, session };
  }

  function poll(id) {
    const p = probes.get(id);
    if (!p || p.busy) return;
    p.busy = true;
    p.session.get([cleanOid(p.cfg.oid)], (err, varbinds) => {
      p.busy = false;
      if (probes.get(id) !== p) return; // removed or changed while waiting
      if (err) return onResult(id, { error: /time(d)?\s?out/i.test(err.message) ? 'timeout' : String(err.message || err).slice(0, 120) });
      const vb = varbinds?.[0];
      if (!vb || lib.isVarbindError(vb)) return onResult(id, { error: 'no-such-object' });
      const value = numericValue(vb);
      if (value === null) return onResult(id, { error: 'not-a-number' });
      onResult(id, { value, at: now() });
    });
  }

  function sync(list) {
    current = list;
    const want = new Map(list.map((c) => [c.id, c]));
    for (const [id, p] of [...probes]) {
      const cfg = want.get(id);
      if (!cfg || JSON.stringify([cfg.address, cfg.oid, cfg.pollSec]) !== p.key) {
        clearIntervalFn(p.timer);
        try { p.session.close(); } catch { /* already closed */ }
        probes.delete(id);
      }
    }
    for (const cfg of list) {
      if (probes.has(cfg.id)) continue;
      const o = open(cfg);
      if (!o) continue;
      const p = { key: JSON.stringify([cfg.address, cfg.oid, cfg.pollSec]), cfg, session: o.session, a: o.a, timer: null, busy: false };
      probes.set(cfg.id, p);
      p.timer = setIntervalFn(() => poll(cfg.id), Math.max(1, cfg.pollSec || 5) * 1000);
      p.timer?.unref?.();
      poll(cfg.id);
    }
    applyTraps();
  }

  // ---- traps -----------------------------------------------------------------------------------
  function closeReceiver() {
    if (receiver) {
      try { receiver.close(); } catch { /* already closed */ }
      receiver = null;
    }
    receiverKey = '';
  }

  function applyTraps() {
    const communities = [...new Set([...probes.values()].map((p) => p.a.community))];
    const key = trapWanted.enabled && probes.size ? JSON.stringify([trapWanted.port, communities]) : '';
    if (key === receiverKey) return;
    closeReceiver();
    if (!key) {
      trapState = { state: 'off' };
      return;
    }
    try {
      receiver = lib.createReceiver({ port: trapWanted.port, transport: 'udp4', disableAuthorization: true, includeAuthentication: true }, (err, n) => {
        if (err) {
          // the receiver hands over errors of its socket (port in use, no rights for the port) in the same callback
          if (trapState.state !== 'error') {
            trapState = { state: 'error', code: err.code || 'error', message: err.message };
            log(`SNMP trap listener (port ${trapWanted.port}): ${err.message}`, 'error');
          }
          return;
        }
        if (!n) return;
        const from = n.rinfo?.address;
        for (const p of probes.values()) {
          if (p.a.host !== from) continue; // a trap counts only from the device we watch (by its address)
          // and with its community, or with none: some devices (the DEVA DB8000) leave it empty (the library refuses an empty one itself, so it checks nothing here)
          const comm = n.pdu?.community ?? '';
          if (comm !== '' && comm !== p.a.community) continue;
          const vb = (n.pdu?.varbinds || []).find((v) => sameOid(v.oid, p.cfg.oid));
          const value = vb ? numericValue(vb) : null;
          log(`SNMP trap from ${from}${value !== null ? `: value ${value}` : ''}`, 'info');
          onTrap(p.cfg.id, value);
          poll(p.cfg.id); // the poll is the truth: asked at once
        }
      });
      receiverKey = key;
      trapState = { state: 'listening', port: trapWanted.port };
    } catch (e) {
      trapState = { state: 'error', code: e.code || 'error', message: e.message };
      receiverKey = key; // do not retry at every sync: a change of the settings does
      log(`SNMP trap listener (port ${trapWanted.port}): ${e.message}`, 'error');
    }
  }

  return {
    sync,
    // settings.snmp: { traps: boolean, trapPort }
    setTraps({ enabled, port }) {
      trapWanted = { enabled: !!enabled, port: Number(port) || DEFAULT_TRAP_PORT };
      applyTraps();
    },
    pollNow: (id) => poll(id),
    trapState: () => ({ ...trapState }),
    stop() {
      for (const p of probes.values()) {
        clearIntervalFn(p.timer);
        try { p.session.close(); } catch { /* already closed */ }
      }
      probes.clear();
      closeReceiver();
      trapState = { state: 'off' };
      current = [];
    },
    size: () => current.length
  };
}
