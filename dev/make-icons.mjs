#!/usr/bin/env node
// Builds every icon from the two SVG sources in assets/: logo.svg (app icon) and tray.svg (macOS menu bar glyph).
// Writes icon.png, icon-mac.png, icon.ico, icon.icns, linux-icons/*.png, tray-<state>.png (colour, Windows / Linux and
// the monitoring states on macOS), trayTemplate.png and trayTemplate@2x.png (macOS menu bar, single colour), and copies
// logo.svg next to the window (renderer/logo.svg).
// Needs Playwright with a Chromium (only to draw the SVG; nothing is shipped):
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM=/path/to/chrome node dev/make-icons.mjs
// Works on any system (no sips / iconutil).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const svgText = (f) => fs.readFileSync(path.join(root, f), 'utf8');

async function render(svg, size) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  const buf = await page.screenshot({ omitBackground: true });
  await page.close();
  return buf;
}

const logo = svgText('logo.svg');
const cache = new Map();
const logoPng = async (s) => { if (!cache.has(s)) cache.set(s, await render(logo, s)); return cache.get(s); };
const write = (f, buf) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), buf); };

write('icon.png', await logoPng(1024));
write('icon-mac.png', await logoPng(1024));
for (const s of [16, 32, 48, 64, 128, 256, 512]) write(`linux-icons/${s}x${s}.png`, await logoPng(s));

// .ico: PNG images inside the container
const icoSizes = [16, 32, 48, 64, 128, 256];
const icoImgs = await Promise.all(icoSizes.map(logoPng));
{
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(icoSizes.length, 4);
  let offset = 6 + 16 * icoSizes.length;
  const entries = icoSizes.map((s, i) => {
    const e = Buffer.alloc(16);
    e[0] = s === 256 ? 0 : s; e[1] = s === 256 ? 0 : s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(icoImgs[i].length, 8); e.writeUInt32LE(offset, 12); offset += icoImgs[i].length;
    return e;
  });
  write('icon.ico', Buffer.concat([head, ...entries, ...icoImgs]));
}

// .icns: PNG entries
{
  const types = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]];
  const parts = [];
  for (const [type, s] of types) {
    const data = await logoPng(s);
    const h = Buffer.alloc(8); h.write(type, 0, 'ascii'); h.writeUInt32BE(data.length + 8, 4);
    parts.push(h, data);
  }
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8); h.write('icns', 0, 'ascii'); h.writeUInt32BE(body.length + 8, 4);
  write('icon.icns', Buffer.concat([h, body]));
}

// tray: one colour per monitoring state (the glyph of the logo in a round badge)
const STATE = { idle: '#8a93a3', ok: '#35c98f', counting: '#f2c14e', alarm: '#ef5b5b' };
const bars = '<g fill="#14161a"><rect x="7" y="10" width="3" height="12" rx="1.5"/><rect x="11.5" y="7" width="3" height="18" rx="1.5"/><rect x="16" y="10" width="3" height="12" rx="1.5"/><rect x="20.5" y="13" width="3" height="6" rx="1.5"/></g>';
for (const [state, colour] of Object.entries(STATE)) {
  write(`tray-${state}.png`, await render(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14.5" fill="${colour}" stroke="#14161a" stroke-width="1.5"/>${bars}</svg>`, 32));
}
write('trayTemplate.png', await render(svgText('tray.svg'), 22));      // macOS menu bar (template image)
write('trayTemplate@2x.png', await render(svgText('tray.svg'), 44));
fs.copyFileSync(path.join(root, 'logo.svg'), path.join(root, '..', 'renderer', 'logo.svg'));
await browser.close();
console.log('icons written');
