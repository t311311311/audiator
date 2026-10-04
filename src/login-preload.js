const { contextBridge, ipcRenderer } = require('electron');

// The sign-in window: an email, then the code mailed to it (account.js).
contextBridge.exposeInMainWorld('loginApi', {
  getI18n: () => ipcRenderer.invoke('get-i18n'), // { lang, languages, strings }
  getSettings: () => ipcRenderer.invoke('get-current-settings'), // for the theme
  getAccount: () => ipcRenderer.invoke('account-get'), // why the user is here (session expired...)
  requestCode: (email) => ipcRenderer.invoke('account-request-code', email),
  verify: (email, code) => ipcRenderer.invoke('account-verify', { email, code }),
  openTerms: () => ipcRenderer.send('open-terms'), // the rules to accept before signing in
});
