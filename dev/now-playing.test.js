// 26.11.3: the song title of a stream (ICY metadata) on the tile, for the inputs that switched it on.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { parseStreamTitle, cleanTitle, readNowPlaying, createNowPlaying, INTERVAL_MS, STALE_MS } from '../src/now-playing.js';
import { sanitizeSettings, DEFAULT_INPUT } from '../src/store.js';

// A small Icecast: sends audio bytes, and every `interval` bytes a metadata block. blocks = list of strings (null = empty block).
function icyServer({ interval = 1000, blocks, headers = {}, status = 200 }) {
  const seen = { requests: 0, icyHeader: null, closed: 0 };
  const server = http.createServer((req, res) => {
    seen.requests++;
    seen.icyHeader = req.headers['icy-metadata'];
    res.writeHead(status, { 'Content-Type': 'audio/mpeg', 'icy-metaint': String(interval), ...headers });
    res.on('close', () => seen.closed++);
    let n = 0;
    const timer = setInterval(() => {
      const meta = blocks[Math.min(n, blocks.length - 1)];
      n++;
      res.write(Buffer.alloc(interval, 0x55));
      if (meta === null) res.write(Buffer.from([0]));
      else {
        const body = Buffer.from(meta, typeof meta === 'string' ? 'utf8' : undefined);
        const len = Math.ceil(body.length / 16);
        const blk = Buffer.alloc(1 + len * 16);
        blk[0] = len;
        body.copy(blk, 1);
        res.write(blk);
      }
    }, 5);
    res.on('close', () => clearInterval(timer));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/live` })));
}
const stop = (s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); });

test('StreamTitle is read from the metadata text, apostrophes inside the title included', () => {
  assert.equal(parseStreamTitle("StreamTitle='Queen - Bohemian Rhapsody';StreamUrl='';"), 'Queen - Bohemian Rhapsody');
  assert.equal(parseStreamTitle("StreamTitle='Guns N' Roses - Don't Cry';"), "Guns N' Roses - Don't Cry");
  assert.equal(parseStreamTitle("StreamTitle='';StreamUrl='';"), '');
  assert.equal(parseStreamTitle('nothing here'), '');
  assert.equal(parseStreamTitle(''), '');
});

test('a title is one clean line of at most 200 characters, without control characters', () => {
  assert.equal(cleanTitle('  Artist \n\t - \u0000 Song  '), 'Artist - Song');
  assert.equal(cleanTitle('x'.repeat(500)).length, 200);
  assert.equal(cleanTitle('a‮b'), 'a b'); // direction override removed
});

test('reads the title from a real ICY server, asks for metadata and closes the connection', async () => {
  const { server, seen, url } = await icyServer({ interval: 1000, blocks: ["StreamTitle='Artist - Song';"] });
  try {
    const r = await readNowPlaying(url, fetch);
    assert.deepEqual(r, { ok: true, title: 'Artist - Song' });
    assert.equal(seen.icyHeader, '1');
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(seen.closed, 1, 'the connection is closed after the title');
  } finally { await stop(server); }
});

test('an empty first block is skipped; non-ASCII titles work in UTF-8 and in Latin-1', async () => {
  const a = await icyServer({ blocks: [null, "StreamTitle='Beyoncé - Halo';"] });
  const b = await icyServer({ blocks: [Buffer.concat([Buffer.from("StreamTitle='Zucchero - Così Celeste", 'utf8').subarray(0, 0), Buffer.from("StreamTitle='Zucchero - Cos\xec Celeste';", 'latin1')])] });
  try {
    assert.deepEqual(await readNowPlaying(a.url, fetch), { ok: true, title: 'Beyoncé - Halo' });
    assert.deepEqual(await readNowPlaying(b.url, fetch), { ok: true, title: 'Zucchero - Così Celeste' });
  } finally { await stop(a.server); await stop(b.server); }
});

test('a server without metadata, an error status and a server that is down give ok: false', async () => {
  const none = await icyServer({ blocks: ["StreamTitle='x';"], headers: { 'icy-metaint': '0' } });
  const bad = await icyServer({ blocks: ["StreamTitle='x';"], status: 404 });
  const huge = await icyServer({ blocks: ["StreamTitle='x';"], headers: { 'icy-metaint': '99999999' } });
  const url = bad.url;
  try {
    assert.equal((await readNowPlaying(none.url, fetch)).ok, false);
    assert.equal((await readNowPlaying(bad.url, fetch)).ok, false);
    assert.equal((await readNowPlaying(huge.url, fetch)).ok, false);
  } finally { await stop(none.server); await stop(bad.server); await stop(huge.server); }
  assert.equal((await readNowPlaying(url, fetch, { timeoutMs: 500 })).ok, false); // nobody listens any more
});

test('a server that never sends the metadata is given up after the time limit', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'icy-metaint': '1000' }); res.write(Buffer.alloc(10)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const t0 = Date.now();
    const r = await readNowPlaying(`http://127.0.0.1:${server.address().port}/`, fetch, { timeoutMs: 300 });
    assert.equal(r.ok, false);
    assert.ok(Date.now() - t0 < 2000);
  } finally { await stop(server); }
});

// ---- the setting and the poller ----------------------------------------------------------------------------------

