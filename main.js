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
import { checkForUpdate, pageUrl, downloadInstaller, sweepPartials, bannerState, remindLaterState, skipVersionState, makeSafetyCopy, installPlan, whatsNew, startupKind } from './src/updater.js';
import { createLogger } from './src/logs.js';
import { buildSupportInfo } from './src/support.js';
import { createAlertState } from './src/alert-state.js';
import { createUpdateNotice } from './src/update-notice.js';
import { buildExport, prepareImport, backupFileName, MAX_BACKUP_BYTES } from './src/backup.js';
import { createHeartbeat } from './src/heartbeat.js';
import { createLogos } from './src/logos.js';
import { engineHandlers } from './src/engine-events.js';
import { shardInputs } from './src/engine-shards.js';
import { aggregateDeadAir } from './src/core/stats.js';
import { buildReport, findCommonProblems, periodRange, reportToCsv } from './src/core/report.js';
import { toCsv, toJson } from './src/core/export.js';
import { formatDuration } from './src/core/format.js';
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
let logos;
let wallBlockerId = null;
let soundActive = false;
let soundMuted = false;
let baseStatus = null;
let mainWindow = null;
// Audio engine windows: [0] also owns the sound card, the alarm sound and the device list; the others only open
// streams (see src/engine-shards.js). Each has { index, win, ready, pending }.
const engines = [];
const engineOf = (sender) => engines.find((e) => e.win && !e.win.isDestroyed() && e.win.webContents === sender);
const isEngineContents = (id) => engines.some((e) => e.win && !e.win.isDestroyed() && e.win.webContents.id === id);
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

// ---- audio engine (hidden windows) ------------------------------------------------------
// The CORS header Web Audio needs is added to media responses of engine windows only, and only the first one
// may use the microphone. Every extra window has its own session (its own connection pool).
const configuredSessions = new WeakSet();
function configureEngineSession(ses, allowMic) {
  if (configuredSessions.has(ses)) return;
  configuredSessions.add(ses);
  ses.setPermissionRequestHandler((wc, permission, cb, details) => cb(allowMic && permission === 'media' && !!wc && engines[0]?.win?.webContents === wc && !(details.mediaTypes || []).includes('video')));
  ses.setPermissionCheckHandler((wc, permission) => allowMic && permission === 'media' && !!wc && engines[0]?.win?.webContents === wc);
  // Stream servers rarely send CORS headers; without them a Web Audio graph is fed silence.
  ses.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'] }, (details, cb) => {
    if (details.resourceType !== 'media' || !isEngineContents(details.webContentsId)) return cb({});
    const headers = { ...details.responseHeaders };
    for (const k of Object.keys(headers)) if (k.toLowerCase() === 'access-control-allow-origin') delete headers[k];
    headers['Access-Control-Allow-Origin'] = ['*'];
    cb({ responseHeaders: headers });
  });
}

