// 26.10.12: Zoom entry of the Window menu, Ctrl + wheel zoom, menu bar hidden in the compact view, "Very large" names, "Medium" logo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../src/store.js';
import { appMenuTemplate, compactContextTemplate, menuBarHidden, nextZoomLevel, ZOOM_MAX, ZOOM_MIN } from '../src/window-menu.js';
import { MESSAGES, t } from '../src/messages.js';
import { STRINGS } from '../renderer/i18n.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('application menu: no "Zoom" entry on Windows and Linux, the default one stays on macOS', () => {
  assert.equal(appMenuTemplate('darwin'), null);
  for (const platform of ['win32', 'linux']) {
    const tpl = appMenuTemplate(platform);
    assert.deepEqual(tpl.map((m) => m.role || m.label), ['fileMenu', 'editMenu', 'viewMenu', 'Window']);
    const win = tpl.find((m) => m.label === 'Window');
    assert.deepEqual(win.submenu.map((i) => i.role), ['minimize', 'close']);
    assert.ok(!JSON.stringify(tpl).includes('"zoom"'));
  }
});

test('Ctrl + wheel: half a step each time, inside the limits, nothing for an unknown direction', () => {
  assert.equal(nextZoomLevel(0, 'in'), 0.5);
  assert.equal(nextZoomLevel(0, 'out'), -0.5);
  assert.equal(nextZoomLevel(ZOOM_MAX, 'in'), ZOOM_MAX);
  assert.equal(nextZoomLevel(ZOOM_MIN, 'out'), ZOOM_MIN);
  assert.equal(nextZoomLevel(1, 'sideways'), 1);
  assert.equal(nextZoomLevel(undefined, 'in'), 0.5);
  assert.equal(nextZoomLevel(0.5, 'out'), 0); // back to the normal size without drift
});

test('menu bar hidden: off by default, only in the compact view, never on macOS', () => {
  assert.equal(DEFAULT_SETTINGS.window.hideMenuBar, false);
  assert.equal(sanitizeSettings({}).window.hideMenuBar, false);
  assert.equal(sanitizeSettings({ window: { hideMenuBar: 1 } }).window.hideMenuBar, true);
  assert.equal(menuBarHidden({ compact: true, hideMenuBar: true }, 'win32'), true);
  assert.equal(menuBarHidden({ compact: false, hideMenuBar: true }, 'win32'), false); // the normal view always has its menu bar
  assert.equal(menuBarHidden({ compact: true, hideMenuBar: false }, 'linux'), false);
  assert.equal(menuBarHidden({ compact: true, hideMenuBar: true }, 'darwin'), false);
  assert.equal(menuBarHidden(undefined, 'win32'), false);
});

test('the choice of the menu bar is not part of a backup (it belongs to the window)', () => {
  assert.match(read('../src/backup.js'), /RUNTIME_KEYS|window/);
});

test('right-click menu of the compact view: the way back to the menu bar, the views and the zoom', () => {
  const calls = [];
  const act = { toggle: (k) => calls.push(`toggle:${k}`), zoom: (d) => calls.push(`zoom:${d}`) };
  const tpl = compactContextTemplate({ compact: true, hideMenuBar: true, alwaysOnTop: false }, (k) => k, act);
  const bar = tpl[0];
  assert.equal(bar.label, 'ctx.menuBar');
  assert.equal(bar.checked, false); // hidden: the item shows the bar when clicked
  for (const item of tpl) item.click?.();
  assert.deepEqual(calls, ['toggle:hideMenuBar', 'toggle:compact', 'toggle:alwaysOnTop', 'zoom:in', 'zoom:out', 'zoom:reset']);
  assert.equal(compactContextTemplate({ compact: true, hideMenuBar: false }, (k) => k, act)[0].checked, true);
});

test('texts of the right-click menu and of the tray exist in the three languages', () => {
  for (const l of ['en', 'it', 'es']) for (const k of ['tray.hideMenu', 'ctx.menuBar', 'ctx.zoomIn', 'ctx.zoomOut', 'ctx.zoomReset']) assert.ok(MESSAGES[l][k] && t(l, k) === MESSAGES[l][k], `${l} ${k}`);
});

test('wiring: the window honours the menu bar choice and zooms with the wheel, the tray has the switch', () => {
  const main = read('../main.js');
  assert.match(main, /setApplicationMenu/);
  assert.match(main, /'zoom-changed'/);
  assert.match(main, /'context-menu'/);
  assert.match(main, /menuBarHidden\(store\.getSettings\(\)\.window, process\.platform\)/);
  assert.match(main, /key !== 'hideMenuBar'/);
  assert.match(main, /tray\.hideMenu/);
});

test('wall display: "Very large" names and "Medium" logo are valid, anything else falls back', () => {
  assert.equal(sanitizeSettings({ display: { wallNameSize: 'xlarge' } }).display.wallNameSize, 'xlarge');
  assert.equal(sanitizeSettings({ display: { wallNameSize: 'huge' } }).display.wallNameSize, 'auto');
  assert.equal(sanitizeSettings({ display: { wallLogo: 'medium' } }).display.wallLogo, 'medium');
  assert.equal(sanitizeSettings({ display: { wallLogo: 'huge' } }).display.wallLogo, 'large');
  for (const l of ['en', 'it', 'es']) for (const k of ['set.disp.name.xlarge', 'set.disp.logo.medium', 'set.disp.hideBar']) assert.ok(STRINGS[l][k], `${l} ${k}`);
  const html = read('../renderer/index.html');
  assert.match(html, /<option value="xlarge"/);
  assert.match(html, /<option value="medium" data-i18n="set\.disp\.logo\.medium"/);
  const css = read('../renderer/style.css');
  assert.match(css, /data-wallname="xlarge"\] \.tile__name/);
  assert.match(css, /data-walllogo="medium"\] \{ --logo-col: 22%/);
});

test('compact view: the status badge is the item that goes to the next line, the bars give way when very narrow', () => {
  const css = read('../renderer/style.css');
  assert.match(css, /body\.compact:not\(\.wall\) \.topbar \.pill \{ order: 9;/);
  assert.match(css, /@media \(max-width: 250px\)/);
});

test('compact view: the end of the list stays in sight when the window gets shorter', () => {
  const js = read('../renderer/app.js');
  assert.match(js, /scroller\.scrollTop = scroller\.scrollHeight/);
});
