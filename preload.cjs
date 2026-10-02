const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel) => (cb) => {
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  settings: {
    get: () => invoke('settings:get'),
    update: (patch) => invoke('settings:update', patch)
  },
  monitor: {
    start: () => invoke('monitor:start'),
    stop: () => invoke('monitor:stop'),
    status: () => invoke('monitor:status'),
    muteAlarm: () => invoke('alarm:mute')
  },
  events: {
    list: () => invoke('events:list'),
    export: (format) => invoke('events:export', format),
    clear: () => invoke('events:clear')
  },
  stats: {
    daily: (days, inputId) => invoke('stats:daily', days, inputId)
  },
  wall: {
    set: (on) => invoke('wall:set', on)
  },
  audio: {
    devices: () => invoke('audio:devices'),
    accessStatus: () => invoke('audio:access-status'),
    testSound: (volume) => invoke('audio:test-sound', volume)
  },
  notifications: {
    test: (channel, cfg) => invoke('notify:test', channel, cfg)
  },
  logos: {
    all: () => invoke('logos:all'),
    set: (id, dataUrl) => invoke('logos:set', id, dataUrl),
    remove: (id) => invoke('logos:remove', id)
  },
  heartbeat: {
    test: (url) => invoke('heartbeat:test', url)
  },
  updates: {
    check: () => invoke('update:check'),
    download: () => invoke('update:download'),
    reveal: (file) => invoke('update:reveal', file),
    openPage: () => invoke('update:open-page')
  },
  app: {
    info: () => invoke('app:info'),
    openExternal: (url) => invoke('app:open-external', url)
  },
  on: {
    status: on('event:status'),
    levels: on('event:levels'),
    eventsChanged: on('event:events-changed'),
    updateAvailable: on('event:update-available'),
    updateProgress: on('event:update-progress'),
    settingsChanged: on('event:settings-changed'),
    wallExit: on('event:wall-exit')
  }
});
