import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage, nativeTheme, Notification, shell, session, systemPreferences, safeStorage, powerSaveBlocker, net, screen } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createStore, COMPACT_MIN, NORMAL_MIN, compactHeightFor } from './src/store.js';
import { createMonitor, isUsable } from './src/monitor.js';
import { createDispatcher, sendEmail, sendTelegram } from './src/notifications.js';
import { sendWebhook } from './src/webhook.js';
import { checkForUpdate, REPO, pageUrl, downloadInstaller, sweepPartials, bannerState, remindLaterState, skipVersionState, makeSafetyCopy, installPlan, whatsNew, startupKind } from './src/updater.js';
import { createLogger } from './src/logs.js';
import { buildSupportInfo } from './src/support.js';
import { createAlertState } from './src/alert-state.js';
import { createUpdateNotice } from './src/update-notice.js';
import { buildExport, prepareImport, backupFileName, backupTooBig, MAX_BACKUP_BYTES } from './src/backup.js';
import { createHeartbeat } from './src/heartbeat.js';
import { createNowPlaying } from './src/now-playing.js';
import { createLogos } from './src/logos.js';
import { keepIds, adoptLegacy, mergeDuplicates } from './src/logo-refs.js';
import { EngineSupervisor, findEngine, engineProblem } from './src/engine-client.js';
import { createEngineBridge } from './src/engine-bridge.js';
import { resolveDevice } from './src/devices.js';
import { createSnmpWatcher } from './src/snmp.js';
import { aggregateDeadAir } from './src/core/stats.js';
import { buildReport, findCommonProblems, periodRange, reportToCsv } from './src/core/report.js';
import { toCsv, toJson } from './src/core/export.js';
import { formatDuration } from './src/core/format.js';
import { appMenuTemplate, compactContextTemplate, menuBarHidden, nextZoomLevel } from './src/window-menu.js';
import { t, alertPrefix, installationName, withPrefix, inputLabel } from './src/messages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Tests can point the app at a throw-away data folder.
if (process.env.DAW_USER_DATA) app.setPath('userData', process.env.DAW_USER_DATA);

if (!app.requestSingleInstanceLock()) app.quit();

// Log: one file per day in <userData>/logs (7 days, 5 MB each), also shown to support ("Open logs folder")
const logger = createLogger({ dir: path.join(app.getPath('userData'), 'logs'), retentionDays: 7 });
const clog = (message, level = 'info', scope = '') => logger.log(level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', message, scope);
const settingsFile = () => path.join(app.getPath('userData'), 'dead-air-watchdog.json');
let hadSettingsFile = false;

let store;
let monitor;
let dispatcher;
let updateNotice;
// last failed delivery per channel (cleared by the next success): shown in the window so a broken email setup is not silent
const deliveryFaults = new Map();
const faultList = () => [...deliveryFaults].map(([channel, f]) => ({ channel, ...f }));
let alertState;
let heartbeat;
let nowPlaying;
let snmpWatcher = null;
let logos;
let wallBlockerId = null;
let soundActive = false;
let soundMuted = false;
let baseStatus = null;
let mainWindow = null;
// The audio is measured by the engine, a separate program written in Rust (engine/), started and kept alive by the
// supervisor. A hidden window only plays the alarm sound.
let soundWin = null;
let soundReady = false;
let supervisor = null;
let engineBridge = null;
let tray = null;
let isQuitting = false;
let blockerId = null;
let lastStatus = null;
let updateInfo = null;
let trayKey = '';
let toggleWindowView = () => {}; // set in registerIpc: switches the compact view or always on top

const lang = () => store.getSettings().language;
const sendUi = (channel, data) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
};

// ---- secrets at rest: OS keystore (DPAPI / Keychain / libsecret) ---------------------
const PREFIX = 'enc:v1:';
const canSeal = () => {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
};
const seal = (v) => (typeof v !== 'string' || !v || v.startsWith(PREFIX) || !canSeal() ? v : PREFIX + safeStorage.encryptString(v).toString('base64'));
const open = (v) => {
  if (typeof v !== 'string' || !v.startsWith(PREFIX)) return v;
  try {
    return safeStorage.decryptString(Buffer.from(v.slice(PREFIX.length), 'base64'));
  } catch {
    return ''; // keystore changed (other user or computer): the secret must be typed again
  }
};

// ---- audio engine (Rust, separate process) --------------------------------------------------
// The engine reads the sound cards and decodes the streams itself: no browser limit on the number of streams, no
// permission prompt of the web engine. If it ends by itself the supervisor starts it again with the same inputs.
const engine = {
  sync: (list) => engineBridge?.sync(list),
  stop: () => engineBridge?.stop()
};

// The logos: files of earlier versions (named after their input) are given to their inputs, pictures stored more than once
// (a file for each stream of a station) are merged into one, and a file no input uses is deleted. Returns the settings.
function tidyLogos() {
  let { inputs, stations } = store.getSettings();
  const adopted = adoptLegacy(inputs, logos.ids());
  if (adopted) inputs = adopted;
  const merged = mergeDuplicates(inputs, logos.hashes(), stations);
  if (merged) ({ inputs, stations } = merged);
  const next = adopted || merged ? store.updateSettings({ inputs, stations }) : store.getSettings();
  logos.prune(keepIds(next.inputs, next.stations));
  if (merged) clog(`${merged.remove.length} logo(s) that were the same picture merged into one`, 'info', 'logos');
  return next;
}