function createEngineWindow(index) {
  const partition = index === 0 ? undefined : `engine-${index}`;
  const eng = { index, win: null, ready: false, pending: null };
  engines[index] = eng;
  configureEngineSession(partition ? session.fromPartition(partition) : session.defaultSession, index === 0);
  eng.win = new BrowserWindow({
    show: false,
    width: 200,
    height: 100,
    webPreferences: {
      preload: path.join(__dirname, 'engine-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      ...(partition ? { partition } : {})
    }
  });
  eng.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  eng.win.webContents.on('will-navigate', (e) => e.preventDefault());
  eng.win.loadFile(path.join(__dirname, 'renderer', 'engine.html'));
  // The engine must never stay dead silently: a crashed or frozen renderer is replaced.
  const restart = (why) => {
    clog(`engine ${index} restart: ${why}`, 'warn', 'engine');
    const old = eng.win;
    eng.win = null;
    if (old && !old.isDestroyed()) old.destroy();
    if (isQuitting) return;
    const fresh = createEngineWindow(index);
    monitor?.engineRestarted();
    if (monitor?.isRunning()) fresh.pending = shardInputs(monitor.engineList())[index] || [];
  };
  eng.win.webContents.on('render-process-gone', (_e, d) => restart(d.reason));
  eng.win.on('unresponsive', () => restart('unresponsive'));
  return eng;
}

function closeEngine(index) {
  const eng = engines[index];
  if (!eng) return;
  engines[index] = undefined;
  if (eng.win && !eng.win.isDestroyed()) eng.win.destroy();
  while (engines.length && !engines[engines.length - 1]) engines.pop();
}

const sendEngine = (eng, channel, payload) => {
  if (eng?.ready && eng.win && !eng.win.isDestroyed()) eng.win.webContents.send(channel, payload);
};

const engine = {
  // list: every input the engine must open; each window gets its share, windows that are no longer needed close
  sync(list) {
    const shards = shardInputs(list);
    shards.forEach((inputs, index) => {
      const eng = engines[index] || createEngineWindow(index);
      eng.pending = inputs;
      sendEngine(eng, 'engine:sync', inputs);
    });
    for (let index = engines.length - 1; index >= shards.length; index--) closeEngine(index);
  },
  stop() {
    for (const eng of engines) {
      if (!eng) continue;
      eng.pending = null;
      sendEngine(eng, 'engine:stop');
    }
    for (let index = engines.length - 1; index >= 1; index--) closeEngine(index);
  }
};

let rpcSeq = 0;
const rpcWaiting = new Map();
function engineRpc(op, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const eng = engines[0];
    if (!eng?.ready || !eng.win) return reject(new Error('engine-not-ready'));
    const id = ++rpcSeq;
    const timer = setTimeout(() => {
      rpcWaiting.delete(id);
      reject(new Error('timeout'));
    }, timeoutMs);
    rpcWaiting.set(id, { resolve, reject, timer });
    eng.win.webContents.send('engine:rpc', { id, op });
  });
}

// messages from any engine window
function fromEngine(channel, handler) {
  ipcMain.on(channel, (e, ...args) => {
    const eng = engineOf(e.sender);
    if (!eng) return;
    handler(...args);
  });
}

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
function restoreMenuBar() {
  if (process.platform === 'darwin') return;
  const show = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFullScreen()) return;
    mainWindow.setAutoHideMenuBar(false);
    mainWindow.setMenuBarVisibility(true);
  };
  show();
  setTimeout(show, 150); // once the window has finished leaving full screen
}

