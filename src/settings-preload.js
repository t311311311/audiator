const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  // Renderer to Main
  send: (channel, data) => {
    const validChannels = ['update-setting', 'get-settings', 'save-all-settings', 'close-settings-window'];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },
  // Main to Renderer
  receive: (channel, func) => {
    const validChannels = ['settings-loaded'];
    if (validChannels.includes(channel)) {
      // Deliberately strip event as it includes `sender`
      ipcRenderer.on(channel, (event, ...args) => func(...args));
    }
  },
});
