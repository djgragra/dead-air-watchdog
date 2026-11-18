import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createLogos, decodeLogo, MAX_SIDE } from '../src/logos.js';
import { keepIds, adoptLegacy, mergeDuplicates } from '../src/logo-refs.js';

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

// ---- the library (0.2.2): one logo, several inputs
test('add gives a new id to a new picture and the same id to the same picture again (one logo for the eight streams of a station)', () => {
  const logos = createLogos(tmp());
  const a = logos.add(url(png(64, 64)));
  const b = logos.add(url(png(32, 32)));
  assert.match(a, /^lg[0-9a-f]{12}$/);
  assert.notEqual(a, b);
  for (let i = 0; i < 8; i++) assert.equal(logos.add(url(png(64, 64))), a, 'the same picture is not stored again');
  assert.deepEqual(logos.ids().sort(), [a, b].sort());
  assert.throws(() => logos.add('data:image/png;base64,AAAA'), /bad-logo/);
  assert.equal(logos.ids().length, 2, 'a bad picture is not stored');
});

test('ids lists the stored logos without reading the pictures; an empty or missing folder gives none', () => {
  const dir = tmp();
  assert.deepEqual(createLogos(path.join(dir, 'nowhere')).ids(), []);
  const logos = createLogos(dir);
  logos.set('x1', url(png(8, 8)));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(dir, '..bad.png'), 'x');
  assert.deepEqual(logos.ids(), ['x1']);
});

test('keepIds: the logos the inputs point to, each once; an input without logo keeps nothing', () => {
  assert.deepEqual(keepIds([{ id: 'a', logo: 'lg1' }, { id: 'b', logo: 'lg1' }, { id: 'c', logo: 'lg2' }, { id: 'd', logo: '' }]), ['lg1', 'lg2']);
  assert.deepEqual(keepIds([]), []);
});

test('prune with keepIds removes the logo nobody uses, keeps the shared one', () => {
  const logos = createLogos(tmp());
  const shared = logos.add(url(png(64, 64)));
  const gone = logos.add(url(png(20, 20)));
  logos.prune(keepIds([{ id: 'a', logo: shared }, { id: 'b', logo: shared }]));
  assert.deepEqual(logos.ids(), [shared]);
  assert.ok(gone);
});

test('adoptLegacy: a file named after its input (0.2.1 and earlier, or copied by hand) is given to that input once', () => {
  const inputs = [{ id: 'a', logo: '' }, { id: 'b', logo: 'lg9' }, { id: 'c', logo: '' }];
  const out = adoptLegacy(inputs, ['a', 'lg9', 'zzz']);
  assert.deepEqual(out.map((i) => i.logo), ['a', 'lg9', '']);
  assert.equal(adoptLegacy(out, ['a', 'lg9', 'zzz']), null, 'nothing left to adopt: no change');
  assert.equal(adoptLegacy([{ id: 'c', logo: '' }], []), null);
});

test('a logo removed from an input stays removed: it is not adopted again once the file is gone', () => {
  const logos = createLogos(tmp());
  logos.set('a', url(png(16, 16)));
  let inputs = adoptLegacy([{ id: 'a', logo: '' }], logos.ids());
  assert.equal(inputs[0].logo, 'a');
  inputs = [{ ...inputs[0], logo: '' }]; // the person removes the logo
  logos.prune(keepIds(inputs)); // the settings were saved
  assert.deepEqual(logos.ids(), [], 'the file is deleted with the removal');
  assert.equal(adoptLegacy(inputs, logos.ids()), null, 'so the next start does not bring it back');
});

// ---- the same picture stored many times (0.2.3): a file for each stream of a station, from before the library
test('hashes: the same picture under two ids has the same hash, a different one has another', () => {
  const logos = createLogos(tmp());
  logos.set('a', url(png(64, 64)));
  logos.set('b', url(png(64, 64)));
  logos.set('c', url(png(32, 32)));
  const h = logos.hashes();
  assert.equal(h.a, h.b);
  assert.notEqual(h.a, h.c);
  assert.match(h.a, /^[0-9a-f]{64}$/);
});

test('mergeDuplicates: twelve inputs with twelve files of four pictures end with four logos; the inputs keep their station logo', () => {
  const dir = tmp();
  const logos = createLogos(dir);
  const pics = { gr: url(png(64, 64)), news: url(png(48, 48)), rin: url(png(32, 32)), pod: url(png(16, 16)) };
  const plan = [['gr', 8], ['news', 2], ['rin', 1], ['pod', 1]];
  let inputs = [];
  for (const [pic, n] of plan) for (let k = 0; k < n; k++) {
    const id = `${pic}-${k}`;
    logos.set(id, pics[pic]); // the file named after the input, as before the library
    inputs.push({ id, logo: '' });
  }
  assert.equal(logos.ids().length, 12);
  inputs = adoptLegacy(inputs, logos.ids());
  const merged = mergeDuplicates(inputs, logos.hashes());
  assert.equal(merged.remove.length, 8, 'eight of the twelve are copies');
  logos.prune(keepIds(merged.inputs));
  assert.equal(logos.ids().length, 4);
  const byPic = (pic) => new Set(merged.inputs.filter((i) => i.id.startsWith(`${pic}-`)).map((i) => i.logo));
  assert.equal(byPic('gr').size, 1, 'the eight streams of one station share one logo');
  assert.equal(byPic('gr').values().next().value, 'gr-0', 'the one kept is the first the inputs use');
  assert.equal(byPic('news').size, 1);
  assert.equal(new Set(merged.inputs.map((i) => i.logo)).size, 4);
  assert.equal(mergeDuplicates(merged.inputs, logos.hashes()), null, 'nothing left to merge');
});

test('mergeDuplicates: an unused file that is a copy of a used logo is listed for deletion; a copy nobody uses and no original is kept as it is', () => {
  const m = mergeDuplicates([{ id: 'x', logo: 'u1' }], { u1: 'H', spare: 'H', other: 'Z' });
  assert.deepEqual(m.remove, ['spare']);
  assert.deepEqual(m.inputs, [{ id: 'x', logo: 'u1' }]);
  assert.equal(mergeDuplicates([{ id: 'x', logo: 'u1' }], { u1: 'H', other: 'Z' }), null);
});

test('remove deletes one logo and nothing else', () => {
  const logos = createLogos(tmp());
  logos.set('a', url(png(8, 8)));
  logos.set('b', url(png(9, 9)));
  logos.remove('a');
  assert.deepEqual(logos.ids(), ['b']);
});

test('stations: their logos are kept by the clean-up and follow the merge of equal pictures', () => {
  assert.deepEqual(keepIds([{ id: 'a', logo: 'lg1' }], [{ id: 's', logo: 'lg2' }, { id: 't', logo: '' }]), ['lg1', 'lg2']);
  const m = mergeDuplicates([{ id: 'a', logo: 'x1' }], { x1: 'H', x2: 'H' }, [{ id: 's', logo: 'x2' }]);
  assert.deepEqual(m.stations, [{ id: 's', logo: 'x1' }]);
  assert.deepEqual(m.remove, ['x2']);
});
