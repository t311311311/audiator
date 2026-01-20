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
  // Get initial settings synchronously
  getInitialSettings: () => {
    return ipcRenderer.invoke('get-initial-settings');
  },
  // Receive initial settings
  onInitialSettings: (callback) => {
    ipcRenderer.on('initial-settings', (event, ...args) => callback(...args));
  },
  // Get app version
  getAppVersion: () => {
    return ipcRenderer.invoke('get-app-version');
  }
});