// A configuration saved by the previous version (or imported from a backup of it) holds the device ids of the browser
// engine. Those inputs are found again by the name of the card, and only when exactly one device has it: the new id
// is saved, so the settings window shows the card as chosen. A card that is not found stays as it is, marked "not found".
let applySettingsChanged = () => {};
function migrateDeviceIds(devices) {
  if (!store) return;
  let changed = 0;
  const inputs = store.getSettings().inputs.map((i) => {
    if (i.type !== 'device' || !i.deviceId) return i;
    const r = resolveDevice(i.deviceId, i.deviceLabel, devices);
    if (r.via !== 'label' || r.id === i.deviceId) return i;
    changed++;
    return { ...i, deviceId: r.id };
  });
  if (!changed) return;
  clog(`${changed} sound card(s) found again by name: their ids were updated`, 'info', 'engine');
  applySettingsChanged(store.updateSettings({ inputs }));
}

function startEngine() {
  const binary = findEngine({ resourcesPath: process.resourcesPath, rootDir: __dirname });
  if (!binary) {
    clog('audio engine not found: nothing can be measured', 'error', 'engine');
    return;
  }
  supervisor = new EngineSupervisor({ binary });
  engineBridge = createEngineBridge({
    supervisor,
    getMonitor: () => monitor,
    getLabel: (id) => store.getSettings().inputs.find((i) => i.id === id)?.deviceLabel || '',
    getName: (id) => {
      const s = store.getSettings();
      const inp = s.inputs.find((i) => i.id === id);
      return inp ? inputLabel(s.language, inp, s.stations) : '';
    },
    onDevices: migrateDeviceIds,
    log: (m, level) => clog(m, level, 'engine')
  });
  // an engine that cannot start for a reason the person can fix (Linux without libasound2): said in the window, until it runs
  supervisor.on('exit', (info) => setEngineProblem(engineProblem(info)));
  supervisor.on('event', (ev) => ev.event === 'ready' && setEngineProblem(null));
  supervisor.start();
}
let currentEngineProblem = null;
function setEngineProblem(p) {
  if (JSON.stringify(p) === JSON.stringify(currentEngineProblem)) return;
  currentEngineProblem = p;
  if (p) clog(`audio engine cannot start: ${p.kind}${p.lib ? ' ' + p.lib : ''}`, 'error', 'engine');
  sendUi('event:engine-problem', p);
}

// ---- alarm sound (hidden window) ------------------------------------------------------------
function createSoundWindow() {
  soundReady = false;
  soundWin = new BrowserWindow({
    show: false,
    width: 200,
    height: 100,
    webPreferences: {
      preload: path.join(__dirname, 'sound-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });
  soundWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  soundWin.webContents.on('will-navigate', (e) => e.preventDefault());
  soundWin.loadFile(path.join(__dirname, 'renderer', 'sound.html'));
  // The alarm must never stay mute silently: a crashed or frozen window is replaced.
  const restart = (why) => {
    clog(`sound window restart: ${why}`, 'warn', 'engine');
    const old = soundWin;
    soundWin = null;
    soundReady = false;
    if (old && !old.isDestroyed()) old.destroy();
    if (!isQuitting) createSoundWindow();
  };
  soundWin.webContents.on('render-process-gone', (_e, d) => restart(d.reason));
  soundWin.on('unresponsive', () => restart('unresponsive'));
}

const sendSound = (payload) => {
  if (soundReady && soundWin && !soundWin.isDestroyed()) soundWin.webContents.send('sound:play', payload);
};

// ---- main window ------------------------------------------------------------------------
// the saved window is used only if it still lies on a screen that exists (a monitor may have been unplugged)
// Place and size saved for the window in the view it is in (normal or compact); the place only if it is still on a screen.
function savedBounds(compact = compactApplied) {
  const st = store.getSettings();
  const w = compact ? st.compactWindow : st.window;
  const height = compact && !w.height ? compactHeightFor(st.inputs.filter((i) => i.enabled).length) : w.height;
  const out = { width: w.width, height };
  if (w.x !== null && w.y !== null) {
    const visible = screen.getAllDisplays().some((d) => w.x + 80 > d.bounds.x && w.x < d.bounds.x + d.bounds.width - 80 && w.y >= d.bounds.y && w.y < d.bounds.y + d.bounds.height - 80);
    if (visible) {
      out.x = w.x;
      out.y = w.y;
    }
  }
  return out;
}

let boundsTimer = null;
let compactApplied = false; // the window is in the compact view (its size and smallest size are those of that view)
function rememberWindow() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized() || !mainWindow.isVisible() || mainWindow.isFullScreen()) return;
  const b = mainWindow.getNormalBounds(); // the place and size it has when not maximized
  if (compactApplied) {
    store.updateSettings({ compactWindow: { x: b.x, y: b.y, width: b.width, height: b.height } });
    return;
  }
  store.updateSettings({ window: { x: b.x, y: b.y, width: b.width, height: b.height, maximized: mainWindow.isMaximized() } });
}
const rememberWindowSoon = () => {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(rememberWindow, 600);
};

// Full screen reached two ways (F11 of the default menu, then the wall display) can leave the menu bar hidden on Windows.
// In the compact view the menu bar can be hidden on purpose (Settings, tray menu, right-click menu): then Alt shows it for a moment.
function restoreMenuBar() {
  if (process.platform === 'darwin') return;
  const show = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFullScreen()) return;
    const hide = menuBarHidden(store.getSettings().window, process.platform);
    mainWindow.setAutoHideMenuBar(hide);
    mainWindow.setMenuBarVisibility(!hide);
  };
  show();
  setTimeout(show, 150); // once the window has finished leaving full screen
}

