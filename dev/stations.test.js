import test from 'node:test';
import assert from 'node:assert/strict';
import { PALETTE, assignColors, aggregate, featuredOf, groupInputs, isOpen, logoIdFor, viewItems } from '../src/core/stations.js';
import { inputLabel, inputOwnLabel } from '../src/messages.js';
import { sanitizeSettings } from '../src/store.js';
import { buildExport, prepareImport } from '../src/backup.js';

const ST = [{ id: 'gr', name: 'Giornale Radio', logo: 'lgGR', featured: 'g2' }, { id: 'news', name: 'GRNews', logo: '', featured: '' }];
const stream = (id, extra = {}) => ({ id, type: 'stream', name: '', streamUrl: `http://srv.example.org/${id}`, stationId: '', logo: '', ...extra });
const INPUTS = [stream('g1', { stationId: 'gr', name: 'Rete 1' }), stream('n1', { stationId: 'news' }), stream('g2', { stationId: 'gr', logo: 'lgOwn' }), stream('solo'), stream('n2', { stationId: 'news' })];
const states = (m) => (id) => m[id] || 'ok';

test('groupInputs: the streams of a station in the order of the inputs, the free inputs apart, a station without streams left out', () => {
  const { groups, loose } = groupInputs([...ST, { id: 'empty', name: 'Empty' }], INPUTS);
  assert.deepEqual(groups.map((g) => [g.station.id, g.members.map((m) => m.id)]), [['gr', ['g1', 'g2']], ['news', ['n1', 'n2']]]);
  assert.deepEqual(loose.map((i) => i.id), ['solo']);
});

test('aggregate: the station shows the worst state of its streams and counts them', () => {
  const m = INPUTS.filter((i) => i.stationId === 'gr');
  assert.deepEqual(aggregate(m, states({})), { state: 'ok', counts: { total: 2, alarm: 0, counting: 0, starting: 0, ok: 2, other: 0 } });
  assert.equal(aggregate(m, states({ g2: 'counting' })).state, 'counting', 'yellow: a stream counts a silence, the alarm has not started');
  assert.equal(aggregate(m, states({ g1: 'counting', g2: 'alarm' })).state, 'alarm');
  assert.equal(aggregate(m, states({ g1: 'starting' })).state, 'starting');
  assert.equal(aggregate(m, states({ g1: 'paused', g2: 'paused' })).state, 'paused', 'all paused: paused');
  assert.equal(aggregate(m, states({ g1: 'paused', g2: 'ok' })).state, 'ok', 'one working stream: ok');
  assert.equal(aggregate(m, states({ g1: 'idle', g2: 'idle' })).state, 'idle');
  const a = aggregate(m, states({ g1: 'counting', g2: 'alarm' }));
  assert.equal(a.counts.counting, 1);
  assert.equal(a.counts.alarm, 1);
});

test('isOpen: a station is open when the person opened it and always while one of its streams is in dead air', () => {
  const ok = aggregate([INPUTS[0]], states({}));
  const fallen = aggregate([INPUTS[0]], states({ g1: 'alarm' }));
  const yellow = aggregate([INPUTS[0]], states({ g1: 'counting' }));
  assert.equal(isOpen(ST[0], ok, {}), false);
  assert.equal(isOpen(ST[0], ok, { gr: true }), true);
  assert.equal(isOpen(ST[0], fallen, {}), true, 'dead air opens it by itself');
  assert.equal(isOpen(ST[0], yellow, {}), false, 'yellow is shown on the closed station, it does not open it');
  assert.equal(isOpen(ST[0], fallen, { gr: false }), true, 'the person cannot close a station that is in dead air');
});

test('viewItems: a station where its first stream is, free inputs where they are; a closed station and an open one', () => {
  const items = viewItems(ST, INPUTS, states({ n2: 'alarm' }), {});
  assert.deepEqual(items.map((i) => (i.kind === 'station' ? `S:${i.station.id}` : `I:${i.input.id}`)), ['S:gr', 'S:news', 'I:solo']);
  assert.equal(items[0].open, false);
  assert.equal(items[1].open, true, 'the news station has a stream in dead air');
  assert.equal(items[1].agg.state, 'alarm');
  assert.deepEqual(items[1].members.map((m) => m.id), ['n1', 'n2']);
  assert.equal(viewItems([], INPUTS, states({}), {}).every((i) => i.kind === 'input'), true, 'no stations: the view of the inputs, as before');
});

test('featured: the one chosen if it is a stream of the station, else the first', () => {
  const m = INPUTS.filter((i) => i.stationId === 'gr');
  assert.equal(featuredOf(ST[0], m), 'g2');
  assert.equal(featuredOf({ ...ST[0], featured: 'zzz' }, m), 'g1');
  assert.equal(featuredOf(ST[1], INPUTS.filter((i) => i.stationId === 'news')), 'n1');
  assert.equal(featuredOf(ST[0], []), '');
});

