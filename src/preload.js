const { contextBridge, ipcRenderer } = require('electron');

// Expose a limited API to the renderer process
contextBridge.exposeInMainWorld('api', {
  // Function to send a 'close' message to the main process
  close: () => ipcRenderer.send('close-app'),

  // Function to send a 'quit' message to the main process
  quit: () => ipcRenderer.send('quit-app'),

  // Function to send audio data to the main process for saving
  saveAudio: async (audioBlob, timestamp) => {
    const arrayBuffer = await audioBlob.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    ipcRenderer.send('save-audio', { audio: buffer, timestamp: timestamp });
  },

  // Function to send text data to the main process for saving
  saveText: (text, timestamp) => {
    ipcRenderer.send('save-text', { text: text, timestamp: timestamp });
  },

  // Function to send both audio and text data to the main process for saving
  saveAudioAndText: async (audioBlob, text, timestamp) => {
    const arrayBuffer = await audioBlob.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    ipcRenderer.send('save-audio-and-text', { audio: buffer, text: text, timestamp: timestamp });
  },

  // --- Settings ---
  openSettings: () => ipcRenderer.send('open-settings-window'),
  onSettingsUpdated: (callback) => ipcRenderer.on('settings-updated', (event, ...args) => callback(...args)),
  getSettings: () => ipcRenderer.invoke('get-current-settings'),
  getI18n: () => ipcRenderer.invoke('get-i18n'), // { lang, languages, strings }

  // --- Window controls ---
  minimize: () => ipcRenderer.send('minimize-app'),

  // --- Logging ---
  logError: (message, error) => ipcRenderer.send('log-error', { message, error: error.toString(), stack: error.stack }),

  // --- Authorization ---
  checkAuth: () => ipcRenderer.invoke('check-auth'),
  startTrial: () => ipcRenderer.invoke('start-trial'),
  activateSubscription: (plan, paymentId) => ipcRenderer.invoke('activate-subscription', { plan, paymentId }),
  logout: () => ipcRenderer.invoke('logout'),
  onAuthRequired: (callback) => ipcRenderer.on('auth-required', () => callback()),
  activationComplete: (payload) => ipcRenderer.send('activation-complete', payload),
  checkServerHealth: () => ipcRenderer.invoke('check-server-health'),

  // --- API ---
  // A Blob cannot cross the IPC boundary: send the raw bytes instead.
  transcribe: async (audioBlob, language) => {
    const arrayBuffer = await audioBlob.arrayBuffer();
    return ipcRenderer.invoke('transcribe', { audioBuffer: Buffer.from(arrayBuffer), language });
  },
  translate: async (text, targetLang, sourceLang) => ipcRenderer.invoke('translate', { text, targetLang, sourceLang }),
  getSupportedLanguages: () => ipcRenderer.invoke('get-supported-languages'),

  // --- Recording overlay / global hotkey (AUD-40) ---
  onHotkeyToggleRecord: (cb) => ipcRenderer.on('hotkey-toggle-record', () => cb()),
  // The recording queue ("barrels"): every recording carries one id from
  // start to transcript. transcribed() answers { copied } — whether the text
  // went on the clipboard now or waits its turn in the queue.
  recordingStarted: (id) => ipcRenderer.send('recording-started', id),
  recordingStopped: (id) => ipcRenderer.send('recording-stopped', id),
  transcribed: (id, text) => ipcRenderer.invoke('transcribed', { id, text }),
  transcribeFailed: (id) => ipcRenderer.send('transcribe-failed', id),
  recLevel: (level) => ipcRenderer.send('rec-level', level),
});
