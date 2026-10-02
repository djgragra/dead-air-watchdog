const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('engineApi', {
  onSync: (cb) => ipcRenderer.on('engine:sync', (_e, list) => cb(list)),
  onStop: (cb) => ipcRenderer.on('engine:stop', () => cb()),
  onSound: (cb) => ipcRenderer.on('engine:sound', (_e, msg) => cb(msg)),
  onRpc: (cb) => ipcRenderer.on('engine:rpc', (_e, msg) => cb(msg)),
  rpcResult: (msg) => ipcRenderer.send('engine:rpc-result', msg),
  levels: (batch) => ipcRenderer.send('engine:levels', batch),
  fault: (id, reason) => ipcRenderer.send('engine:fault', id, reason),
  ok: (id) => ipcRenderer.send('engine:ok', id),
  ready: () => ipcRenderer.send('engine:ready')
});
