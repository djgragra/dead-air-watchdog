// "Start with the computer" on Linux. Electron's setLoginItemSettings does nothing there, so the app writes the standard
// XDG autostart entry (~/.config/autostart/dead-air-watchdog.desktop) itself, and removes it when the option is switched off.
// It is rewritten at every start, so a new AppImage path (a new version in another folder) is picked up.
// Only a file carrying our own marker is ever changed or removed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FILE = 'dead-air-watchdog.desktop';
const MARK = 'X-DeadAirWatchdog-Autostart=true';

export function autostartDir(env = process.env, home = os.homedir()) {
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'autostart');
}

// the command line of the entry: quoted as the Desktop Entry spec wants
export function quoteExec(p) {
  return `"${String(p).replace(/(["`$\\])/g, '\\$1').replace(/%/g, '%%')}"`;
}

export function desktopEntry(execPath, name = 'Dead Air Watchdog') {
  return ['[Desktop Entry]', 'Type=Application', `Name=${name}`, `Exec=${quoteExec(execPath)} --autostart`, 'Terminal=false', 'X-GNOME-Autostart-enabled=true', MARK, ''].join('\n');
}

// what to launch: the AppImage itself when running from one, otherwise the installed program (.deb)
export function execTarget(env = process.env, execPath = process.execPath) {
  return env.APPIMAGE || execPath;
}

// returns 'written' | 'removed' | 'unchanged' | 'foreign' (a file that is not ours is left alone)
export function applyAutostart(enabled, { dir = autostartDir(), exec = execTarget(), fsm = fs } = {}) {
  const file = path.join(dir, FILE);
  let current = null;
  try { current = fsm.readFileSync(file, 'utf8'); } catch { /* not there */ }
  if (current !== null && !current.includes(MARK)) return 'foreign';
  if (!enabled) {
    if (current === null) return 'unchanged';
    fsm.rmSync(file, { force: true });
    return 'removed';
  }
  const want = desktopEntry(exec);
  if (current === want) return 'unchanged';
  fsm.mkdirSync(dir, { recursive: true });
  fsm.writeFileSync(file, want, { mode: 0o644 });
  return 'written';
}
