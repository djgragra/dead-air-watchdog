const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('soundApi', {
  onSound: (cb) => ipcRenderer.on('sound:play', (_e, msg) => cb(msg)),
  ready: () => ipcRenderer.send('sound:ready')
});
