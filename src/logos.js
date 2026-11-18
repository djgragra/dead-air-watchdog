// Logos: small PNG files kept next to the settings, one per logo id (a library), not inside the settings file (that
// one is rewritten often). An input points to its logo with `logo` (several inputs of the same station can share one).
// Until 0.2.1 the file was named after the input (`<input id>.png`): such a file is still a logo of the library, and
// `adoptLegacy` gives it to its input. The window shrinks the picture to MAX_SIDE pixels and
// sends it as a PNG data URL; everything is checked again here because the window is not trusted blindly.
// Electron-free: the folder is injected, so it can be tested.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MAX_SIDE = 512; // accepted size of the stored picture (the window sends at most 256)
export const MAX_BYTES = 400_000;
const ID_RE = /^[\w-]{1,64}$/;
const DATA_RE = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/;
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Returns the PNG bytes of a data URL, or throws 'bad-logo'.
export function decodeLogo(dataUrl) {
  const m = DATA_RE.exec(typeof dataUrl === 'string' ? dataUrl : '');
  if (!m) throw new Error('bad-logo');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 33 || buf.length > MAX_BYTES || !buf.subarray(0, 8).equals(SIGNATURE) || buf.toString('latin1', 12, 16) !== 'IHDR') throw new Error('bad-logo');
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (!w || !h || w > MAX_SIDE || h > MAX_SIDE) throw new Error('bad-logo');
  return buf;
}

export function createLogos(dir) {
  const fileOf = (id) => {
    if (!ID_RE.test(id || '')) throw new Error('bad-id');
    return path.join(dir, `${id}.png`);
  };
  return {
    // a new logo of the library: returns its id
    // The same picture added again gives the logo that is already there (no copy for each input of a station).
    add(dataUrl) {
      const bytes = decodeLogo(dataUrl);
      for (const id of this.ids()) {
        try {
          if (fs.readFileSync(fileOf(id)).equals(bytes)) return id;
        } catch {
          /* unreadable: not a match */
        }
      }
      const id = `lg${crypto.randomBytes(6).toString('hex')}`;
      this.set(id, dataUrl);
      return id;
    },
    // { id: sha256 of the picture } for every stored logo: two ids with the same hash are the same picture
    hashes() {
      const out = {};
      for (const id of this.ids()) {
        try {
          out[id] = crypto.createHash('sha256').update(fs.readFileSync(fileOf(id))).digest('hex');
        } catch {
          /* unreadable: left out */
        }
      }
      return out;
    },
    // the ids of the stored logos (no pictures read)
    ids() {
      try {
        return fs.readdirSync(dir).filter((n) => n.endsWith('.png') && ID_RE.test(n.replace(/\.png$/, ''))).map((n) => n.replace(/\.png$/, ''));
      } catch {
        return [];
      }
    },
    set(id, dataUrl) {
      const bytes = decodeLogo(dataUrl);
      const file = fileOf(id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, bytes);
      fs.renameSync(`${file}.tmp`, file);
    },
    remove(id) {
      fs.rmSync(fileOf(id), { force: true });
    },
    // { [id]: dataUrl } of every stored logo
    all() {
      const out = {};
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return out;
      }
      for (const n of names) {
        const id = n.replace(/\.png$/, '');
        if (!n.endsWith('.png') || !ID_RE.test(id)) continue;
        try {
          const buf = fs.readFileSync(path.join(dir, n));
          const url = `data:image/png;base64,${buf.toString('base64')}`;
          decodeLogo(url); // a damaged or replaced file is ignored
          out[id] = url;
        } catch {
          /* ignore */
        }
      }
      return out;
    },
    // deletes the logos of inputs that no longer exist
    prune(keepIds) {
      const keep = new Set(keepIds);
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const n of names) if (n.endsWith('.png') && !keep.has(n.replace(/\.png$/, ''))) fs.rmSync(path.join(dir, n), { force: true });
    }
  };
}
