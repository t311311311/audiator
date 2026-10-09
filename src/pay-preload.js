const { contextBridge, ipcRenderer } = require('electron');

// Paying for the plan: an xRocket invoice opened in Telegram, then the server
// asked until the payment comes (account.js -> /api/v2/pay).
contextBridge.exposeInMainWorld('payApi', {
  getI18n: (lang) => ipcRenderer.invoke('get-i18n', lang), // { lang, languages, strings }
  onSettingsUpdated: (cb) => ipcRenderer.on('settings-updated', (event, s) => cb(s)),
  getSettings: () => ipcRenderer.invoke('get-current-settings'), // for the theme
  getAccount: () => ipcRenderer.invoke('account-get'), // plan, paid until, balance
  onAccountUpdated: (cb) => ipcRenderer.on('account-updated', (event, v) => cb(v)),
  invoice: (period, lang) => ipcRenderer.invoke('pay-invoice', { period, lang }), // opens it in Telegram
  openInvoice: (url) => ipcRenderer.send('pay-open-invoice', url),
  status: (id) => ipcRenderer.invoke('pay-status', id),
  openTerms: (lang) => ipcRenderer.send('open-terms', lang),
  close: () => ipcRenderer.send('pay-close'),
});
