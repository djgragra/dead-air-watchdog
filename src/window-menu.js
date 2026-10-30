// Menus of the main window that do not depend on Electron: what the application menu holds (no "Zoom" entry on
// Windows and Linux, where it does nothing), the zoom step of Ctrl + mouse wheel, and the right-click menu of the compact view.

export const ZOOM_STEP = 0.5;
export const ZOOM_MIN = -3;
export const ZOOM_MAX = 5;

// Zoom level after one notch of Ctrl + wheel ('in' | 'out'), kept inside the limits. 0 is the normal size.
export function nextZoomLevel(level, direction) {
  const cur = Number.isFinite(level) ? level : 0;
  const next = cur + (direction === 'in' ? ZOOM_STEP : direction === 'out' ? -ZOOM_STEP : 0);
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 100) / 100));
}

// Application menu: the same four menus as the default one of Electron, with the Window menu reduced to what works
// ("Zoom" of the default Window menu is for macOS only; the zoom of the page is in the View menu).
// macOS keeps its default menu (null: nothing to set).
export function appMenuTemplate(platform) {
  if (platform === 'darwin') return null;
  return [{ role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] }];
}

// Is the menu bar hidden: only in the compact view, only where there is a menu bar in the window.
export const menuBarHidden = (win, platform) => platform !== 'darwin' && !!win?.compact && !!win?.hideMenuBar;

// Right-click menu of the compact view: the way back to the menu bar and the other things the bar holds.
// `tr` gives the text of a key; `act` has the functions it calls.
export function compactContextTemplate(win, tr, act) {
  return [
    { label: tr('ctx.menuBar'), type: 'checkbox', checked: !win.hideMenuBar, click: () => act.toggle('hideMenuBar') },
    { label: tr('tray.compact'), type: 'checkbox', checked: !!win.compact, click: () => act.toggle('compact') },
    { label: tr('tray.top'), type: 'checkbox', checked: !!win.alwaysOnTop, click: () => act.toggle('alwaysOnTop') },
    { type: 'separator' },
    { label: tr('ctx.zoomIn'), click: () => act.zoom('in') },
    { label: tr('ctx.zoomOut'), click: () => act.zoom('out') },
    { label: tr('ctx.zoomReset'), click: () => act.zoom('reset') }
  ];
}
