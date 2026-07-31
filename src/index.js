const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, globalShortcut, screen, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

// --- Initialize Settings Store ---
const store = new Store({
  defaults: {
    theme: 'dark',
    opacity: 0.8, // Default to 80% opaque
    fontSize: 16,
    fontFamily: 'Arial',
  }
});

// --- One-time setup: Ensure icon file exists ---
const iconPath = path.join(__dirname, 'icon.ico');
const iconBase64 = 'AAABAAEAEBAQAAEABAAoAQAAFgAAACgAAAAQAAAAIAAAAAEABAAAAAAAgAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAA/4QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEREQAAAAAAEAAAEAEAAAAAEAAAABAAAAEAAAAAAQAAAQAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

if (!fs.existsSync(iconPath)) {
  const iconBuffer = Buffer.from(iconBase64, 'base64');
  fs.writeFileSync(iconPath, iconBuffer);
}
// --- End one-time setup ---

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

let tray = null;
let mainWindow = null;
let settingsWindow = null;
let overlayWindow = null;

// --- Recording overlay: a compact always-on-top level meter shown while recording ---
// It stands in for the main window: visible only while recording AND the main
// window is hidden. Clicking it brings the main window back.
// Overlay states, in the order they happen: recording -> transcribing -> ready.
let isRecording = false;
let transcribing = false; // waiting for the transcript
let showingDone = false;  // briefly showing "Готово! Ctrl+V"

const createOverlay = () => {
  const width = 96, height = 40;
  const area = screen.getPrimaryDisplay().workAreaSize;
  overlayWindow = new BrowserWindow({
    width, height,
    x: Math.round((area.width - width) / 2),
    y: area.height - height - 16, // bottom centre, just above the taskbar
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    // Must stay focusable: on Windows a non-focusable window (WS_EX_NOACTIVATE)
    // does not deliver clicks to the page, so tapping the bar did nothing.
    // It is shown with showInactive(), which already avoids stealing focus.
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep the meter animating while hidden/unfocused
    },
  });
  overlayWindow.setOpacity(store.get('opacity', 0.8)); // same translucency as the main window
  overlayWindow.loadFile(path.join(__dirname, 'recorder-overlay.html'));
  overlayWindow.on('closed', () => { overlayWindow = null; });

  // Primary path for "user tapped the bar". The overlay is always shown with
  // showInactive() and is kept out of the taskbar and Alt-Tab, so the only way
  // it can gain focus is a real click on it. Acting on focus works even when
  // the click never reaches the page, which is what happened before.
  overlayWindow.on('focus', () => {
    if (!overlayWindow.isVisible()) return; // ignore focus while hidden
    console.log('[overlay] focused (clicked) -> revealing main window');
    overlayWindow.hide();
    revealMainWindow();
  });
};

// Bring the main window to the front and give it focus.
// Windows refuses a plain focus() call from a background process, so the window
// would appear behind whatever the user was working in. Flipping alwaysOnTop on
// and straight back off is the standard way to get to the front without
// permanently pinning the window there.
const revealMainWindow = () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.setAlwaysOnTop(true);
  mainWindow.show();
  mainWindow.moveTop();
  mainWindow.focus();
  app.focus({ steal: true });
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false);
  }, 200);
};

// The overlay and the main window are two views of the same state: show the
// overlay only while recording with the main window out of sight.
const syncOverlay = () => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const mainVisible = mainWindow && !mainWindow.isDestroyed() &&
                      mainWindow.isVisible() && !mainWindow.isMinimized();
  if ((isRecording || transcribing || showingDone) && !mainVisible) {
    if (!overlayWindow.isVisible()) overlayWindow.showInactive();
  } else if (overlayWindow.isVisible()) {
    overlayWindow.hide();
  }
};

// Function to send settings to all windows
function broadcastSettings() {
  const settings = store.get();
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('settings-updated', settings);
  });
}

