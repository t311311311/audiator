const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog } = require('electron');
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
    { label: 'Show App', click: () => { mainWindow.show(); }},
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); }},
  ]);

  tray.setToolTip('Tray Translator');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
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
  createWindow();
  createTray();
  broadcastSettings(); // Apply settings on startup
  
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
    const defaultName = `ad_${formattedTimestamp}.webm`; // Default to the audio name
    dialog.showSaveDialog({
      title: 'Save Audio and Text',
      defaultPath: defaultName,
      filters: [{ name: 'WebM Audio', extensions: ['webm'] }] // Suggest WebM by default
    }).then(result => {
      if (!result.canceled && result.filePath) {
        // Construct paths based on user's choice, but force our naming convention for the final files
        const dir = path.dirname(result.filePath);
        const audioPath = path.join(dir, `ad_${formattedTimestamp}.webm`);
        const textPath = path.join(dir, `tr_${formattedTimestamp}.txt`);

        // Save audio
        fs.writeFile(audioPath, audio, (err) => {
          if (err) console.error('Failed to save audio:', err);
          else console.log('Audio saved successfully:', audioPath);
        });

        // Save text
        fs.writeFile(textPath, text, (err) => {
          if (err) console.error('Failed to save text:', err);
          else console.log('Text saved successfully:', textPath);
        });
      }
    }).catch(err => console.error('Error showing save dialog for audio/text:', err));
  });
});

app.on('window-all-closed', () => { /* ... existing code ... */ });
app.on('activate', () => { /* ... existing code ... */ });
