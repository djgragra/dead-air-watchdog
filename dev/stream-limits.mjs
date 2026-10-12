// Measures how many live streams a Chromium page can hold at once, against a local server that sends endless
// real-time WAV streams ("Icecast-like"). It is why the app opens streams in several audio windows
// (src/engine-shards.js): one page holds 10 <audio> streams at most, and 6 per server.
//   node dev/stream-limits.mjs [streamsPerContext] [audio|fetch] [hosts] [contexts]
// Needs Playwright with a Chromium (not a dependency of the app): `npm i -g playwright` or PLAYWRIGHT_MODULE=<path>.
import http from 'node:http';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import path from 'node:path';

const [N = 24, KIND = 'audio', HOSTS = 4, CTX = 1] = process.argv.slice(2).map((v, i) => (i === 1 ? v : Number(v)));
function loadPlaywright() {
  const req = createRequire(import.meta.url);
  for (const m of [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core', path.join(execSync('npm root -g').toString().trim(), 'playwright')].filter(Boolean)) {
    try {
      return req(m);
    } catch {
      /* next */
    }
  }
  throw new Error('Playwright not found (npm i -g playwright, or set PLAYWRIGHT_MODULE)');
}
const { chromium } = loadPlaywright();

const SR = 44100;
const head = Buffer.alloc(44);
head.write('RIFF', 0); head.writeUInt32LE(0xffffffff, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22);
head.writeUInt32LE(SR, 24); head.writeUInt32LE(SR * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(0xffffffff, 40);
let open = 0;
let max = 0;
const server = http.createServer((req, res) => {
  if (!req.url.startsWith('/m')) return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><body></body></html>');
  open++;
  max = Math.max(max, open);
  res.writeHead(200, { 'Content-Type': 'audio/wav', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.write(head);
  let t = 0;
  const iv = setInterval(() => {
    const b = Buffer.alloc((SR / 10) * 4);
    for (let i = 0; i < SR / 10; i++, t++) b.writeInt16LE(Math.round(0.1 * Math.sin((2 * Math.PI * 1000 * t) / SR) * 32767), i * 4);
    res.write(b);
  }, 100);
  req.on('close', () => {
    clearInterval(iv);
    open--;
  });
});
await new Promise((r) => server.listen(0, '0.0.0.0', r));
const port = server.address().port;
const hosts = ['127.0.0.1', 'localhost', '127.0.0.2', '127.0.0.3', '127.0.0.4', '127.0.0.5'];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
const pages = [];
for (let c = 0; c < CTX; c++) {
  const page = await (await browser.newContext()).newPage(); // a context is what a session partition is in Electron
  await page.goto(`http://127.0.0.1:${port}/`);
  pages.push(page);
}
for (const [c, page] of pages.entries()) {
  await page.evaluate(({ N, KIND, port, hosts, HOSTS, c }) => {
    for (let i = 0; i < N; i++) {
      const url = `http://${hosts[i % HOSTS]}:${port}/m${c}_${i}`;
      if (KIND === 'audio') {
        const a = new Audio();
        a.crossOrigin = 'anonymous';
        a.src = url;
        a.play().catch(() => {});
        window['a' + i] = a;
      } else {
        fetch(url).then(async (r) => { const rd = r.body.getReader(); for (;;) if ((await rd.read()).done) break; }).catch(() => {});
      }
    }
  }, { N, KIND, port, hosts, HOSTS, c });
}
await pages[0].waitForTimeout(8000);
console.log(`${KIND}: ${N} streams per page, ${HOSTS} host(s), ${CTX} context(s) -> ${open} connected at the server (highest ${max})`);
await browser.close();
server.close();
process.exit(0);
