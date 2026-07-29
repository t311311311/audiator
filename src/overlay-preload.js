const { contextBridge, ipcRenderer } = require('electron');

// Minimal bridge for the recording overlay: receive live mic level (0..1).
contextBridge.exposeInMainWorld('overlay', {
  onLevel: (cb) => ipcRenderer.on('rec-level', (event, level) => cb(level)),
});