test('nowPlaying is off by default, is a plain boolean and exists only for streams', () => {
  assert.equal(DEFAULT_INPUT.nowPlaying, false);
  const s = sanitizeSettings({ inputs: [{ id: 'a', type: 'stream', streamUrl: 'http://x.test/a', nowPlaying: true }, { id: 'b', type: 'stream', streamUrl: 'http://x.test/b' }, { id: 'c', type: 'device', nowPlaying: true }, { id: 'd', type: 'stream', streamUrl: 'http://x.test/d', nowPlaying: 'yes' }] });
  assert.deepEqual(s.inputs.map((i) => i.nowPlaying), [true, false, false, false]);
});

function poller(inputs, readFn, extra = {}) {
  const clock = { t: 1_000_000 };
  const published = [];
  const asked = [];
  const np = createNowPlaying({
    getSettings: () => ({ inputs }),
    fetchFn: () => { throw new Error('not used'); },
    now: () => clock.t,
    publish: (m) => published.push(m),
    read: async (url) => { asked.push(url); return readFn(url); },
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
    ...extra
  });
  return { np, clock, published, asked };
}
const flush = () => new Promise((r) => setImmediate(r));
const stream = (id, extra = {}) => ({ id, name: id, type: 'stream', streamUrl: `http://${id}.test/live`, enabled: true, nowPlaying: true, ...extra });

test('only the streams that asked for it are asked, and only once per interval', async () => {
  const { np, clock, asked, published } = poller([stream('a'), stream('b', { nowPlaying: false }), { id: 'c', type: 'device', enabled: true, nowPlaying: true }, stream('d', { enabled: false })], async () => ({ ok: true, title: 'Artist - Song' }));
  np.tick();
  await flush();
  assert.deepEqual(asked, ['http://a.test/live']);
  assert.deepEqual(np.get(), { a: 'Artist - Song' });
  assert.deepEqual(published.at(-1), { a: 'Artist - Song' });
  clock.t += INTERVAL_MS - 1;
  np.tick();
  await flush();
  assert.equal(asked.length, 1);
  clock.t += 1;
  np.tick();
  await flush();
  assert.equal(asked.length, 2);
});

test('a new song is published; the same title is not published twice', async () => {
  let title = 'One';
  const { np, clock, published } = poller([stream('a')], async () => ({ ok: true, title }));
  np.tick(); await flush();
  clock.t += INTERVAL_MS; np.tick(); await flush();
  title = 'Two';
  clock.t += INTERVAL_MS; np.tick(); await flush();
  assert.deepEqual(published, [{ a: 'One' }, { a: 'Two' }]);
});

test('a title that cannot be renewed disappears after STALE_MS; a server without titles shows nothing', async () => {
  let ok = true;
  const { np, clock, published } = poller([stream('a'), stream('b')], async (url) => (url.includes('b.test') ? { ok: false, title: '' } : { ok, title: 'Song' }));
  np.tick(); await flush();
  assert.deepEqual(np.get(), { a: 'Song' });
  ok = false;
  for (let i = 0; i < 6; i++) { clock.t += INTERVAL_MS; np.tick(); await flush(); }
  assert.ok(clock.t - 1_000_000 >= STALE_MS);
  assert.deepEqual(np.get(), {});
  assert.deepEqual(published.at(-1), {});
});

test('nothing is asked while the window is not on screen or monitoring is off; asked at once when it comes back', async () => {
  let active = false;
  const { np, asked } = poller([stream('a')], async () => ({ ok: true, title: 'Song' }), { isActive: () => active });
  np.tick(); await flush();
  assert.equal(asked.length, 0);
  active = true;
  np.refresh(); await flush();
  assert.equal(asked.length, 1);
});

test('an input that switches it off or changes its address is forgotten; at most 4 requests at a time', async () => {
  const inputs = [stream('a'), stream('b'), stream('c'), stream('d'), stream('e'), stream('f')];
  let release;
  const gate = new Promise((r) => { release = r; });
  const { np, asked } = poller(inputs, async () => { await gate; return { ok: true, title: 'T' }; });
  np.tick();
  assert.equal(asked.length, 4);
  release(); await flush(); await flush();
  np.tick(); await flush();
  assert.equal(asked.length, 6);
  assert.equal(Object.keys(np.get()).length, 6);
  inputs[0].nowPlaying = false;
  inputs[1].streamUrl = 'http://elsewhere.test/live';
  np.tick(); await flush();
  const got = np.get();
  assert.ok(!('a' in got), 'switched off: gone');
  assert.ok(asked.includes('http://elsewhere.test/live'), 'new address: asked again, the title of the old one is not kept');
});

test('window, help and settings carry the feature in the three languages', async () => {
  const { STRINGS } = await import('../renderer/i18n.js');
  for (const l of ['en', 'it', 'es']) for (const k of ['adv.np', 'adv.np.hint', 'tile.nowPlaying', 'help.hNowPlaying', 'help.pNowPlaying']) assert.ok(STRINGS[l][k], `${l} ${k}`);
  const css = fs.readFileSync(new URL('../renderer/style.css', import.meta.url), 'utf8');
  assert.match(css, /body\.compact:not\(\.wall\) \.tile__np/); // compact view
  assert.match(css, /body\.wall \.tile__np/); // wall display
  const html = fs.readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  assert.match(html, /help\.pNowPlaying/);
  const app = fs.readFileSync(new URL('../renderer/app.js', import.meta.url), 'utf8');
  assert.match(app, /tile__np/); // dashboard tile
  assert.match(app, /np\.textContent = /); // the title goes in as text, never as HTML
  assert.doesNotMatch(app, /np\.innerHTML/);
});
