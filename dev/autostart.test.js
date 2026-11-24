import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyAutostart, desktopEntry, quoteExec, autostartDir, execTarget, FILE } from '../src/autostart.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'daw-autostart-'));

test('autostartDir follows XDG_CONFIG_HOME', () => {
  assert.equal(autostartDir({ XDG_CONFIG_HOME: '/x' }, '/h'), '/x/autostart');
  assert.equal(autostartDir({}, '/h'), '/h/.config/autostart');
});
test('the entry quotes the path and starts hidden-capable', () => {
  assert.equal(quoteExec('/a b/$c"d%'), '"/a b/\\$c\\"d%%"');
  assert.match(desktopEntry('/opt/x/daw'), /^Exec="\/opt\/x\/daw" --autostart$/m);
});
test('execTarget prefers the AppImage path', () => {
  assert.equal(execTarget({ APPIMAGE: '/h/DAW.AppImage' }, '/tmp/.mount/daw'), '/h/DAW.AppImage');
  assert.equal(execTarget({}, '/opt/daw'), '/opt/daw');
});
test('write, rewrite on a new path, remove', () => {
  const dir = path.join(tmp(), 'autostart');
  assert.equal(applyAutostart(true, { dir, exec: '/a/DAW-1.AppImage' }), 'written');
  assert.equal(applyAutostart(true, { dir, exec: '/a/DAW-1.AppImage' }), 'unchanged');
  assert.equal(applyAutostart(true, { dir, exec: '/a/DAW-2.AppImage' }), 'written');
  assert.match(fs.readFileSync(path.join(dir, FILE), 'utf8'), /DAW-2/);
  assert.equal(applyAutostart(false, { dir }), 'removed');
  assert.equal(applyAutostart(false, { dir }), 'unchanged');
});
test('a file that is not ours is never touched', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, FILE), '[Desktop Entry]\nName=Mine\n');
  assert.equal(applyAutostart(true, { dir, exec: '/x' }), 'foreign');
  assert.equal(applyAutostart(false, { dir }), 'foreign');
  assert.match(fs.readFileSync(path.join(dir, FILE), 'utf8'), /Mine/);
});