// Application menu (Windows and Linux): rebuilt when the view or the language changes, so the checks of the Window menu are right.
let appMenuKey = '';
function applyAppMenu() {
  if (process.platform === 'darwin') return;
  const win = store ? store.getSettings().window : null;
  const key = `${store ? lang() : ''}|${win?.compact}|${win?.alwaysOnTop}`;
  if (key === appMenuKey) return;
  appMenuKey = key;
  const ctx = win ? { win, tr: (k) => t(lang(), k), act: { toggle: (k) => toggleWindowView(k) } } : undefined;
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(process.platform, ctx)));
  if (mainWindow && !mainWindow.isDestroyed()) restoreMenuBar(); // setting the menu shows the bar again: keep it hidden on purpose
}

// Zoom of the page ('in' | 'out' | 'reset'), the same one as Ctrl +, Ctrl - and Ctrl 0 of the View menu (Chromium remembers it).
function zoomWindow(direction) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  wc.setZoomLevel(direction === 'reset' ? 0 : nextZoomLevel(wc.getZoomLevel(), direction));
}

// Right-click menu of the compact view (also the way back to a hidden menu bar).
function showCompactContextMenu() {
  const win = store.getSettings().window;
  if (!win.compact || !mainWindow || mainWindow.isDestroyed()) return;
  Menu.buildFromTemplate(compactContextTemplate(win, (k) => t(lang(), k), { toggle: toggleWindowView, zoom: zoomWindow })).popup({ window: mainWindow });
}

// "Always on top" and the compact view follow the settings (the buttons of the window, the tray menu, a backup that is imported).
// Each view has its own size and place; the window goes back to those of the other one when the view changes.
function applyWindowMode(next) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const w = next.window;
  if (mainWindow.isAlwaysOnTop() !== w.alwaysOnTop) mainWindow.setAlwaysOnTop(w.alwaysOnTop, 'floating');
  if (w.compact === compactApplied || mainWindow.isFullScreen()) {
    if (!mainWindow.isFullScreen()) restoreMenuBar(); // the menu bar switch can change with the view unchanged
    return; // the wall display is full screen: the view changes after it
  }
  clearTimeout(boundsTimer);
  rememberWindow(); // the place of the view that is being left
  compactApplied = w.compact;
  const min = compactApplied ? COMPACT_MIN : NORMAL_MIN;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  mainWindow.setMinimumSize(min.width, min.height);
  const b = savedBounds();
  const cur = mainWindow.getBounds();
  mainWindow.setBounds({ x: b.x ?? cur.x, y: b.y ?? cur.y, width: b.width, height: b.height });
  if (!compactApplied && store.getSettings().window.maximized) mainWindow.maximize();
  restoreMenuBar();
}

function createWindow() {
  const settings = store.getSettings();
  compactApplied = settings.window.compact;
  const min = compactApplied ? COMPACT_MIN : NORMAL_MIN;
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    ...savedBounds(),
    minWidth: min.width,
    minHeight: min.height,
    alwaysOnTop: settings.window.alwaysOnTop,
    show: false,
    backgroundColor: '#0f1115',
    title: 'Dead Air Watchdog',
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('zoom-changed', (_e, direction) => zoomWindow(direction)); // Ctrl + mouse wheel
  mainWindow.webContents.on('context-menu', showCompactContextMenu);
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  const hidden = settings.general.startMinimized && app.getLoginItemSettings().wasOpenedAtLogin;
  mainWindow.once('ready-to-show', () => {
    if (settings.window.maximized && !compactApplied) mainWindow.maximize();
    restoreMenuBar();
    if (!hidden) mainWindow.show();
  });
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) mainWindow.on(ev, rememberWindowSoon);
  mainWindow.on('leave-full-screen', () => {
    if (wallBlockerId !== null) {
      powerSaveBlocker.stop(wallBlockerId);
      wallBlockerId = null;
    }
    restoreMenuBar();
    applyWindowMode(store.getSettings()); // a change of view asked for during the wall display
    sendUi('event:wall-exit');
  });
  for (const ev of ['show', 'restore']) mainWindow.on(ev, () => nowPlaying?.refresh()); // on screen again: the song titles are asked now
  mainWindow.on('close', (e) => {
    rememberWindow();
    if (isQuitting) return;
    e.preventDefault();
    mainWindow.hide();
    if (!store.getSettings().closeHintShown) {
      store.updateSettings({ closeHintShown: true });
      dialog.showMessageBox({ type: 'info', title: 'Dead Air Watchdog', message: t(lang(), 'closeHint.title'), detail: t(lang(), 'closeHint.detail'), buttons: ['OK'] }).catch(() => {});
    }
  });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  mainWindow.show();
  mainWindow.focus();
}

// ---- tray -------------------------------------------------------------------------------
function trayImage(state) {
  // macOS: the stopped state uses the single-colour menu-bar glyph (follows light / dark menu bar); the monitoring states keep their colour
  if (process.platform === 'darwin' && state === 'idle') {
    const glyph = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
    if (!glyph.isEmpty()) {
      glyph.setTemplateImage(true);
      return glyph;
    }
  }
  const file = path.join(__dirname, 'assets', `tray-${state}.png`);
  let img = nativeImage.createFromPath(file);
  if (img.isEmpty()) return nativeImage.createEmpty();
  if (process.platform === 'darwin') img = img.resize({ width: 16, height: 16, quality: 'best' });
  return img;
}

