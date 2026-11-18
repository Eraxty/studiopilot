const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sp', {
  api: (method, args) => ipcRenderer.invoke('api', method, args),
  on: (channel, fn) => {
    const allowed = ['chat', 'gallery', 'status', 'rojo-log', 'focus', 'notice', 'update'];
    if (!allowed.includes(channel)) throw new Error(`bad channel ${channel}`);
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
