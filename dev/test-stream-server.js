// Serves a synthetic WAV over HTTP for end-to-end tests: tone / silence segments with known levels.
//   node dev/test-stream-server.js [port] [segments]
// segments: comma list of "<seconds>@<peak dBFS>" (use "off" for digital silence), default "8@-20,10@off,8@-20".
// The server sends no CORS headers on purpose: the app must cope with that, like with real servers.
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const SAMPLE_RATE = 48000;

export function makeWav(segments, hz = 1000) {
  const frames = segments.reduce((n, s) => n + Math.round(s.seconds * SAMPLE_RATE), 0);
  const data = Buffer.alloc(frames * 4);
  let f = 0;
  for (const s of segments) {
    const amp = s.peakDb === null ? 0 : 10 ** (s.peakDb / 20);
    for (let i = 0; i < Math.round(s.seconds * SAMPLE_RATE); i++, f++) {
      const v = Math.round(amp * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * 32767);
      data.writeInt16LE(v, f * 4);
      data.writeInt16LE(v, f * 4 + 2);
    }
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22);
  head.writeUInt32LE(SAMPLE_RATE, 24); head.writeUInt32LE(SAMPLE_RATE * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

export function parseSegments(spec) {
  return spec.split(',').map((p) => {
    const [sec, lvl] = p.split('@');
    return { seconds: Number(sec), peakDb: lvl === 'off' ? null : Number(lvl) };
  });
}

export function startServer(port, segments) {
  const wav = makeWav(segments);
  const server = http.createServer((req, res) => {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const base = { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : wav.length - 1;
      res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${wav.length}`, 'Content-Length': end - start + 1 });
      res.end(wav.subarray(start, end + 1));
    } else {
      res.writeHead(200, { ...base, 'Content-Length': wav.length });
      res.end(wav);
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2]) || 8765;
  await startServer(port, parseSegments(process.argv[3] || '8@-20,10@off,8@-20'));
  console.log(`test stream on http://127.0.0.1:${port}/test.wav`);
}
