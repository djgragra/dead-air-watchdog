import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createLogos, decodeLogo, MAX_SIDE } from '../src/logos.js';

// minimal valid PNG of w x h pixels (grey, 8 bit)
function png(w, h) {
  const crc = (buf) => {
    let c, crcv = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
      c = (crcv ^ buf[n]) & 0xff;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcv = (crcv >>> 8) ^ c;
    }
    return (crcv ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w, 128)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const url = (buf) => `data:image/png;base64,${buf.toString('base64')}`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'daw-logo-'));

test('a valid PNG is stored, listed, replaced and removed', () => {
  const logos = createLogos(tmp());
  logos.set('a1', url(png(64, 32)));
  logos.set('b-2', url(png(10, 10)));
  assert.deepEqual(Object.keys(logos.all()).sort(), ['a1', 'b-2']);
  logos.set('a1', url(png(20, 20)));
  assert.equal(decodeLogo(logos.all().a1).readUInt32BE(16), 20);
  logos.remove('a1');
  assert.deepEqual(Object.keys(logos.all()), ['b-2']);
});

test('anything that is not a small PNG data URL is refused', () => {
  const logos = createLogos(tmp());
  const bad = [
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'data:image/png;base64,' + Buffer.from('not a png at all, just text padded.......').toString('base64'),
    'https://example.org/x.png',
    '',
    null,
    url(png(MAX_SIDE + 1, 10)),
    url(Buffer.concat([png(10, 10), Buffer.alloc(500_000)]))
  ];
  for (const b of bad) assert.throws(() => logos.set('x', b), /bad-logo/, String(b).slice(0, 40));
  assert.deepEqual(logos.all(), {});
});

test('ids cannot escape the folder', () => {
  const dir = tmp();
  const logos = createLogos(dir);
  for (const id of ['../evil', 'a/b', '', 'a.b']) assert.throws(() => logos.set(id, url(png(4, 4))), /bad-id/);
  assert.deepEqual(fs.readdirSync(path.dirname(dir)).filter((f) => f === 'evil.png'), []);
});

test('prune removes logos of deleted inputs; damaged files are ignored', () => {
  const dir = tmp();
  const logos = createLogos(dir);
  logos.set('keep', url(png(4, 4)));
  logos.set('gone', url(png(4, 4)));
  fs.writeFileSync(path.join(dir, 'broken.png'), 'garbage');
  assert.deepEqual(Object.keys(logos.all()), ['gone', 'keep']);
  logos.prune(['keep']);
  assert.deepEqual(fs.readdirSync(dir), ['keep.png']);
});
