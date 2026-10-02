import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage, nativeTheme, Notification, shell, session, systemPreferences, safeStorage, powerSaveBlocker, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createStore } from './src/store.js';
import { createMonitor, isUsable } from './src/monitor.js';
import { createDispatcher, sendEmail, sendTelegram } from './src/notifications.js';
import { checkForUpdate, downloadInstaller } from './src/updater.js';
import { createHeartbeat } from './src/heartbeat.js';
import { createLogos } from './src/logos.js';
import { aggregateDeadAir } from './src/core/stats.js';
import { toCsv, toJson } from './src/core/export.js';
import { formatDuration } from './src/core/format.js';
import { t } from './src/messages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Tests can point the app at a throw-away data folder.
if (process.env.DAW_USER_DATA) app.setPath('userData', process.env.DAW_USER_DATA);

if (!app.requestSingleInstanceLock()) app.quit();

let store;
let monitor;
let dispatcher;
let heartbeat;
let logos;
let wallBlockerId = null;
let soundActive = false;
let soundMuted = false;
let baseStatus = null;
let mainWindow = null;
let engineWindow = null;
let engineReady = false;
let pendingEngineList = null;
let tray = null;
let isQuitting = false;
let blockerId = null;
let lastStatus = null;
let updateInfo = null;
let trayKey = '';

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

