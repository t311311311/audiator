const { contextBridge, ipcRenderer } = require('electron');

// Minimal bridge for the recording overlay: receive live mic level (0..1),
// switch to the brief "copied" confirmation, and report a click (which swaps
// the overlay back for the main window).
contextBridge.exposeInMainWorld('overlay', {
  onLevel: (cb) => ipcRenderer.on('rec-level', (event, level) => cb(level)),
  // Both carry the two lines of text, already in the user's language.
  onBusy: (cb) => ipcRenderer.on('overlay-busy', (event, lines) => cb(lines)),
  onDone: (cb) => ipcRenderer.on('overlay-done', (event, lines) => cb(lines)),
  onReset: (cb) => ipcRenderer.on('overlay-reset', () => cb()),
  clicked: () => ipcRenderer.send('overlay-clicked'),
});