function updateTray(status) {
  if (!tray) return;
  const overall = status?.running ? status.overall : 'idle';
  const state = overall === 'starting' || overall === 'paused' ? 'idle' : overall;
  const wv = store.getSettings().window;
  const key = `${state}|${status?.running}|${lang()}|${status?.inputs?.length ?? 0}|${wv.compact}|${wv.alwaysOnTop}|${wv.hideMenuBar}`;
  if (key === trayKey) return;
  trayKey = key;
  tray.setImage(trayImage(state));
  const n = status?.inputs?.length || 0;
  tray.setToolTip(`Dead Air Watchdog — ${t(lang(), `tip.${overall}`)}${n > 1 ? ` (${n})` : ''}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t(lang(), 'tray.open'), click: showWindow },
      { label: status?.running ? t(lang(), 'tray.stop') : t(lang(), 'tray.start'), click: () => (status?.running ? stopMonitoring() : startMonitoring()) },
      { type: 'separator' },
      { label: t(lang(), 'tray.compact'), type: 'checkbox', checked: wv.compact, click: () => toggleWindowView('compact') },
      { label: t(lang(), 'tray.top'), type: 'checkbox', checked: wv.alwaysOnTop, click: () => toggleWindowView('alwaysOnTop') },
      ...(process.platform === 'darwin' ? [] : [{ label: t(lang(), 'tray.hideMenu'), type: 'checkbox', checked: wv.hideMenuBar, click: () => toggleWindowView('hideMenuBar') }]),
      { type: 'separator' },
      { label: t(lang(), 'tray.quit'), click: () => app.quit() }
    ])
  );
}

function createTray() {
  tray = new Tray(trayImage('idle'));
  tray.on('click', showWindow);
  updateTray({ running: false, overall: 'idle', inputs: [] });
}

// ---- monitoring ---------------------------------------------------------------------------
const hasUsableInput = (settings) => settings.inputs.some((i) => isUsable(i) && (i.type === 'stream' || settings.micExplained));

async function startMonitoring() {
  const s = store.getSettings();
  const usable = s.inputs.filter(isUsable);
  if (!usable.length) return { ok: false, reason: 'no-input' };
  if (usable.some((i) => i.type === 'device') && process.platform === 'darwin') {
    const granted = await systemPreferences.askForMediaAccess('microphone');
    if (!granted) return { ok: false, reason: 'mic-denied' };
  }
  monitor.start();
  heartbeat.start();
  applyKeepAwake();
  return { ok: true };
}

function stopMonitoring() {
  monitor.stop(true);
  heartbeat.stop();
  applyKeepAwake();
  return { ok: true };
}

function applyKeepAwake() {
  const want = monitor.isRunning() && store.getSettings().general.keepAwake;
  if (want && blockerId === null) blockerId = powerSaveBlocker.start('prevent-app-suspension');
  if (!want && blockerId !== null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
}

// Audible alarm: played by the sound window (always alive), stopped by recovery or by the user.
function applySound() {
  const snd = store.getSettings().notifications.sound;
  sendSound({ on: soundActive && !soundMuted && snd.enabled, volume: snd.volume });
}

function setAlarmSound(on) {
  soundActive = on;
  if (on) soundMuted = false;
  applySound();
  pushStatus();
}

// What the window gets: the monitor's status plus the state of the audible alarm.
function pushStatus(st = baseStatus) {
  if (!st) return;
  baseStatus = st;
  lastStatus = { ...st, soundPlaying: soundActive && !soundMuted && store.getSettings().notifications.sound.enabled };
  sendUi('event:status', lastStatus);
  updateTray(lastStatus);
}

function applyGeneralSettings(s) {
  nativeTheme.themeSource = s.theme === 'auto' ? 'system' : s.theme;
  // never register the development Electron binary as a login item
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!s.general.startOnBoot, openAsHidden: true });
  applyKeepAwake();
}

function desktopNotify(kind, d) {
  const s = store.getSettings();
  if (!s.notifications.desktop || !Notification.isSupported()) return;
  const body = kind === 'alarm' ? t(s.language, 'desktop.alarm', { input: d.input }) : t(s.language, 'desktop.recovered', { input: d.input, duration: formatDuration(d.durationMs) });
  const n = new Notification({ title: alertPrefix(s, os.hostname()).slice(1, -1), body, urgency: kind === 'alarm' ? 'critical' : 'normal' });
  n.on('click', showWindow);
  n.show();
}

// New version: email / Telegram, once per version and per channel (see src/update-notice.js)
function announceUpdate() {
  if (updateInfo?.available) updateNotice?.announce(updateInfo).catch((err) => clog(err.message, 'warn', 'update-notice'));
}

// ---- guided update (apps/COMMON-FEATURES.md, section 4) ------------------------------------------------------
let downloadedFile = null;
let downloadedFor = null;
let downloadAbort = null;
// what the window may know: the installer's name and size, never a URL
const publicInfo = (info) => info && { ...info, installer: info.installer ? { name: info.installer.name, size: info.installer.size } : null, sumsUrl: undefined, canDownload: !!(info.installer && info.sumsUrl) };
const updateView = (info) => ({ info: publicInfo(info), banner: bannerState(info, store.getSettings().updateState), lastCheck: store.getSettings().updateState.lastCheck, downloaded: downloadedFile && info?.available ? path.basename(downloadedFile) : null });
const setUpdateState = (patch) => store.updateSettings({ updateState: { ...store.getSettings().updateState, ...patch } });

function checkUpdatesNow(manual) {
  const s = store.getSettings();
  // Always this version's own repository (src/updater.js). Not the `updateRepo` setting: a backup imported from the public
  // Dead Air Watchdog carries that one, and this test version would offer its releases (26.11.3) as an update.
  return checkForUpdate({ repo: REPO, current: app.getVersion(), fetchFn: (u, o) => net.fetch(u, o) }).then((r) => {
    if (r.ok) updateInfo = r;
    if (downloadedFor && (!r.ok || r.latest !== downloadedFor)) {
      downloadedFile = null; // a newer release came out: download again
      downloadedFor = null;
    }
    setUpdateState({ lastCheck: { at: Date.now(), ok: !!r.ok, error: r.ok ? '' : String(r.error || '') } });
    if (r.ok && r.available) {
      sendUi('event:update-available', updateView(r));
      announceUpdate();
    }
    return updateView(r);
  });
}

// ---- IPC (the window talks only through these) ---------------------------------------------
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!mainWindow || e.sender !== mainWindow.webContents) throw new Error('forbidden sender');
    return fn(...args);
  });
}

const EXTERNAL_OK = [/^https:\/\/onairgarage\.com(\/|$)/, /^https:\/\/github\.com\/djgragra\/dead-air-watchdog(\/|$)/, /^mailto:hello@onairgarage\.com$/];

function registerIpc() {
  handle('settings:get', () => store.getSettings());
  handle('delivery:get', () => faultList());
  // everything that has to follow a change of the settings (also used by the backup import)
  function settingsChanged(next) {
    logos.prune(keepIds(next.inputs, next.stations)); // logos no input and no station uses any more
    applyGeneralSettings(next);
    applyWindowMode(next);
    monitor.syncInputs(); // inputs added, removed or edited while monitoring
    nowPlaying?.tick(); // a title switched on (or off) in the settings is asked for (or dropped) now
    if (!monitor.isRunning()) heartbeat.stop();
    heartbeat.restart();
    applyKeepAwake();
    applySound();
    pushStatus();
    trayKey = '';
    updateTray(lastStatus);
    applyAppMenu();
    sendUi('event:settings-changed', next);
    announceUpdate(); // a channel switched on now hears about a version it has not been told yet
    return next;
  }
  applySettingsChanged = settingsChanged;
  handle('settings:update', (patch) => settingsChanged(store.updateSettings(patch)));
  // compact view and always on top: one button each in the window, one item each in the tray menu; both are remembered
  toggleWindowView = (key) => settingsChanged(store.updateSettings({ window: { [key]: !store.getSettings().window[key] } }));
  handle('window:view', (key, on) => {
    if (key !== 'compact' && key !== 'alwaysOnTop' && key !== 'hideMenuBar') throw new Error('unknown view');
    return settingsChanged(store.updateSettings({ window: { [key]: !!on } }));
  });

  // ---- configuration backup ----
  handle('backup:export', async (includeSecrets, includeLogos) => {
    includeSecrets = includeSecrets === true;
    includeLogos = includeLogos !== false;
    try {
      // built first: a file that is too big is refused before the person is asked where to save it
      const file = buildExport(store.getSettings(), { includeSecrets, logos: includeLogos ? logos.all() : {} });
      const text = JSON.stringify(file, null, 2);
      const size = Buffer.byteLength(text);
      // what is exported can always be imported: the same limit applies to both
      if (backupTooBig(text)) return { ok: false, error: file.logos ? 'too-big-logos' : 'too-big', size, limit: MAX_BACKUP_BYTES };
      const r = await dialog.showSaveDialog(mainWindow, { defaultPath: path.join(app.getPath('documents'), backupFileName()), filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(r.filePath, text, { mode: includeSecrets ? 0o600 : 0o644 });
      if (includeSecrets) fs.chmodSync(r.filePath, 0o600); // also when the file already existed
      return { ok: true, file: r.filePath, includesSecrets: includeSecrets, inputs: file.inputs.length, logos: Object.keys(file.logos || {}).length, size };
    } catch (err) {
      return { ok: false, error: String(err.message).slice(0, 300) };
    }
  });
  handle('backup:import', async (mode) => {
    mode = mode === 'add' ? 'add' : 'replace';
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths?.[0]) return { ok: false, canceled: true };
    try {
      if (fs.statSync(r.filePaths[0]).size > MAX_BACKUP_BYTES) return { ok: false, error: 'too-big' };
      const plan = prepareImport(fs.readFileSync(r.filePaths[0], 'utf8'), store.getSettings(), { mode });
      if (!plan.ok) return plan;
      // the logos first: the window reads them again when the settings change
      const have = new Set(logos.ids());
      for (const [id, url] of Object.entries(plan.logos || {})) {
        if (mode === 'add' && have.has(id)) continue; // adding inputs never changes a logo that is already here
        try { logos.set(id, url); } catch { /* left out */ }
      }
      // logos copied by hand (a file named after its input) are given to their inputs, and equal pictures merged, before the
      // clean-up of settingsChanged
      store.updateSettings(plan.settings);
      settingsChanged(tidyLogos());
      return { ok: true, mode, missing: plan.missing, added: plan.added, logos: Object.keys(plan.logos || {}).length };
    } catch (err) {
      return { ok: false, error: String(err.message).slice(0, 300) };
    }
  });

  handle('monitor:start', startMonitoring);
  handle('monitor:stop', stopMonitoring);
  handle('monitor:status', () => ({ ...monitor.status(), soundPlaying: lastStatus?.soundPlaying ?? false }));
  handle('nowplaying:get', () => nowPlaying.get());
  handle('snmp:trap-state', () => snmpWatcher?.trapState() ?? { state: 'off' });

  handle('logos:all', () => logos.all());
  // deletes a logo and takes it off the inputs that used it
  handle('logos:delete', (id) => {
    try {
      logos.remove(String(id || ''));
    } catch {
      return { ok: false };
    }
    const { inputs, stations } = store.getSettings();
    if (inputs.some((i) => i.logo === id) || stations.some((st) => st.logo === id)) {
      const off = (x) => (x.logo === id ? { ...x, logo: '' } : x);
      settingsChanged(store.updateSettings({ inputs: inputs.map(off), stations: stations.map(off) }));
    }
    return { ok: true };
  });
  handle('logos:add', (dataUrl) => {
    try {
      return { ok: true, id: logos.add(dataUrl) };
    } catch {
      return { ok: false };
    }
  });

  handle('alarm:mute', () => {
    soundMuted = true;
    applySound();
    pushStatus();
  });
  handle('audio:test-sound', (volume) => {
    sendSound({ on: true, test: true, volume });
  });
  handle('heartbeat:test', (url) => heartbeat.ping(typeof url === 'string' ? url.trim() : ''));

  handle('events:list', () => store.listEvents().sort((a, b) => b.start - a.start));
  handle('events:clear', () => {
    store.clearEvents();
    sendUi('event:events-changed');
  });
  handle('events:export', async (format) => {
    const events = store.listEvents().sort((a, b) => a.start - b.start);
    const ext = format === 'json' ? 'json' : 'csv';
    const stamp = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(mainWindow, { defaultPath: path.join(app.getPath('documents'), `dead-air-log-${stamp}.${ext}`), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    const common = findCommonProblems(events, { totalInputs: store.getSettings().inputs.length }).eventIds;
    fs.writeFileSync(r.filePath, ext === 'json' ? toJson(events, { version: app.getVersion() }, common) : toCsv(events, common));
    return { ok: true, file: r.filePath, count: events.length };
  });
  // Availability per input over a period, and the moments when several inputs went down together (src/core/report.js).
  const reportFor = (period) => {
    const s = store.getSettings();
    const kind = ['thisMonth', 'lastMonth', 'last7', 'last30'].includes(period) ? period : 'thisMonth';
    const range = periodRange(kind, Date.now());
    const inputs = s.inputs.map((i) => ({ id: i.id, name: inputLabel(s.language, i, s.stations), schedule: i.schedule }));
    return { kind, report: buildReport(store.listEvents(), inputs, range) };
  };
  handle('report:get', (period) => {
    const { kind, report } = reportFor(period);
    return { kind, ...report };
  });
  handle('report:export', async (period) => {
    const { kind, report } = reportFor(period);
    const stamp = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(mainWindow, { defaultPath: path.join(app.getPath('documents'), `dead-air-summary-${kind}-${stamp}.csv`), filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, reportToCsv(report));
    return { ok: true, file: r.filePath, count: report.rows.length };
  });
  handle('stats:daily', (days, inputId) => aggregateDeadAir(store.listEvents().filter((e) => !inputId || e.inputId === inputId), [7, 14, 30].includes(days) ? days : 7, Date.now()));

  // Wall display: full screen, screen kept on (a control-room monitor must not blank out).
  handle('wall:set', (on) => {
    on = !!on;
    mainWindow.setFullScreen(on);
    if (on && wallBlockerId === null) wallBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    if (!on && wallBlockerId !== null) {
      powerSaveBlocker.stop(wallBlockerId);
      wallBlockerId = null;
    }
  });

  handle('audio:access-status', () => (process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : 'granted'));
  // how many channels a device really has (null when it cannot be opened): the channel choices show only those
  handle('audio:channels', async (deviceId) => {
    try { return (await engineBridge?.channels(String(deviceId || '').slice(0, 300))) ?? null; } catch { return null; }
  });
  handle('audio:devices', async () => {
    if (process.platform === 'darwin' && !(await systemPreferences.askForMediaAccess('microphone'))) return { granted: false, devices: [] };
    try { return { granted: true, devices: (await engineBridge?.devices()) ?? [] }; } catch { return { granted: true, devices: [] }; }
  });

  handle('notify:test', async (channel, cfg) => {
    const l = lang();
    try {
      if (channel === 'email') await sendEmail({ ...cfg, enabled: true }, t(l, 'test.subject'), t(l, 'test.body'), l);
      else if (channel === 'webhook') {
        const st = store.getSettings();
        const now = Date.now();
        await sendWebhook({ ...cfg, enabled: true }, { event: { kind: 'test', items: [{ input: 'Test', cause: 'silence', start: now - 45_000, end: null, durationMs: 45_000 }] }, subject: t(l, 'test.subject'), text: t(l, 'test.body'), installation: installationName(st, os.hostname()), host: os.hostname(), version: app.getVersion(), now }, l, (u, o) => net.fetch(u, o));
      }
      else await sendTelegram({ ...cfg, enabled: true }, t(l, 'test.body'), l, (u, o) => net.fetch(u, o));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message).slice(0, 400) };
    }
  });

  handle('update:check', () => checkUpdatesNow(true));
  handle('update:state', () => updateView(updateInfo));
  handle('update:download', async () => {
    if (!updateInfo?.available) return { ok: false, error: 'no-update' };
    if (downloadAbort) return { ok: false, error: 'busy' };
    downloadAbort = new AbortController();
    try {
      sweepPartials(app.getPath('downloads')); // leftovers of an earlier interrupted download
      downloadedFile = await downloadInstaller({
        info: updateInfo,
        dir: app.getPath('downloads'),
        fetchFn: (u, o) => net.fetch(u, o),
        current: app.getVersion(),
        signal: downloadAbort.signal,
        onProgress: (got, total) => sendUi('event:update-progress', { got, total })
      });
      downloadedFor = updateInfo.latest;
      clog(`update ${updateInfo.latest} downloaded and verified (SHA-256)`, 'info', 'update');
      return { ok: true, file: path.basename(downloadedFile) };
    } catch (err) {
      downloadedFile = null;
      downloadedFor = null;
      const cancelled = downloadAbort?.signal.aborted;
      if (!cancelled) clog(`update download failed: ${err.message}`, 'warn', 'update');
      return { ok: false, error: cancelled ? 'cancelled' : err.message };
    } finally {
      downloadAbort = null;
    }
  });
  handle('update:cancel', () => {
    downloadAbort?.abort();
    return true;
  });
  handle('update:remind', () => {
    setUpdateState(remindLaterState(store.getSettings().updateState));
    return updateView(updateInfo);
  });
  handle('update:skip', () => {
    setUpdateState(skipVersionState(store.getSettings().updateState, updateInfo?.latest));
    return updateView(updateInfo);
  });
  // "Close and install": monitoring stops until the app is open again, so it asks first; a safety copy of the settings goes first
  handle('update:install', (confirmed) => {
    if (!downloadedFile || !fs.existsSync(downloadedFile)) return { ok: false, error: 'no-file' };
    if (monitor.isRunning() && confirmed !== true) return { ok: false, error: 'confirm', running: true };
    store.flush();
    try {
      makeSafetyCopy({ file: settingsFile(), dir: path.join(app.getPath('userData'), 'backups'), version: updateInfo?.current || app.getVersion() });
    } catch (err) {
      return { ok: false, error: `safety copy: ${err.message}` };
    }
    const plan = installPlan(process.platform, downloadedFile);
    clog(`installing update ${updateInfo?.latest || ''} (${plan.kind})`, 'info', 'update');
    if (plan.kind === 'run-installer') {
      spawn(plan.file, [], { detached: true, stdio: 'ignore' }).unref();
      isQuitting = true; // really quits: no hiding in the tray
      setTimeout(() => app.quit(), 300);
    } else if (plan.kind === 'open-image') shell.openPath(plan.file);
    else shell.showItemInFolder(plan.file);
    return { ok: true, kind: plan.kind, hint: plan.hint || null, quit: plan.quit };
  });
  handle('update:reveal', () => {
    if (downloadedFile && fs.existsSync(downloadedFile)) shell.showItemInFolder(downloadedFile);
  });
  handle('update:open-page', () => {
    if (updateInfo?.url) shell.openExternal(pageUrl(undefined, lang()));
  });
  // after a start of a newer version: the window with what changed, once
  handle('whatsnew:get', () => {
    if (startKind !== 'updated') return null;
    let text = '';
    try {
      text = fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8');
    } catch {
      /* not packaged */
    }
    const nw = whatsNew(text, app.getVersion()) || { version: app.getVersion(), date: '', bullets: [] };
    return { ...nw, intro: !store.getSettings().engineIntroSeen }; // the new engine and the stations: said once, to the ones who update
  });
  handle('engine:problem', () => currentEngineProblem);
  handle('whatsnew:seen', () => {
    startKind = 'same';
    store.updateSettings({ lastSeenVersion: app.getVersion(), engineIntroSeen: true });
    return true;
  });

  // maintenance of one input: mode '1h' | 'tomorrow' (next 06:00) | 'off'
  handle('monitor:pause', (inputId, mode) => {
    if (typeof inputId !== 'string') return { ok: false };
    if (mode === 'off') return monitor.resumeInput(inputId, 'manual');
    const t0 = Date.now();
    let until = t0 + 3_600_000;
    if (mode === 'tomorrow') {
      const d = new Date(t0);
      d.setDate(d.getDate() + 1);
      d.setHours(6, 0, 0, 0);
      until = d.getTime();
    } else if (mode !== '1h') return { ok: false };
    return monitor.pauseInput(inputId, until);
  });

  // Help & About: what to send to whoever helps. Never settings values, addresses, tokens, recipients or file names the user chose.
  handle('app:support-info', () => {
    const s = store.getSettings();
    const lastError = logger.entries().filter((e) => e.level === 'error').at(-1);
    return buildSupportInfo({
      app: 'Dead Air Watchdog',
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      language: s.language,
      installationName: installationName(s, os.hostname()),
      lastCheck: s.updateState.lastCheck,
      lastError,
      home: os.homedir()
    });
  });
  handle('logs:open-folder', () => shell.openPath(path.join(app.getPath('userData'), 'logs')));

  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, arch: process.arch, packaged: app.isPackaged, host: os.hostname(), logsDir: path.join(app.getPath('userData'), 'logs') }));
  handle('app:open-external', (url) => {
    if (typeof url === 'string' && EXTERNAL_OK.some((re) => re.test(url))) shell.openExternal(url);
  });

}

// ---- start-up ----------------------------------------------------------------------------------
app.on('second-instance', showWindow);

// After a start of a newer version: a notice, and the window with what changed (once)
let startKind = 'same';
function announceStartup() {
  const s = store.getSettings();
  startKind = startupKind(s.lastSeenVersion, app.getVersion(), hadSettingsFile);
  if (startKind === 'first') store.updateSettings({ lastSeenVersion: app.getVersion() });
  else if (startKind === 'updated' && Notification.isSupported()) {
    const n = new Notification({ title: alertPrefix(s, os.hostname()).slice(1, -1), body: t(s.language, 'desktop.updatedTo', { version: app.getVersion() }) });
    n.on('click', showWindow);
    n.show();
  }
}

app.whenReady().then(() => {
  applyAppMenu(); // the default menu without the "Zoom" entry that does nothing (the Window menu gets its switches once the settings are loaded)
  hadSettingsFile = fs.existsSync(settingsFile());
  store = createStore({ file: settingsFile(), seal, open });
  // rewrite secrets saved before the keystore was available
  store.updateSettings({});
  store.flush();

  logos = createLogos(path.join(app.getPath('userData'), 'logos'));
  tidyLogos(); // logos made before the library, the same picture stored many times, files nobody uses
  alertState = createAlertState({ file: path.join(app.getPath('userData'), 'alert-state.json') });
  updateNotice = createUpdateNotice({
    getSettings: () => store.getSettings(),
    alertState,
    send: (channel, subject, text) => {
      const st = store.getSettings();
      const prefix = alertPrefix(st, os.hostname());
      return channel === 'email' ? sendEmail({ ...st.notifications.email, enabled: true }, withPrefix(subject, prefix), text, st.language) : sendTelegram({ ...st.notifications.telegram, enabled: true }, text, st.language, (u, o) => net.fetch(u, o), prefix);
    },
    notifyDesktop: (body) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: 'Dead Air Watchdog', body });
      n.on('click', showWindow);
      n.show();
    },
    log: (m, level) => clog(m, level, 'update-notice')
  });
  dispatcher = createDispatcher({
    getSettings: () => store.getSettings(),
    host: os.hostname(),
    version: app.getVersion(),
    onResult: (r) => {
      if (r.ok) deliveryFaults.delete(r.channel);
      else deliveryFaults.set(r.channel, { error: r.error, giveUp: !!r.giveUp, label: r.label, at: Date.now() });
      sendUi('event:delivery', faultList());
    },
    log: (m, level) => clog(m, level, 'notify') });
  // SNMP inputs: the watcher asks the devices (and takes their traps) and tells the monitor
  snmpWatcher = createSnmpWatcher({
    onResult: (id, r) => monitor?.onSnmp(id, r),
    onTrap: (id, v) => monitor?.onSnmpTrap(id, v),
    log: (m, level) => clog(m, level, 'snmp')
  });
  monitor = createMonitor({
    store,
    engine,
    snmp: snmpWatcher,
    dispatch: (msg) => dispatcher.dispatch(msg),
    publish: {
      status: (st) => pushStatus(st),
      levels: (l) => {
        if (mainWindow?.isVisible()) sendUi('event:levels', l);
      },
      events: () => sendUi('event:events-changed')
    },
    desktopNotify,
    alarmSound: setAlarmSound,
    host: os.hostname(),
    log: (m, level) => clog(m, level, 'monitor')
  });

  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')));

  ipcMain.on('sound:ready', (e) => {
    if (!soundWin || soundWin.isDestroyed() || e.sender !== soundWin.webContents) return;
    soundReady = true;
    applySound();
  });

  heartbeat = createHeartbeat({ getSettings: () => store.getSettings(), fetchFn: (u, o) => net.fetch(u, o), version: app.getVersion(), log: (m, level) => clog(m, level, 'heartbeat') });
  // song titles of the streams that asked for them (ICY metadata): asked only while monitoring and while the window is on screen
  nowPlaying = createNowPlaying({
    getSettings: () => store.getSettings(),
    isActive: () => monitor.isRunning() && !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized(),
    fetchFn: (u, o) => net.fetch(u, o),
    publish: (m) => sendUi('event:now-playing', m),
    log: (m, level) => clog(m, level, 'now-playing')
  });
  nowPlaying.start();
  registerIpc();
  createSoundWindow();
  startEngine();
  createWindow();
  createTray();
  applyAppMenu(); // now with the settings: the Window menu gets "Compact view" and "Always on top"
  applyGeneralSettings(store.getSettings());

  clog(`Dead Air Watchdog ${app.getVersion()} started (${process.platform} ${process.arch}, Electron ${process.versions.electron})`, 'info', 'app');
  logger.prune();
  sweepPartials(app.getPath('downloads'));
  announceStartup();
  monitor.recoverFromPreviousRun();
  const prune = () => {
    const g = store.getSettings().general;
    store.pruneEvents(g.retentionDays, { blipDays: g.microRetentionDays });
    logger.prune();
  };
  prune();
  setInterval(prune, 6 * 3600_000);

  const s = store.getSettings();
  if (s.general.autoStartMonitoring && hasUsableInput(s)) startMonitoring();

  if (s.general.checkUpdates) {
    setTimeout(() => checkUpdatesNow(false), 20_000);
    setInterval(() => store.getSettings().general.checkUpdates && checkUpdatesNow(false), 24 * 3600_000);
  }

  app.on('activate', showWindow);
});

app.on('before-quit', () => {
  isQuitting = true;
  try {
    monitor?.stop(true);
    heartbeat?.stop();
    nowPlaying?.stop();
    snmpWatcher?.stop();
    dispatcher?.cancelPending();
    engineBridge?.shutdown();
    store?.flush();
  } catch (err) {
    clog(String(err?.stack || err), 'error', 'quit');
  }
});

// Closing the window keeps monitoring: the app lives in the tray until "Quit".
app.on('window-all-closed', () => {});
