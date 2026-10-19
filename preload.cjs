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
    pause: (inputId, mode) => invoke('monitor:pause', inputId, mode),
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
  report: {
    get: (period) => invoke('report:get', period),
    export: (period) => invoke('report:export', period)
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
  delivery: {
    get: () => invoke('delivery:get')
  },
  notifications: {
    test: (channel, cfg) => invoke('notify:test', channel, cfg)
  },
  backup: {
    export: (includeSecrets) => invoke('backup:export', includeSecrets),
    import: (mode) => invoke('backup:import', mode)
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
    state: () => invoke('update:state'),
    download: () => invoke('update:download'),
    cancel: () => invoke('update:cancel'),
    remind: () => invoke('update:remind'),
    skip: () => invoke('update:skip'),
    install: (confirmed) => invoke('update:install', confirmed),
    reveal: () => invoke('update:reveal'),
    openPage: () => invoke('update:open-page'),
    whatsNew: () => invoke('whatsnew:get'),
    whatsNewSeen: () => invoke('whatsnew:seen')
  },
  app: {
    supportInfo: () => invoke('app:support-info'),
    openLogs: () => invoke('logs:open-folder'),
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
    delivery: on('event:delivery'),
    wallExit: on('event:wall-exit')
  }
});
