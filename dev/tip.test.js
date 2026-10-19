import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STRINGS, tipUrl, TIP_URLS } from '../renderer/i18n.js';

test('tip card: text and button exist in English, Italian and Spanish', () => {
  for (const l of ['en', 'it', 'es']) {
    assert.ok(STRINGS[l]['tip.text'].length > 10, l);
    assert.ok(STRINGS[l]['tip.btn'].length > 2, l);
  }
  assert.equal(STRINGS.en['tip.btn'], 'Tip jar');
  assert.equal(STRINGS.it['tip.btn'], 'Salvadanaio');
  assert.equal(STRINGS.es['tip.btn'], 'Hucha');
});

test('tip card: the link is the site page in the window language, English for anything else', () => {
  assert.equal(tipUrl('en'), 'https://onairgarage.com/support/');
  assert.equal(tipUrl('it'), 'https://onairgarage.com/it/support/');
  assert.equal(tipUrl('es'), 'https://onairgarage.com/es/support/');
  assert.equal(tipUrl('fr'), 'https://onairgarage.com/support/');
});

test('tip card: the three pages pass the external-link allow-list of main.js, no payment link in the app', () => {
  const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  const m = main.match(/const EXTERNAL_OK = \[(.*)\];/);
  const list = [...m[1].matchAll(/\/(\^.*?)\/(?=,|$)/g)].map((x) => new RegExp(x[1]));
  assert.ok(list.length >= 2);
  for (const u of Object.values(TIP_URLS)) assert.ok(list.some((re) => re.test(u)), u);
  const all = fs.readFileSync(new URL('../renderer/app.js', import.meta.url), 'utf8') + fs.readFileSync(new URL('../renderer/i18n.js', import.meta.url), 'utf8');
  assert.ok(!/stripe\.com/i.test(all));
});

test('tip card: the jar image ships with the app (renderer/** is packaged) and the markup has the card', () => {
  assert.ok(fs.existsSync(new URL('../renderer/img/tip-jar.png', import.meta.url)));
  const html = fs.readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  assert.match(html, /<img class="tip__art" src="img\/tip-jar\.png" alt=""/);
  assert.match(html, /id="tipBtn"/);
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.build.files.includes('renderer/**/*'));
});

test('tip card: the jar is a second link, same handler and URL as the button, hidden from keyboard and screen readers', () => {
  const html = fs.readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const jar = html.match(/<button[^>]*id="tipJar"[^>]*>(.*?)<\/button>/);
  assert.ok(jar, 'jar element');
  assert.match(jar[0], /tabindex="-1"/);
  assert.match(jar[0], /aria-hidden="true"/);
  assert.match(jar[1], /<img class="tip__art"[^>]*alt=""/);
  const app = fs.readFileSync(new URL('../renderer/app.js', import.meta.url), 'utf8');
  const wire = app.match(/for \(const id of \[([^\]]*)\]\) \$\(id\)\.addEventListener\('click', \(\) => api\.app\.openExternal\(tipUrl\(lang\)\)\);/);
  assert.ok(wire, 'one handler for both');
  assert.deepEqual(wire[1].split(',').map((x) => x.trim()), ["'tipBtn'", "'tipJar'"]);
  // the handler resolves the URL with the window language: all three pages
  assert.equal(tipUrl('en'), 'https://onairgarage.com/support/');
  assert.equal(tipUrl('it'), 'https://onairgarage.com/it/support/');
  assert.equal(tipUrl('es'), 'https://onairgarage.com/es/support/');
});

test('tip card: the jar tilts on hover and stays still with reduced motion', () => {
  const css = fs.readFileSync(new URL('../renderer/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.tip__jar \{[^}]*cursor: pointer[^}]*transition: transform \.15s ease/);
  assert.match(css, /\.tip__jar:hover \{ transform: rotate\(-4deg\) scale\(1\.06\); \}/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \.tip__jar \{ transition: none; \} \.tip__jar:hover \{ transform: none; \} \}/);
});

test('window: the summary card, the options of an input and the big status line are wired', () => {
  const html = fs.readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../renderer/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../renderer/style.css', import.meta.url), 'utf8');
  const pre = fs.readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8');
  const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  for (const id of ['reportCard', 'reportPeriod', 'reportBox', 'reportCommon', 'reportCsv']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(pre, /report: \{[^}]*'report:get'[^}]*'report:export'/s);
  assert.match(main, /handle\('report:get'/);
  assert.match(main, /handle\('report:export'/);
  // what the settings form reads must be what the store keeps: otherwise saving the form would reset the options
  for (const f of ['yellowDelaySec', 'frozenSec', 'frozenToleranceDb', 'schedule']) assert.match(app, new RegExp(`${f}: `), f);
  assert.match(app, /function fitWallStatus/);
  assert.match(css, /\.wallhead__state\.is-big \{[^}]*white-space: nowrap/);
});
