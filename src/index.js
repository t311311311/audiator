const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, globalShortcut, screen, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const i18n = require('./i18n');

// --- Initialize Settings Store ---
const store = new Store({
  defaults: {
    theme: 'dark',
    opacity: 0.8, // Default to 80% opaque
    fontSize: 16,
    fontFamily: 'Arial',
    whisperModel: 'small', // recognition quality: base | small | large-v3-turbo
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

// --- Recording overlay ("barrels") -------------------------------------------
// A compact always-on-top bar at the bottom of the screen that stands in for
// the main window while it is out of sight. It shows one barrel per recording
// the user has not dealt with yet (see record-queue.js): recording (level
// meter) -> transcribing -> "Ctrl+V". Clicking it brings the main window back.
const { RecordQueue } = require('./record-queue');
const queue = new RecordQueue();
// Sizes in step with recorder-overlay.html: a numbered barrel is wider so the
// number fits beside its two lines of text.
const BARREL_W = 96, BARREL_W_NUMBERED = 112, MORE_W = 34, BARREL_GAP = 6, BAR_H = 40;
let offeredId = null;       // the job whose text is on the clipboard right now
let holdClipboardUntil = 0; // after a paste, leave the clipboard alone for a moment

// --- Paste detection -------------------------------------------------------
// Windows never tells an application that the user pasted, so the only way to
// move the queue on at the paste itself is a system-wide key hook. It is
// deliberately started only while a "Ctrl+V" barrel is on screen and stopped
// the moment none is, so the app is not watching the keyboard during normal
// use. If the native module is missing the app carries on without paste
// detection.
let uiohook = null;
let hookRunning = false;
try {
  uiohook = require('uiohook-napi');
} catch (e) {
  console.error('uiohook-napi unavailable, paste detection disabled:', e.message);
}

// Whether Ctrl is held, tracked from the hook's own key events. The event's
// ctrlKey flag cannot be trusted: right after the hook starts it reports
// false for the first Ctrl+key (measured: false on the first press after
// every start, true from the second), so the first paste was missed and the
// "Ctrl+V" barrel only went away on the second one.
let ctrlHeld = false;

const startPasteWatch = () => {
  if (!uiohook || hookRunning) return;
  try {
    ctrlHeld = false;
    uiohook.uIOhook.start();
    hookRunning = true;
  } catch (e) {
    console.error('could not start the key hook:', e.message);
  }
};

const stopPasteWatch = () => {
  if (!uiohook || !hookRunning) return;
  try {
    uiohook.uIOhook.stop();
    hookRunning = false;
  } catch (e) {
    console.error('could not stop the key hook:', e.message);
  }
};

if (uiohook) {
  const { UiohookKey } = uiohook;
  const CTRL_KEYS = [UiohookKey.Ctrl, UiohookKey.CtrlRight];
  uiohook.uIOhook.on('keyup', (e) => {
    if (CTRL_KEYS.includes(e.keycode)) ctrlHeld = false;
  });
  uiohook.uIOhook.on('keydown', (e) => {
    if (CTRL_KEYS.includes(e.keycode)) { ctrlHeld = true; return; }
    if (!queue.active) return; // only ever acted on while a "Ctrl+V" barrel is up
    if (e.keycode === UiohookKey.V && (ctrlHeld || e.ctrlKey || e.metaKey)) {
      console.log('[overlay] paste detected -> next barrel');
      queue.pasted();
      offeredId = null;
      // The other application is still carrying out this paste: putting the
      // next text on the clipboard straight away could get that pasted instead.
      holdClipboardUntil = Date.now() + 300;
      refreshOverlay();                  // the pasted barrel goes at once
      setTimeout(refreshOverlay, 320);   // the next text goes on the clipboard
    }
  });
}

const createOverlay = () => {
  const width = BARREL_W, height = BAR_H; // resized to fit the barrels as they come and go
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
  // Keep the bar out of screen sharing and screen recording: the user sees it,
  // viewers and recordings do not. On Windows 10 2004+ this excludes the window
  // from capture entirely (older Windows would show a black box instead).
  overlayWindow.setContentProtection(true);
  overlayWindow.loadFile(path.join(__dirname, 'recorder-overlay.html'));
  overlayWindow.webContents.on('did-finish-load', () => refreshOverlay());
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
  // Opening the window (bar, tray icon, tray menu) also deals with the
  // finished transcripts: refreshOverlay() drops them once it has focus.
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

// Whether the user is actually looking at the app: the main window is shown,
// not minimised, and one of our windows has focus. isVisible() alone is not
// enough — a window left open behind another application still counts as
// visible, and that hid the bar whenever the user just switched apps while
// recording.
// Focus is also tracked from the window events themselves (see the
// browser-window-focus/blur handlers): the user found barrels on screen while
// looking at the window, so "in view" no longer rests on one query alone.
let ownFocus = null; // the window of ours that last gained focus, null after a blur
let overlayShown = false; // last show/hide decision (logged when it changes)

const mainInView = () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (!mainWindow.isVisible() || mainWindow.isMinimized()) return false;
  const focused = BrowserWindow.getFocusedWindow() || ownFocus;
  return !!focused && !focused.isDestroyed() && focused !== overlayWindow;
};

// Bring the clipboard, the paste watch and the bar in line with the queue.
// The overlay and the main window are two views of the same state: the bar
// shows only while the queue has something in it and the main window is out
// of sight. Coming back to the window deals with every finished transcript
// (it is right there in the history), or it would pop up again the next time
// the user leaves.
const refreshOverlay = () => {
  const inView = mainInView();
  if (inView) queue.dropDone();

  const active = queue.active;
  if (active && active.id !== offeredId && Date.now() >= holdClipboardUntil) {
    clipboard.writeText(active.text);
    offeredId = active.id;
  }
  if (active && !inView) startPasteWatch(); else stopPasteWatch();

  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const items = queue.view();
  const numbered = queue.jobs.length > 1; // a lone barrel looks exactly as before
  if (items.length) {
    const barrelW = numbered ? BARREL_W_NUMBERED : BARREL_W;
    const width = items.reduce((w, it) => w + (it.more ? MORE_W : barrelW), 0) +
                  BARREL_GAP * (items.length - 1);
    if (overlayWindow.getSize()[0] !== width) {
      const area = screen.getPrimaryDisplay().workAreaSize;
      overlayWindow.setBounds({
        x: Math.round((area.width - width) / 2), y: area.height - BAR_H - 16,
        width, height: BAR_H,
      });
    }
    overlayWindow.webContents.send('overlay-state', {
      items,
      numbered,
      busy: [tr('ov.busy1'), tr('ov.busy2')],
      done: [tr('ov.done1'), tr('ov.done2')],
    });
  }
  const show = items.length > 0 && !inView;
  if (show !== overlayShown) {
    // Logged so a bar seen at the wrong moment can be traced from the terminal.
    const f = BrowserWindow.getFocusedWindow();
    console.log(`[overlay] ${show ? 'show' : 'hide'}: barrels=${items.length} inView=${inView} ` +
      `focused=${f === mainWindow ? 'main' : f === overlayWindow ? 'overlay' : f ? 'other-own' : 'none'} ` +
      `tracked=${ownFocus === mainWindow ? 'main' : ownFocus ? 'other-own' : 'none'}`);
    overlayShown = show;
  }
  if (show) {
    if (!overlayWindow.isVisible()) overlayWindow.showInactive();
  } else {
    overlayWindow.hide(); // always: harmless when hidden, sure when it is not
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

// --- Interface language (AUD-33) ---
// The user's choice wins; until they make one, follow the OS language.
const currentLang = () => i18n.resolveLanguage(store.get('language'), app.getLocale());
const tr = (key) => i18n.t(currentLang(), key);

// The tray menu is built once, so it has to be rebuilt when the language changes.
const buildTrayMenu = () => {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: tr('tray.show'), click: () => { revealMainWindow(); }},
    { label: tr('tray.quit'), click: () => { app.isQuitting = true; app.quit(); }},
  ]));
};

const createTray = () => {
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);
  tray.setToolTip('Audiator');
  buildTrayMenu();
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
    title: tr('act.windowTitle'),
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
  
  // Speech recognition runs on this computer in every build. Not awaited:
  // the model loads in the background while the windows come up, and a
  // transcription waits for it (engine.whenReady). A packaged build keeps its
  // models in the user's app data.
  // The model is downloaded on first use; every change of the engine's state
  // goes to the windows (progress bar in the main window, list in Settings).
  const engine = require('./engine');
  // The engine starts on the model that last worked (whisperModelActive), so a
  // newly chosen one still downloading — even across a restart — does not
  // leave the app without speech recognition; the switch follows once the new
  // model is in.
  engine.startEngine({
    packaged: app.isPackaged,
    rootDir: path.join(__dirname, '..'),
    modelsDir: path.join(app.getPath('userData'), 'models'),
    model: store.get('whisperModelActive') || store.get('whisperModel'),
  });
  engine.onStatus((s) => {
    if (s && s.model && s.model !== 'fixed' && s.model !== store.get('whisperModelActive')) {
      store.set('whisperModelActive', s.model);
    }
    BrowserWindow.getAllWindows().forEach((w) => {
      if (!w.isDestroyed()) w.webContents.send('engine-status', s);
    });
  });
  engine.whenReady().then(async () => {
    const wanted = store.get('whisperModel');
    const s = await engine.fetchStatus().catch(() => null);
    const models = (s && s.models) || {};
    // Nothing loaded and the chosen model is not here yet (no model has
    // worked before, or the one that did was deleted): start on one that is
    // on this computer; the chosen one then downloads behind it.
    if (s && !s.model && !s.job && models[wanted] && !models[wanted].installed) {
      const here = ['small', 'base', 'large-v3-turbo'].find((m) => models[m] && models[m].installed);
      if (here) await engine.useModel(here);
    }
    engine.useModel(wanted);
  });
  ipcMain.handle('get-engine-status', () => engine.currentStatus() || engine.fetchStatus().catch(() => null));
  ipcMain.on('engine-retry', () => engine.useModel(store.get('whisperModel')));
  // The user stopped a download: stay with the model in use (and keep it as
  // the choice, so the next start does not download again).
  ipcMain.on('engine-cancel', async () => {
    const inUse = await engine.cancelDownload();
    if (inUse) store.set('whisperModel', inUse);
  });
  ipcMain.handle('engine-delete', (event, name) => engine.deleteModel(name));

  // Development runs talk to the auth gateway and LibreTranslate on this
  // machine too; start whatever is not already up, so `npm start` is all that
  // is needed.
  if (!app.isPackaged) {
    const { startLocalBackend } = require('./local-backend');
    await startLocalBackend(path.join(__dirname, '..'));
  }

  // Check authorization status
  const auth = require('./auth');
  const authStatus = await auth.checkStatus();
  
  createWindow();
  createTray();
  broadcastSettings();
  createOverlay();

  // Global hotkey (works even when the app is in the tray/background): toggle recording.
  // It only toggles recording and leaves the window where it is: it used to
  // hide the window, which the user did not want. The overlay already shows
  // whenever the window is out of sight or behind another application.
  if (!globalShortcut.register('CommandOrControl+Space', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('hotkey-toggle-record');
  })) {
    console.error('Failed to register hotkey Ctrl+Space (already taken by another app)');
  }

  // The recording queue, driven by the renderer that owns the microphone.
  // Every recording carries one id from the start to its transcript.
  ipcMain.on('recording-started', (event, id) => { queue.start(id); refreshOverlay(); });
  ipcMain.on('recording-stopped', (event, id) => { queue.stop(id); refreshOverlay(); });
  ipcMain.on('transcribe-failed', (event, id) => { queue.remove(id); refreshOverlay(); });
  // A transcript is ready. Copied from the main process: navigator.clipboard
  // needs a focused document, and recording usually finishes with the window
  // out of sight. Looking at the window, the user gets it on the clipboard at
  // once (the history shows it). Otherwise it waits its turn in the queue and
  // goes on the clipboard when the barrels before it have been pasted — there
  // is deliberately no timer, a "Ctrl+V" barrel stays until it is acted on.
  // Answers whether the text is on the clipboard now, so the page only
  // confirms what actually happened.
  ipcMain.handle('transcribed', (event, { id, text }) => {
    if (!text) { queue.remove(id); refreshOverlay(); return { copied: false }; }
    if (mainInView()) {
      clipboard.writeText(text);
      queue.remove(id);
      refreshOverlay();
      return { copied: true };
    }
    queue.done(id, text);
    refreshOverlay();
    return { copied: offeredId === id };
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
  // Hiding/minimising the window while recording hands over to the overlay,
  // and so does switching to another application. Focus moving between our own
  // windows (main -> settings), or arriving just after a restore, passes
  // through a moment with no focused window, so wait a beat before deciding,
  // or the bar would flash.
  let syncTimer = null;
  const scheduleSync = () => {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(refreshOverlay, 100);
  };
  ['hide', 'minimize', 'show', 'restore'].forEach((evt) => mainWindow.on(evt, scheduleSync));
  app.on('browser-window-focus', (event, win) => {
    if (win !== overlayWindow) ownFocus = win;
    scheduleSync();
  });
  app.on('browser-window-blur', (event, win) => {
    if (win === ownFocus) ownFocus = null;
    scheduleSync();
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
  // Every window asks for its strings here (they cannot require i18n.js
  // themselves under contextIsolation).
  // An explicit language lets the settings window preview a choice before it
  // is saved; otherwise the saved (or OS-derived) language is used.
  ipcMain.handle('get-i18n', (event, lang) => {
    const use = lang && i18n.LANGUAGES[lang] ? lang : currentLang();
    return { lang: use, languages: i18n.LANGUAGES, strings: i18n.stringsFor(use) };
  });

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
      height: 615, // inside the frame (useContentSize): language row (AUD-33), quality list
      useContentSize: true,
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
    const previousModel = store.get('whisperModel');
    for (const key in settingsToSave) {
      store.set(key, settingsToSave[key]);
    }
    // A new recognition quality: download (if needed) and switch; the old
    // model keeps transcribing until the new one is ready.
    if (store.get('whisperModel') !== previousModel) {
      require('./engine').useModel(store.get('whisperModel'));
    }
    // Apply all saved settings to main window (e.g., opacity)
    mainWindow.setOpacity(store.get('opacity'));
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setOpacity(store.get('opacity')); // keep the overlay in step
    }
    buildTrayMenu(); // the tray menu is static, so relabel it for a new language
    broadcastSettings(); // windows re-read their strings on this event
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
      title: tr('dlg.saveAudio'),
      defaultPath: defaultName,
      filters: [{ name: tr('dlg.filterAudio'), extensions: ['webm'] }]
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
      title: tr('dlg.saveHistory'),
      defaultPath: defaultName,
      filters: [{ name: tr('dlg.filterText'), extensions: ['txt'] }]
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
      title: tr('dlg.saveAudioText'),
      defaultPath: defaultName,
      filters: [{ name: tr('dlg.filterAudio'), extensions: ['webm'] }]
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
      return { success: true, translatedText: result.translatedText };
    } catch (e) {
      console.error('Translation failed:', e.message);
      // missing: the language (source or target) to install first.
      return { success: false, error: e.message, missing: e.missing || null };
    }
  });

  // Translation languages on demand: the catalog, and installing (with
  // progress in the engine status), stopping and deleting a language.
  ipcMain.handle('translate-catalog', () => engine.translateCatalog().catch(() => []));
  ipcMain.on('translate-install', (event, code) => engine.installLanguage(code));
  ipcMain.on('translate-cancel', (event, code) => engine.cancelLanguage(code));
  ipcMain.handle('translate-delete', (event, code) => engine.deleteLanguage(code));

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

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopPasteWatch(); // a live hook would keep the process alive
  require('./engine').stopEngine();
  if (!app.isPackaged) {
    require('./local-backend').stopLocalBackend();
  }
});
app.on('window-all-closed', () => { /* ... existing code ... */ });
app.on('activate', () => { /* ... existing code ... */ });