test('logo of a stream: its own, else the station\'s', () => {
  assert.equal(logoIdFor(INPUTS[2], ST[0]), 'lgOwn');
  assert.equal(logoIdFor(INPUTS[0], ST[0]), 'lgGR');
  assert.equal(logoIdFor(INPUTS[4], ST[1]), '');
  assert.equal(logoIdFor(INPUTS[3], undefined), '');
});

test('names in alerts: the name of the stream; a stream without one is called after its station and address; free input as before', () => {
  assert.equal(inputLabel('en', INPUTS[0], ST), 'Giornale Radio · Rete 1');
  assert.equal(inputLabel('en', INPUTS[1], ST), 'GRNews · srv.example.org');
  assert.equal(inputLabel('en', INPUTS[3], ST), inputLabel('en', INPUTS[3]), 'no station: as before');
  assert.equal(inputLabel('en', { ...INPUTS[1], stationId: 'gone' }, ST), inputLabel('en', INPUTS[3]).replace('solo', 'n1'), 'a station that does not exist: as before');
});

test('alerts say "Station · Stream"; the name is not repeated when it already has the station in it', () => {
  assert.equal(inputLabel('en', { ...INPUTS[0], name: 'Giornale Radio Rete 1' }, ST), 'Giornale Radio Rete 1');
  assert.equal(inputLabel('en', { ...INPUTS[0], name: '' , type: 'device', deviceLabel: 'Card 2' }, ST), 'Giornale Radio · Card 2');
  assert.equal(inputOwnLabel('en', INPUTS[0]), 'Rete 1', 'the tile shows the station beside the name: the own name');
});

test('settings: stations are cleaned, a stream of a missing station is free, the featured stream must be one of its streams', () => {
  const s = sanitizeSettings({
    stations: [{ id: 'a', name: '  Radio A ', logo: 'lg1', featured: 'x2' }, { id: 'a', name: 'same id' }, { id: '../bad', name: 'B', featured: 'x1' }, 'junk'],
    inputs: [
      { id: 'x1', type: 'stream', stationId: 'a' },
      { id: 'x2', type: 'stream', stationId: 'a' },
      { id: 'x3', type: 'stream', stationId: 'missing' }
    ],
    display: { view: 'stations' }
  });
  assert.equal(s.stations.length, 4);
  assert.equal(s.stations[0].name, 'Radio A');
  assert.equal(s.stations[0].featured, 'x2');
  assert.notEqual(s.stations[1].id, 'a', 'a repeated id is replaced');
  assert.match(s.stations[2].id, /^[0-9a-f-]{36}$/, 'an id that is not valid is replaced');
  assert.deepEqual(s.inputs.map((i) => i.stationId), ['a', 'a', '']);
  assert.equal(s.display.view, 'stations');
  assert.equal(sanitizeSettings({ display: { view: 'nope' } }).display.view, 'inputs');
  const noFeat = sanitizeSettings({ stations: [{ id: 'a', name: 'A', featured: 'x3' }], inputs: [{ id: 'x3', type: 'stream' }] });
  assert.equal(noFeat.stations[0].featured, '', 'x3 is not a stream of the station');
  assert.deepEqual(sanitizeSettings({}).stations, []);
});

// ---- the backup carries the stations, with their logos
const png = (w, h) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return `data:image/png;base64,${b.toString('base64')}`;
};
const withStations = () => sanitizeSettings({
  stations: [{ id: 'gr', name: 'Giornale Radio', logo: 'lgGR', featured: 'g2' }, { id: 'news', name: 'GRNews', logo: 'lgNews' }],
  inputs: [
    { id: 'g1', type: 'stream', name: 'Rete 1', streamUrl: 'http://s.example.org/1', stationId: 'gr' },
    { id: 'g2', type: 'stream', name: 'Rete 2', streamUrl: 'http://s.example.org/2', stationId: 'gr', logo: 'lgOwn' },
    { id: 'n1', type: 'stream', streamUrl: 'http://s.example.org/n', stationId: 'news' }
  ]
});

test('backup: stations travel with the inputs, and their logos once each', () => {
  const f = buildExport(withStations(), { logos: { lgGR: png(64, 64), lgNews: png(32, 32), lgOwn: png(16, 16), lgUnused: png(8, 8) } });
  assert.equal(f.settings.stations.length, 2);
  assert.deepEqual(Object.keys(f.logos).sort(), ['lgGR', 'lgNews', 'lgOwn']);
  const plan = prepareImport(JSON.parse(JSON.stringify(f)), sanitizeSettings({}));
  assert.deepEqual(plan.settings.stations.map((st) => st.name), ['Giornale Radio', 'GRNews']);
  assert.deepEqual(plan.settings.inputs.map((i) => i.stationId), ['gr', 'gr', 'news']);
  assert.deepEqual(Object.keys(plan.logos).sort(), ['lgGR', 'lgNews', 'lgOwn']);
  assert.equal(plan.settings.stations[0].featured, 'g2');
});

