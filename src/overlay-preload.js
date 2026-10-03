const { contextBridge, ipcRenderer } = require('electron');

// Minimal bridge for the recording overlay: receive live mic level (0..1),
// the barrels to draw, and report a click (which swaps the overlay back for
// the main window).
contextBridge.exposeInMainWorld('overlay', {
  onLevel: (cb) => ipcRenderer.on('rec-level', (event, level) => cb(level)),
  // The whole bar at once: the barrels and their two-line texts, already in
  // the user's language.
  onState: (cb) => ipcRenderer.on('overlay-state', (event, state) => cb(state)),
  clicked: () => ipcRenderer.send('overlay-clicked'),
  // Moving the bar: how far the pointer is from where it was pressed.
  dragStart: () => ipcRenderer.send('overlay-drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('overlay-drag-move', { dx, dy }),
  dragEnd: () => ipcRenderer.send('overlay-drag-end'),
});