// ---- audio engine (hidden window) -------------------------------------------------------
function createEngineWindow() {
  engineReady = false;
  engineWindow = new BrowserWindow({
    show: false,
    width: 200,
    height: 100,
    webPreferences: {
      preload: path.join(__dirname, 'engine-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });
  engineWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  engineWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  engineWindow.loadFile(path.join(__dirname, 'renderer', 'engine.html'));
  // The engine must never stay dead silently: a crashed or frozen renderer is replaced.
  const restart = (why) => {
    console.error('engine restart:', why);
    const old = engineWindow;
    engineWindow = null;
    if (old && !old.isDestroyed()) old.destroy();
    if (isQuitting) return;
    createEngineWindow();
    monitor?.engineRestarted();
    if (monitor?.isRunning()) pendingEngineList = monitor.engineList();
  };
  engineWindow.webContents.on('render-process-gone', (_e, d) => restart(d.reason));
  engineWindow.on('unresponsive', () => restart('unresponsive'));
}

const engine = {
  sync(list) {
    pendingEngineList = list;
    if (engineReady && engineWindow) engineWindow.webContents.send('engine:sync', list);
  },
  stop() {
    pendingEngineList = null;
    if (engineReady && engineWindow) engineWindow.webContents.send('engine:stop');
  }
};

let rpcSeq = 0;
const rpcWaiting = new Map();
function engineRpc(op, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    if (!engineReady || !engineWindow) return reject(new Error('engine-not-ready'));
    const id = ++rpcSeq;
    const timer = setTimeout(() => {
      rpcWaiting.delete(id);
      reject(new Error('timeout'));
    }, timeoutMs);
    rpcWaiting.set(id, { resolve, reject, timer });
    engineWindow.webContents.send('engine:rpc', { id, op });
  });
}

function fromEngine(channel, handler) {
  ipcMain.on(channel, (e, ...args) => {
    if (!engineWindow || e.sender !== engineWindow.webContents) return;
    handler(...args);
  });
}

// ---- main window ------------------------------------------------------------------------
function createWindow() {
  const settings = store.getSettings();
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 760,
    minHeight: 560,
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
    if (!hidden) mainWindow.show();
  });
  mainWindow.on('leave-full-screen', () => {
    if (wallBlockerId !== null) {
      powerSaveBlocker.stop(wallBlockerId);
      wallBlockerId = null;
    }
    sendUi('event:wall-exit');
  });
  mainWindow.on('close', (e) => {
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
  const file = path.join(__dirname, 'assets', `tray-${state}.png`);
  let img = nativeImage.createFromPath(file);
  if (img.isEmpty()) return nativeImage.createEmpty();
  if (process.platform === 'darwin') img = img.resize({ width: 16, height: 16, quality: 'best' });
  return img;
}

function updateTray(status) {
  if (!tray) return;
  const overall = status?.running ? status.overall : 'idle';
  const state = overall === 'starting' ? 'idle' : overall;
  const key = `${state}|${status?.running}|${lang()}|${status?.inputs?.length ?? 0}`;
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
  if (!engineReady || !engineWindow) return;
  const snd = store.getSettings().notifications.sound;
  engineWindow.webContents.send('engine:sound', { on: soundActive && !soundMuted && snd.enabled, volume: snd.volume });
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
  const n = new Notification({ title: 'Dead Air Watchdog', body, urgency: kind === 'alarm' ? 'critical' : 'normal' });
  n.on('click', showWindow);
  n.show();
}

function checkUpdatesNow(manual) {
  const s = store.getSettings();
  return checkForUpdate({ repo: s.general.updateRepo, current: app.getVersion(), fetchFn: (u, o) => net.fetch(u, o) }).then((r) => {
    if (r.ok && r.available) {
      updateInfo = r;
      sendUi('event:update-available', r);
    } else if (manual) updateInfo = r.ok ? r : null;
    return r;
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
  handle('settings:update', (patch) => {
    const next = store.updateSettings(patch);
    logos.prune(next.inputs.map((i) => i.id)); // logos of removed inputs
    applyGeneralSettings(next);
    monitor.syncInputs(); // inputs added, removed or edited while monitoring
    if (!monitor.isRunning()) heartbeat.stop();
    heartbeat.restart();
    applyKeepAwake();
    applySound();
    pushStatus();
    trayKey = '';
    updateTray(lastStatus);
    sendUi('event:settings-changed', next);
    return next;
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
    if (engineReady && engineWindow) engineWindow.webContents.send('engine:sound', { on: true, test: true, volume });
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
    fs.writeFileSync(r.filePath, ext === 'json' ? toJson(events, { version: app.getVersion() }) : toCsv(events));
    return { ok: true, file: r.filePath, count: events.length };
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
      else await sendTelegram({ ...cfg, enabled: true }, t(l, 'test.body'), l, (u, o) => net.fetch(u, o));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message).slice(0, 400) };
    }
  });

  handle('update:check', () => checkUpdatesNow(true));
  handle('update:download', async () => {
    if (!updateInfo?.available) return { ok: false, error: 'no-update' };
    try {
      const file = await downloadInstaller({ info: updateInfo, dir: app.getPath('downloads'), fetchFn: (u, o) => net.fetch(u, o), current: app.getVersion(), onProgress: (got, total) => sendUi('event:update-progress', { got, total }) });
      return { ok: true, file };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  handle('update:reveal', (file) => {
    if (typeof file === 'string' && path.dirname(file) === app.getPath('downloads')) shell.showItemInFolder(file);
  });
  handle('update:open-page', () => {
    if (updateInfo?.url) shell.openExternal(updateInfo.url);
  });

  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, arch: process.arch, packaged: app.isPackaged, host: os.hostname() }));
  handle('app:open-external', (url) => {
    if (typeof url === 'string' && EXTERNAL_OK.some((re) => re.test(url))) shell.openExternal(url);
  });

}

// ---- start-up ----------------------------------------------------------------------------------
app.on('second-instance', showWindow);

app.whenReady().then(() => {
  store = createStore({ file: path.join(app.getPath('userData'), 'dead-air-watchdog.json'), seal, open });
  // rewrite secrets saved before the keystore was available
  store.updateSettings({});
  store.flush();

  logos = createLogos(path.join(app.getPath('userData'), 'logos'));
  dispatcher = createDispatcher({ getSettings: () => store.getSettings(), log: (m, level) => console[level === 'info' ? 'log' : 'warn'](`[notify] ${m}`) });
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
    log: (m, level) => console[level === 'error' ? 'error' : 'log'](`[monitor] ${m}`)
  });

  // The audio input may only be used by the engine window, and only for audio.
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, cb, details) => cb(permission === 'media' && !!engineWindow && wc === engineWindow.webContents && !(details.mediaTypes || []).includes('video')));
  ses.setPermissionCheckHandler((wc, permission) => permission === 'media' && !!engineWindow && !!wc && wc === engineWindow.webContents);
  // Stream servers rarely send CORS headers; without them a Web Audio graph is fed silence.
  // The header is added to media responses of the engine window only.
  ses.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'] }, (details, cb) => {
    if (details.resourceType !== 'media' || !engineWindow || details.webContentsId !== engineWindow.webContents.id) return cb({});
    const headers = { ...details.responseHeaders };
    for (const k of Object.keys(headers)) if (k.toLowerCase() === 'access-control-allow-origin') delete headers[k];
    headers['Access-Control-Allow-Origin'] = ['*'];
    cb({ responseHeaders: headers });
  });

  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')));

  fromEngine('engine:ready', () => {
    engineReady = true;
    if (pendingEngineList) engineWindow.webContents.send('engine:sync', pendingEngineList);
    applySound();
  });
  fromEngine('engine:levels', (r) => monitor.onLevels(r));
  fromEngine('engine:fault', (reason) => monitor.onFault(reason));
  fromEngine('engine:ok', () => monitor.onOk());
  ipcMain.on('engine:rpc-result', (e, msg) => {
    if (!engineWindow || e.sender !== engineWindow.webContents) return;
    const w = rpcWaiting.get(msg.id);
    if (!w) return;
    clearTimeout(w.timer);
    rpcWaiting.delete(msg.id);
    msg.error ? w.reject(new Error(msg.error)) : w.resolve(msg.result);
  });

  heartbeat = createHeartbeat({ getSettings: () => store.getSettings(), fetchFn: (u, o) => net.fetch(u, o), version: app.getVersion(), log: (m, level) => console[level === 'info' ? 'log' : 'warn'](`[heartbeat] ${m}`) });
  registerIpc();
  createEngineWindow();
  createWindow();
  createTray();
  applyGeneralSettings(store.getSettings());

  monitor.recoverFromPreviousRun();
  store.pruneEvents(store.getSettings().general.retentionDays);
  setInterval(() => store.pruneEvents(store.getSettings().general.retentionDays), 6 * 3600_000);

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
    console.error(err);
  }
});

// Closing the window keeps monitoring: the app lives in the tray until "Quit".
app.on('window-all-closed', () => {});
