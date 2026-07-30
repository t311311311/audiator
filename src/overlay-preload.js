const { contextBridge, ipcRenderer } = require('electron');

// Minimal bridge for the recording overlay: receive live mic level (0..1) and
// report a click, which swaps the overlay back for the main window.
contextBridge.exposeInMainWorld('overlay', {
  onLevel: (cb) => ipcRenderer.on('rec-level', (event, level) => cb(level)),
  clicked: () => ipcRenderer.send('overlay-clicked'),
});
