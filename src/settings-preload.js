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
  },
  // Interface strings for the current language: { lang, languages, strings }
  getI18n: (lang) => ipcRenderer.invoke('get-i18n', lang),
  // Speech engine: which models are on this computer, and their sizes.
  getEngineStatus: () => ipcRenderer.invoke('get-engine-status'),
  onEngineStatus: (cb) => ipcRenderer.on('engine-status', (event, s) => cb(s)),
  deleteModel: (name) => ipcRenderer.invoke('engine-delete', name),
  // The account section: who is signed in, the plan, minutes left today.
  getAccount: () => ipcRenderer.invoke('account-get'),
  onAccountUpdated: (cb) => ipcRenderer.on('account-updated', (event, v) => cb(v)),
  signOut: () => ipcRenderer.send('account-sign-out'),
  openTerms: () => ipcRenderer.send('open-terms'),
});