// "Always on top" and the compact view follow the settings (the buttons of the window, the tray menu, a backup that is imported).
// Each view has its own size and place; the window goes back to those of the other one when the view changes.
function applyWindowMode(next) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const w = next.window;
  if (mainWindow.isAlwaysOnTop() !== w.alwaysOnTop) mainWindow.setAlwaysOnTop(w.alwaysOnTop, 'floating');
  if (w.compact === compactApplied || mainWindow.isFullScreen()) return; // the wall display is full screen: the view changes after it
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
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  const hidden = settings.general.startMinimized && app.getLoginItemSettings().wasOpenedAtLogin;
  mainWindow.once('ready-to-show', () => {
    if (settings.window.maximized && !compactApplied) mainWindow.maximize();
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
  const key = `${state}|${status?.running}|${lang()}|${status?.inputs?.length ?? 0}|${wv.compact}|${wv.alwaysOnTop}`;
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

// Audible alarm: played by the engine window (always alive), stopped by recovery or by the user.
function applySound() {
  const snd = store.getSettings().notifications.sound;
  sendEngine(engines[0], 'engine:sound', { on: soundActive && !soundMuted && snd.enabled, volume: snd.volume });
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
  return checkForUpdate({ repo: s.general.updateRepo, current: app.getVersion(), fetchFn: (u, o) => net.fetch(u, o) }).then((r) => {
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
    logos.prune(next.inputs.map((i) => i.id)); // logos of removed inputs
    applyGeneralSettings(next);
    applyWindowMode(next);
    monitor.syncInputs(); // inputs added, removed or edited while monitoring
    if (!monitor.isRunning()) heartbeat.stop();
    heartbeat.restart();
    applyKeepAwake();
    applySound();
    pushStatus();
    trayKey = '';
    updateTray(lastStatus);
    sendUi('event:settings-changed', next);
    announceUpdate(); // a channel switched on now hears about a version it has not been told yet
    return next;
  }
  handle('settings:update', (patch) => settingsChanged(store.updateSettings(patch)));
  // compact view and always on top: one button each in the window, one item each in the tray menu; both are remembered
  toggleWindowView = (key) => settingsChanged(store.updateSettings({ window: { [key]: !store.getSettings().window[key] } }));
  handle('window:view', (key, on) => {
    if (key !== 'compact' && key !== 'alwaysOnTop') throw new Error('unknown view');
    return settingsChanged(store.updateSettings({ window: { [key]: !!on } }));
  });

  // ---- configuration backup ----
  handle('backup:export', async (includeSecrets) => {
    includeSecrets = includeSecrets === true;
    const r = await dialog.showSaveDialog(mainWindow, { defaultPath: path.join(app.getPath('documents'), backupFileName()), filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    try {
      const file = buildExport(store.getSettings(), { includeSecrets });
      fs.writeFileSync(r.filePath, JSON.stringify(file, null, 2), { mode: includeSecrets ? 0o600 : 0o644 });
      if (includeSecrets) fs.chmodSync(r.filePath, 0o600); // also when the file already existed
      return { ok: true, file: r.filePath, includesSecrets: includeSecrets, inputs: file.inputs.length };
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
      settingsChanged(store.updateSettings(plan.settings));
      return { ok: true, mode, missing: plan.missing, added: plan.added };
    } catch (err) {
      return { ok: false, error: String(err.message).slice(0, 300) };
    }
  });

  handle('monitor:start', startMonitoring);
  handle('monitor:stop', stopMonitoring);
  handle('monitor:status', () => ({ ...monitor.status(), soundPlaying: lastStatus?.soundPlaying ?? false }));

  handle('logos:all', () => logos.all());
  handle('logos:set', (id, dataUrl) => {
    try {
      logos.set(id, dataUrl);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  handle('logos:remove', (id) => {
    try {
      logos.remove(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  handle('alarm:mute', () => {
    soundMuted = true;
    applySound();
    pushStatus();
  });
  handle('audio:test-sound', (volume) => {
    sendEngine(engines[0], 'engine:sound', { on: true, test: true, volume });
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
    const inputs = s.inputs.map((i) => ({ id: i.id, name: inputLabel(s.language, i), schedule: i.schedule }));
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
  handle('audio:devices', async () => {
    if (process.platform === 'darwin' && !(await systemPreferences.askForMediaAccess('microphone'))) return { granted: false, devices: [] };
    return engineRpc('devices');
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
    return whatsNew(text, app.getVersion()) || { version: app.getVersion(), date: '', bullets: [] };
  });
  handle('whatsnew:seen', () => {
    startKind = 'same';
    store.updateSettings({ lastSeenVersion: app.getVersion() });
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
  hadSettingsFile = fs.existsSync(settingsFile());
  store = createStore({ file: settingsFile(), seal, open });
  // rewrite secrets saved before the keystore was available
  store.updateSettings({});
  store.flush();

  logos = createLogos(path.join(app.getPath('userData'), 'logos'));
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
  monitor = createMonitor({
    store,
    engine,
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

  ipcMain.on('engine:ready', (e) => {
    const eng = engineOf(e.sender);
    if (!eng) return;
    eng.ready = true;
    if (eng.pending) sendEngine(eng, 'engine:sync', eng.pending);
    if (eng.index === 0) applySound();
  });
  for (const [channel, handler] of Object.entries(engineHandlers(monitor))) fromEngine(channel, handler);
  ipcMain.on('engine:rpc-result', (e, msg) => {
    if (engineOf(e.sender)?.index !== 0) return;
    const w = rpcWaiting.get(msg.id);
    if (!w) return;
    clearTimeout(w.timer);
    rpcWaiting.delete(msg.id);
    msg.error ? w.reject(new Error(msg.error)) : w.resolve(msg.result);
  });

  heartbeat = createHeartbeat({ getSettings: () => store.getSettings(), fetchFn: (u, o) => net.fetch(u, o), version: app.getVersion(), log: (m, level) => clog(m, level, 'heartbeat') });
  registerIpc();
  createEngineWindow(0);
  createWindow();
  createTray();
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
    dispatcher?.cancelPending();
    store?.flush();
  } catch (err) {
    clog(String(err?.stack || err), 'error', 'quit');
  }
});

// Closing the window keeps monitoring: the app lives in the tray until "Quit".
app.on('window-all-closed', () => {});
