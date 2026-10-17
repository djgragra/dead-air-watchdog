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