test('backup: adding inputs brings the stations of the added streams (and their logos), not the stations this PC has', () => {
  const f = buildExport(withStations(), { logos: { lgGR: png(64, 64), lgNews: png(32, 32), lgOwn: png(16, 16) } });
  const cur = sanitizeSettings({ stations: [{ id: 'gr', name: 'Mine' }], inputs: [{ id: 'g1', type: 'stream', name: 'Mine 1', streamUrl: 'http://x.example.org/', stationId: 'gr' }] });
  const plan = prepareImport(JSON.parse(JSON.stringify(f)), cur, { mode: 'add' });
  assert.equal(plan.added, 2);
  assert.deepEqual(plan.settings.stations.map((st) => st.id).sort(), ['gr', 'news']);
  assert.equal(plan.settings.stations.find((st) => st.id === 'gr').name, 'Mine', 'the station this PC has stays as it is');
  assert.deepEqual(plan.settings.inputs.map((i) => [i.id, i.stationId]), [['g1', 'gr'], ['g2', 'gr'], ['n1', 'news']]);
  assert.deepEqual(Object.keys(plan.logos).sort(), ['lgNews', 'lgOwn'], 'the logo of the station that was added and of the added stream; the existing station keeps its own');
});

test('backup: a file without stations (the public version) gives none', () => {
  const plan = prepareImport(buildExport(sanitizeSettings({ inputs: [{ id: 'a', type: 'stream', streamUrl: 'http://x.example.org/' }] })), sanitizeSettings({}));
  assert.deepEqual(plan.settings.stations, []);
});

test('viewItems: many stations in dead air: the first ones open by themselves, the others stay closed and are counted; the ones opened by hand stay open', () => {
  const sts = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, name: id.toUpperCase() }));
  const ins = sts.flatMap((s) => [stream(`${s.id}1`, { stationId: s.id }), stream(`${s.id}2`, { stationId: s.id })]);
  const allDown = states(Object.fromEntries(ins.map((i) => [i.id, 'alarm'])));
  const items = viewItems(sts, ins, allDown, {}, 4);
  assert.deepEqual(items.map((i) => i.open), [true, true, true, true, false, false]);
  assert.deepEqual(items.map((i) => !!i.capped), [false, false, false, false, true, true]);
  const byHand = viewItems(sts, ins, allDown, { f: true }, 4);
  assert.equal(byHand[5].open, true, 'opened by hand: open, and does not count for the cap');
  assert.equal(byHand.filter((i) => i.capped).length, 1, 'only e is kept closed');
  assert.equal(viewItems(sts.slice(0, 2), ins.slice(0, 4), allDown, {}).some((i) => i.capped), false, 'few stations: no cap');
});

test('settings: the "explanation seen" flag is a boolean and a backup does not carry it', () => {
  assert.equal(sanitizeSettings({}).engineIntroSeen, false);
  assert.equal(sanitizeSettings({ engineIntroSeen: 'yes' }).engineIntroSeen, false);
  assert.equal(sanitizeSettings({ engineIntroSeen: true }).engineIntroSeen, true);
  const file = buildExport(sanitizeSettings({ engineIntroSeen: true }), { version: 'x' });
  assert.equal('engineIntroSeen' in file.settings, false);
});

test('colours: each station gets its own from the palette, the ones chosen are kept, bad values are replaced; none is a state colour', () => {
  const st = assignColors([{ id: 'a' }, { id: 'b', color: '#22D3EE' }, { id: 'c', color: 'red' }, { id: 'd' }]);
  assert.equal(st[1].color, '#22D3EE');
  const got = st.map((x) => x.color.toLowerCase());
  assert.equal(new Set(got).size, 4, 'four different colours');
  assert.ok(PALETTE.every((c) => !['#35c98f', '#f2c14e', '#ef5b5b', '#6aa7ff'].includes(c)));
  const many = assignColors(Array.from({ length: 12 }, (_, i) => ({ id: String(i) })));
  assert.ok(many.every((x) => PALETTE.includes(x.color)), 'more stations than colours: the palette goes round');
  const s = sanitizeSettings({ stations: [{ id: 'a', name: 'A', color: '#A78BFA' }, { id: 'b', name: 'B' }] });
  assert.equal(s.stations[0].color, '#a78bfa');
  assert.ok(/^#[0-9a-f]{6}$/.test(s.stations[1].color) && s.stations[1].color !== s.stations[0].color);
});

test('settings: the alerts of an input are on, off or indicator; "counts" only means something for an indicator', () => {
  const mk = (extra) => sanitizeSettings({ inputs: [{ id: 'x', type: 'stream', streamUrl: 'http://a.example/s', ...extra }] }).inputs[0];
  assert.equal(mk({}).alerts, 'on');
  assert.equal(mk({ alerts: 'nonsense' }).alerts, 'on');
  assert.equal(mk({ alerts: 'off' }).alerts, 'off');
  assert.equal(mk({ alerts: 'indicator', indicatorCounts: true }).indicatorCounts, true);
  assert.equal(mk({ alerts: 'off', indicatorCounts: true }).indicatorCounts, false);
  assert.equal(mk({ alerts: 'indicator', indicatorCounts: 'yes' }).indicatorCounts, false);
});
