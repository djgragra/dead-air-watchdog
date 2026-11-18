// Shared by the engine tests: find the engine, wait for events, serve a live stream in real time.
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineClient, findEngine } from '../src/engine-client.js';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const enginePath = findEngine({ rootDir: root });
export const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

export function startEngine(args = ['--test-sources']) {
  const client = new EngineClient({ binary: enginePath, args }).start();
  const events = [];
  client.on('event', (e) => events.push(e));
  return { client, events };
}

// Resolves with the first event (already received or future) that matches.
export function waitFor(client, events, match, timeoutMs = 15_000) {
  const found = events.find(match);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('event', on);
      reject(new Error(`Timeout waiting for an event; last events: ${JSON.stringify(events.slice(-3))}`));
    }, timeoutMs);
    const on = (e) => {
      if (!match(e)) return;
      clearTimeout(timer);
      client.off('event', on);
      resolve(e);
    };
    client.on('event', on);
  });
}

export const FORMATS = {
  mp3: { ext: 'mp3', type: 'audio/mpeg', codec: ['-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3'] },
  aac: { ext: 'aac', type: 'audio/aac', codec: ['-c:a', 'aac', '-b:a', '128k', '-f', 'adts'] },
  ogg: { ext: 'ogg', type: 'audio/ogg', codec: ['-c:a', 'libvorbis', '-b:a', '128k', '-f', 'ogg'] },
  opus: { ext: 'opus', type: 'audio/ogg', codec: ['-c:a', 'libopus', '-b:a', '64k', '-f', 'ogg'] }, // Ogg Opus, as Icecast sends it
};

// A live stream, like an Icecast server: ffmpeg runs in real time (-re) and its output goes straight to the client,
// a tone of `peakDb` for `toneSec`, then digital silence for `silenceSec`.
export function liveServer(fmt, { toneSec, silenceSec, peakDb = -20 }) {
  const amp = 10 ** (peakDb / 20) / 0.125; // the sine source peaks at 0.125 (-18 dBFS)
  const total = toneSec + silenceSec;
  const filter = `volume=${amp}:eval=once,volume=enable='gte(t,${toneSec})':volume=0,pan=stereo|c0=c0|c1=c0`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': fmt.type, 'icy-name': 'Test', 'Cache-Control': 'no-store' });
    const ff = spawn('ffmpeg', ['-v', 'error', '-re', '-f', 'lavfi', '-i', `sine=frequency=1000:sample_rate=44100:duration=${total}`, '-af', filter, ...fmt.codec, 'pipe:1'], { stdio: ['ignore', 'pipe', 'inherit'] });
    ff.stdout.pipe(res);
    res.on('close', () => ff.kill());
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/live` })));
}

// A server that hands the audio over in lumps, as a buffering proxy or a security program does (seen on a radio PC: 128 KB
// every 5 s of a 192 kbit/s stream): it keeps what the real server sends until `lumpBytes` are there and sends them at once.
export function lumpyProxy(targetUrl, lumpBytes) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
    let held = Buffer.alloc(0);
    const up = http.get(targetUrl, (r) => {
      r.on('data', (d) => {
        held = Buffer.concat([held, d]);
        while (held.length >= lumpBytes) {
          res.write(held.subarray(0, lumpBytes));
          held = held.subarray(lumpBytes);
        }
      });
    });
    up.on('error', () => res.end());
    res.on('close', () => up.destroy());
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/lumpy` })));
}