const createWindow = () => {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 400,
    height: 600,
    frame: false, // Make it frameless
    resizable: false, // Optional: for a fixed size
    show: false, // Start hidden
    icon: iconPath, // Also set the window icon
    opacity: store.get('opacity', 0.8), // Apply stored opacity
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Recording keeps running with the window hidden in the tray; without this
      // Chromium throttles its timers and the level meter freezes.
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('close', (event) => {
    if(!app.isQuitting){
        event.preventDefault();
        mainWindow.hide();
    }
  });
};

const createTray = () => {
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show App', click: () => { revealMainWindow(); }},
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); }},
  ]);

  tray.setToolTip('Audiator');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    mainWindow.isVisible() ? mainWindow.hide() : revealMainWindow();
  });
};

let activationWindow = null;

const showActivationWindow = () => {
  if (activationWindow) {
    activationWindow.focus();
    return;
  }

  activationWindow = new BrowserWindow({
    width: 460,
    height: 730, // fits the whole card without a scrollbar
    frame: true,
    resizable: false,
    parent: mainWindow,
    modal: true,
    title: 'Активация Audiator',
    backgroundColor: '#282c34', // avoids a white flash before the page paints
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  activationWindow.setMenu(null); // no File/Edit/View bar on a product dialog

  activationWindow.loadFile(path.join(__dirname, 'activation.html'));

  activationWindow.on('closed', () => {
    activationWindow = null;
  });

  // Listen for activation complete
  ipcMain.once('activation-complete', (event, { type, subscriptionEnd }) => {
    if (activationWindow) {
      activationWindow.close();
    }
    // Show main window
    if (mainWindow) {
      mainWindow.show();
    }
  });
};

app.on('ready', async () => {
  // Request microphone access on macOS
  if (process.platform === 'darwin') {
    const { systemPreferences } = require('electron');
    const status = await systemPreferences.askForMediaAccess('microphone');
    if (!status) {
      console.log('Microphone access was denied.');
    }
  }
  
  // Check authorization status
  const auth = require('./auth');
  const authStatus = await auth.checkStatus();
  
  createWindow();
  createTray();
  broadcastSettings();
  createOverlay();

  // Global hotkey (works even when the app is in the tray/background): toggle recording.
  // Starting from the hotkey means the user is working elsewhere, so get the
  // window out of the way and let the overlay report progress instead.
  if (!globalShortcut.register('CommandOrControl+Space', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!isRecording && mainWindow.isVisible()) mainWindow.hide();
    mainWindow.webContents.send('hotkey-toggle-record');
  })) {
    console.error('Failed to register hotkey Ctrl+Space (already taken by another app)');
  }

  // Recording overlay lifecycle, driven by the renderer that owns the mic stream.
  ipcMain.on('recording-started', () => {
    isRecording = true;
    transcribing = false;
    showingDone = false;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('overlay-reset'); // back to the equaliser
    }
    syncOverlay();
  });
  ipcMain.on('recording-stopped', () => { isRecording = false; syncOverlay(); });

  // Transcription can take a while; keep the bar up saying so instead of
  // vanishing and reappearing.
  ipcMain.on('transcribing-started', () => {
    transcribing = true;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('overlay-busy');
    }
    syncOverlay();
  });
  ipcMain.on('transcribing-failed', () => {
    transcribing = false;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('overlay-reset');
    }
    syncOverlay();
  });
  // Copy from the main process: navigator.clipboard needs a focused document,
  // and recording usually finishes with this window hidden in the tray.
  ipcMain.on('copy-to-clipboard', (event, text) => {
    if (!text) return;
    clipboard.writeText(text);
    transcribing = false;
    // With the window hidden the in-app toast would go unseen, so confirm in
    // the overlay instead — otherwise the hotkey flow gives no feedback at all.
    const mainVisible = mainWindow && !mainWindow.isDestroyed() &&
                        mainWindow.isVisible() && !mainWindow.isMinimized();
    if (!mainVisible && overlayWindow && !overlayWindow.isDestroyed()) {
      showingDone = true;
      overlayWindow.webContents.send('overlay-done');
      overlayWindow.showInactive();
      setTimeout(() => {
        showingDone = false;
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send('overlay-reset');
        }
        syncOverlay();
      }, 3000); // long enough to read "Готово! Ctrl+V" and act on it
    } else {
      syncOverlay();
    }
  });
  ipcMain.on('rec-level', (event, level) => {
    if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
      overlayWindow.webContents.send('rec-level', level);
    }
  });
  // Clicking the overlay swaps it back for the main window (recording continues).
  ipcMain.on('overlay-clicked', () => {
    console.log('[overlay] clicked -> revealing main window');
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
    revealMainWindow();
  });
  // Hiding/minimising the window while recording hands over to the overlay.
  ['hide', 'minimize', 'show', 'restore', 'focus'].forEach((evt) => {
    mainWindow.on(evt, () => setTimeout(syncOverlay, 0));
  });

  // Show activation window if not authenticated
  if (!authStatus.authenticated) {
    showActivationWindow();
  }

  ipcMain.on('close-app', () => { mainWindow.hide(); });
  ipcMain.on('quit-app', () => { app.isQuitting = true; app.quit(); });
  ipcMain.on('minimize-app', () => { mainWindow.minimize(); });
  ipcMain.on('log-error', (event, { message, error, stack }) => {
    console.error(`[${new Date().toISOString()}] ${message}: ${error}`);
    if (stack) {
      console.error(`Stack trace: ${stack}`);
    }

    // Optionally, write error to a log file
    const fs = require('fs');
    const logMessage = `[${new Date().toISOString()}] ${message}: ${error}\n`;
    const logEntry = stack ? `${logMessage}Stack trace: ${stack}\n\n` : `${logMessage}\n`;

    fs.appendFile('error.log', logEntry, (err) => {
      if (err) {
        console.error('Failed to write to error log:', err);
      }
    });
  });

  // Handle requests from renderer to get current settings
  ipcMain.handle('get-current-settings', () => {
    return store.get();
  });

  // Handle requests from settings window to get initial settings
  ipcMain.handle('get-initial-settings', () => {
    return store.get();
  });

  // Handle requests to get app version
  ipcMain.handle('get-app-version', () => {
    return app.getVersion();
  });

  let pendingSettings = {}; // Temporary storage for settings form changes

  // --- Settings Window Logic ---
  ipcMain.on('open-settings-window', () => {
    if (settingsWindow) {
      settingsWindow.focus();
      return;
    }

    // Get current settings before creating the window
    const currentStoredSettings = store.get();
    // Initialize pendingSettings with current stored values
    pendingSettings = { ...currentStoredSettings };

    settingsWindow = new BrowserWindow({
      width: 450,
      height: 380, // Increased height
      resizable: false,
      minimizable: false, // Prevent minimizing
      maximizable: false, // Prevent maximizing
      parent: mainWindow,
      modal: false,
      frame: true, // Restore standard frame with title bar
      title: '', // Empty title to remove text from title bar
      backgroundColor: currentStoredSettings.theme === 'light' ? '#e4e6eb' : '#3e4452', // Match theme color
      webPreferences: {
        preload: path.join(__dirname, 'settings-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Set backgroundColor based on current theme to prevent flashing
    if (currentStoredSettings.theme === 'light') {
      settingsWindow.setBackgroundColor('#fafafa'); // Light theme background
    } else {
      settingsWindow.setBackgroundColor('#282c34'); // Dark theme background
    }

    settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
    settingsWindow.setMenu(null); // Remove the default menu

    // Send initial settings as soon as the page loads
    settingsWindow.webContents.once('did-finish-load', () => {
      // Apply the theme immediately to prevent flashing
      if (currentStoredSettings.theme === 'light') {
        settingsWindow.webContents.executeJavaScript(`
          if (!document.body.classList.contains('light-theme')) {
            document.body.classList.add('light-theme');
          }
        `);
      } else {
        settingsWindow.webContents.executeJavaScript(`
          document.body.classList.remove('light-theme');
        `);
      }

      // Then send the full settings
      settingsWindow.webContents.send('initial-settings', currentStoredSettings);
    });

    settingsWindow.on('closed', () => {
      settingsWindow = null;
      // Re-apply original settings in case real-time preview was active
      mainWindow.setOpacity(store.get('opacity'));
      mainWindow.webContents.send('settings-updated', store.get());
    });
  });

  // Sends the *pending* settings to the settings window
  ipcMain.on('get-settings', (event) => {
    event.sender.send('settings-loaded', pendingSettings);
  });

  // Updates pending settings and applies real-time changes to main window
  ipcMain.on('update-setting', (event, { key, value }) => {
    pendingSettings[key] = value;
    if (key === 'opacity') {
      mainWindow.setOpacity(value);
    }
    // Inform main window about real-time preview changes
    mainWindow.webContents.send('settings-updated', pendingSettings);
  });

  // Saves all pending settings and closes the window
  ipcMain.on('save-all-settings', (event, settingsToSave) => {
    for (const key in settingsToSave) {
      store.set(key, settingsToSave[key]);
    }
    // Apply all saved settings to main window (e.g., opacity)
    mainWindow.setOpacity(store.get('opacity'));
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setOpacity(store.get('opacity')); // keep the overlay in step
    }
    broadcastSettings(); // Broadcast final saved settings to all windows
    if (settingsWindow) {
      settingsWindow.close();
    }
  });

  // Closes settings window without saving
  ipcMain.on('close-settings-window', () => {
    if (settingsWindow) {
      settingsWindow.close();
      // Re-apply original settings in case real-time preview was active
      mainWindow.setOpacity(store.get('opacity'));
      mainWindow.webContents.send('settings-updated', store.get());
    }
  });

  // --- File Saving Logic ---
  // Helper function to format timestamp into HHMMSS_DDMMYY
  function formatTimestampForFilename(isoTimestamp) {
    const dateObj = new Date(isoTimestamp);
    if (isNaN(dateObj.getTime())) {
      // Fallback for invalid timestamps
      const now = new Date();
      const year = now.getFullYear().toString().slice(2);
      const month = (now.getMonth() + 1).toString().padStart(2, '0');
      const day = now.getDate().toString().padStart(2, '0');
      const hours = now.getHours().toString().padStart(2, '0');
      const minutes = now.getMinutes().toString().padStart(2, '0');
      const seconds = now.getSeconds().toString().padStart(2, '0');
      return `${hours}${minutes}${seconds}_${day}${month}${year}`;
    }
    const year = dateObj.getFullYear().toString().slice(2);
    const month = (dateObj.getMonth() + 1).toString().padStart(2, '0');
    const day = dateObj.getDate().toString().padStart(2, '0');
    const hours = dateObj.getHours().toString().padStart(2, '0');
    const minutes = dateObj.getMinutes().toString().padStart(2, '0');
    const seconds = dateObj.getSeconds().toString().padStart(2, '0');
    return `${hours}${minutes}${seconds}_${day}${month}${year}`;
  }

  // Generic file saver
  ipcMain.on('save-audio', (event, { audio, timestamp }) => {
    const defaultName = `ad_${formatTimestampForFilename(timestamp)}.webm`;
    dialog.showSaveDialog({
      title: 'Save Recorded Audio',
      defaultPath: defaultName,
      filters: [{ name: 'WebM Audio', extensions: ['webm'] }]
    }).then(result => {
      if (!result.canceled && result.filePath) {
        fs.writeFile(result.filePath, audio, (err) => {
          if (err) console.error('Failed to save audio:', err);
          else console.log('Audio saved successfully:', result.filePath);
        });
      }
    }).catch(err => console.error('Error showing save dialog:', err));
  });

  ipcMain.on('save-text', (event, { text, timestamp }) => {
    const defaultName = `history_${formatTimestampForFilename(timestamp)}.txt`;
    dialog.showSaveDialog({
      title: 'Save Transcription History',
      defaultPath: defaultName,
      filters: [{ name: 'Text Files', extensions: ['txt'] }]
    }).then(result => {
      if (!result.canceled && result.filePath) {
        fs.writeFile(result.filePath, text, (err) => {
          if (err) console.error('Failed to save text:', err);
          else console.log('Text saved successfully:', result.filePath);
        });
      }
    }).catch(err => console.error('Error showing save dialog for text:', err));
  });

  // Handle saving both audio and text
  ipcMain.on('save-audio-and-text', (event, { audio, text, timestamp }) => {
    const formattedTimestamp = formatTimestampForFilename(timestamp);
    const defaultName = `ad_${formattedTimestamp}.webm`;
    dialog.showSaveDialog({
      title: 'Save Audio and Text',
      defaultPath: defaultName,
      filters: [{ name: 'WebM Audio', extensions: ['webm'] }]
    }).then(result => {
      if (!result.canceled && result.filePath) {
        const dir = path.dirname(result.filePath);
        const audioPath = path.join(dir, `ad_${formattedTimestamp}.webm`);
        const textPath = path.join(dir, `tr_${formattedTimestamp}.txt`);

        fs.writeFile(audioPath, audio, (err) => {
          if (err) console.error('Failed to save audio:', err);
          else console.log('Audio saved successfully:', audioPath);
        });

        fs.writeFile(textPath, text, (err) => {
          if (err) console.error('Failed to save text:', err);
          else console.log('Text saved successfully:', textPath);
        });
      }
    }).catch(err => console.error('Error showing save dialog for audio/text:', err));
  });

  // === AUTHORIZATION HANDLERS ===
  // `auth` is already required above, where the startup auth check runs;
  // re-declaring it here is a SyntaxError that stops the app from starting.

  // Check authorization status
  ipcMain.handle('check-auth', async () => {
    try {
      const status = await auth.checkStatus();
      return status;
    } catch (e) {
      console.error('Auth check failed:', e.message);
      return { authenticated: false, reason: 'error', error: e.message };
    }
  });

  // Start trial
  ipcMain.handle('start-trial', async () => {
    try {
      const result = await auth.startTrial('Audiator Desktop');
      return { success: true, subscriptionEnd: result.subscription_end };
    } catch (e) {
      console.error('Trial start failed:', e.message);
      return { success: false, error: e.message };
    }
  });

  // Activate subscription
  ipcMain.handle('activate-subscription', async (event, { plan, paymentId }) => {
    try {
      const result = await auth.activateSubscription(plan, paymentId);
      return { success: true, subscriptionEnd: result.subscription_end };
    } catch (e) {
      console.error('Subscription activation failed:', e.message);
      return { success: false, error: e.message };
    }
  });

  // Logout
  ipcMain.handle('logout', () => {
    auth.logout();
    return { success: true };
  });

  // === API HANDLERS ===
  const api = require('./api');

  // Transcribe audio
  ipcMain.handle('transcribe', async (event, { audioBuffer, language }) => {
    try {
      const result = await api.transcribe(audioBuffer, language);
      return { success: true, text: result.text, language: result.language };
    } catch (e) {
      console.error('Transcription failed:', e.message);
      if (e.authRequired) showActivationWindow();
      return { success: false, error: e.message, authRequired: !!e.authRequired };
    }
  });

  // Translate text
  ipcMain.handle('translate', async (event, { text, targetLang, sourceLang }) => {
    try {
      const result = await api.translate(text, targetLang, sourceLang);
      return { success: true, translatedText: result.translatedText, detectedLanguage: result.detectedLanguage };
    } catch (e) {
      console.error('Translation failed:', e.message);
      if (e.authRequired) showActivationWindow();
      return { success: false, error: e.message, authRequired: !!e.authRequired };
    }
  });

  // Get supported languages
  ipcMain.handle('get-supported-languages', async () => {
    try {
      const languages = await api.getSupportedLanguages();
      return { success: true, languages };
    } catch (e) {
      console.error('Get languages failed:', e.message);
      return { success: false, error: e.message, languages: [] };
    }
  });

  // Check server health
  ipcMain.handle('check-server-health', async () => {
    try {
      const health = await api.checkServicesHealth();
      return health.whisper && health.translate;
    } catch (e) {
      console.error('Server health check failed:', e.message);
      return false;
    }
  });
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => { /* ... existing code ... */ });
app.on('activate', () => { /* ... existing code ... */ });
