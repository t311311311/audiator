const { contextBridge, ipcRenderer } = require('electron');

// "Написать нам": a topic and a message, sent to support through the server
// (account.js -> /api/v2/support).
contextBridge.exposeInMainWorld('supportApi', {
  getI18n: (lang) => ipcRenderer.invoke('get-i18n', lang), // { lang, languages, strings }
  onSettingsUpdated: (cb) => ipcRenderer.on('settings-updated', (event, s) => cb(s)),
  getSettings: () => ipcRenderer.invoke('get-current-settings'), // for the theme
  getAccount: () => ipcRenderer.invoke('account-get'), // the email the answer goes to
  getInfo: () => ipcRenderer.invoke('support-info'), // { version, os } added to the message
  send: (category, text) => ipcRenderer.invoke('support-send', { category, text }),
  close: () => ipcRenderer.send('support-close'),
});
