/**
 * main.js — Vision Assistant Electron Main Process
 *
 * Features:
 *  - Frameless, transparent, always-on-top floating window
 *  - Global shortcut (CommandOrControl+Shift+Space) to toggle visibility
 *  - desktopCapturer IPC for screen capture
 *  - Persistent settings via electron-store
 *  - Auto-hide on focus loss (configurable)
 *  - System tray icon with menu
 */

'use strict';

const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  desktopCapturer,
  screen,
  Tray,
  Menu,
  nativeImage,
  shell,
  dialog,
  session,
} = require('electron');

const path = require('path');
const Store = require('electron-store');

// ─── Persistent store (replaces chrome.storage.local) ────────────────────────
const store = new Store({
  name: 'vision-assistant-config',
  defaults: {
    apiKey:      '',
    chatHistory: [],
    userMemory:  {},
    isDarkMode:  true,
    autoSpeak:   false,
    windowBounds: null,
  },
});

// ─── Globals ──────────────────────────────────────────────────────────────────
let mainWindow = null;
let tray       = null;
const isDev    = process.argv.includes('--dev');

// ─── Window Creation ──────────────────────────────────────────────────────────
function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;

  // Restore last position or default to top-right corner
  const savedBounds = store.get('windowBounds');
  const winWidth  = 440;
  const winHeight = 700;
  const defaultX  = sw - winWidth - 20;
  const defaultY  = 40;

  mainWindow = new BrowserWindow({
    width:  winWidth,
    height: winHeight,
    x: savedBounds?.x ?? defaultX,
    y: savedBounds?.y ?? defaultY,

    // Frameless floating window
    frame:           false,
    transparent:     true,
    backgroundColor: '#00000000',
    hasShadow:       true,
    alwaysOnTop:     true,
    skipTaskbar:     false,
    resizable:       true,
    minWidth:        360,
    minHeight:       500,

    // Security
    webPreferences: {
      preload:             path.join(__dirname, 'preload.js'),
      contextIsolation:    true,
      nodeIntegration:     false,
      sandbox:             false,        // needed for desktopCapturer in preload
      webSecurity:         true,
      allowRunningInsecureContent: false,
    },

    // Show after ready-to-show to avoid white flash
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Show window without flash
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // Save window position on move/resize
  mainWindow.on('moved', saveWindowBounds);
  mainWindow.on('resized', saveWindowBounds);

  // Prevent accidental close — hide instead
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function saveWindowBounds() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    store.set('windowBounds', mainWindow.getBounds());
  }
}

// ─── System Tray ──────────────────────────────────────────────────────────────
function createTray() {
  // Use a blank 16x16 nativeImage as placeholder (replace with real icon path)
  const iconPath = path.join(__dirname, 'src', 'assets', 'tray-icon.png');
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
    if (trayIcon.isEmpty()) throw new Error('empty');
  } catch {
    // Fallback: 1x1 transparent PNG
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('Vision Assistant');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show / Hide',
      click: toggleWindow,
    },
    { type: 'separator' },
    {
      label: 'Open DevTools',
      visible: isDev,
      click: () => mainWindow?.webContents.openDevTools({ mode: 'detach' }),
    },
    {
      label: 'Quit Vision Assistant',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', toggleWindow);
}

// ─── Toggle Window Visibility ─────────────────────────────────────────────────
function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

// ─── Global Shortcut ──────────────────────────────────────────────────────────
function registerShortcuts() {
  const shortcut = 'CommandOrControl+Shift+Space';
  const ok = globalShortcut.register(shortcut, toggleWindow);
  if (!ok) {
    console.warn('[VisionAssistant] Global shortcut registration failed:', shortcut);
  } else {
    console.log('[VisionAssistant] Global shortcut registered:', shortcut);
  }
}

// ─── Permission Handlers ──────────────────────────────────────────────────────────────
function registerPermissionHandlers() {
  const ses = session.defaultSession;

  // Automatically grant microphone / media permissions without a system dialog.
  // This is required for the Web Speech API (SpeechRecognition) to work in
  // Electron's renderer process.
  const ALLOWED = new Set(['microphone', 'media', 'audioCapture', 'mediaKeySystem']);

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (ALLOWED.has(permission)) {
      console.log(`[VisionAssistant] Permission granted: ${permission}`);
      callback(true);
    } else {
      console.log(`[VisionAssistant] Permission denied: ${permission}`);
      callback(false);
    }
  });

  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    return ALLOWED.has(permission);
  });

  // ─── Configure Web Speech API external access ───────────────────────────────────────
  // webkitSpeechRecognition requires access to Google's speech recognition servers.
  // Set proper headers and disable CORS enforcement for this specific use case.
  ses.webRequest.onBeforeSendHeaders(
    { urls: ['*://www.google.com/*', '*://*.googleapis.com/*'] },
    (details, callback) => {
      // Add headers to identify as a legitimate Electron client
      details.requestHeaders['User-Agent'] = `electron/${process.versions.electron} (webkitSpeechRecognition)`;
      callback({ requestHeaders: details.requestHeaders });
    }
  );
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

// ── Storage ──
ipcMain.handle('store:get', (_e, key) => store.get(key));
ipcMain.handle('store:set', (_e, key, value) => { store.set(key, value); });
ipcMain.handle('store:delete', (_e, key) => { store.delete(key); });
ipcMain.handle('store:getAll', () => store.store);
ipcMain.handle('store:clear', () => { store.clear(); });

// ── Window controls ──
ipcMain.on('window:hide',    () => mainWindow?.hide());
ipcMain.on('window:close',   () => { app.isQuitting = true; app.quit(); });
ipcMain.on('window:minimize',() => mainWindow?.minimize());
ipcMain.on('window:pin',     (_e, alwaysOnTop) => mainWindow?.setAlwaysOnTop(alwaysOnTop));

// ── Screen capture ──
ipcMain.handle('capture:getSources', async (_e, opts = {}) => {
  try {
    const sources = await desktopCapturer.getSources({
      types:         opts.types         || ['screen', 'window'],
      thumbnailSize: opts.thumbnailSize || { width: 1280, height: 720 },
      fetchWindowIcons: false,
    });

    // Return serialisable data (strip non-serialisable objects)
    return sources.map(s => ({
      id:           s.id,
      name:         s.name,
      thumbnail:    s.thumbnail.toDataURL(),   // base64 PNG
      display_id:   s.display_id,
    }));
  } catch (err) {
    console.error('[VisionAssistant] desktopCapturer error:', err);
    return [];
  }
});

// ── Open external links safely ──
ipcMain.on('shell:openExternal', (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

// ── App info ──
ipcMain.handle('app:getVersion', () => app.getVersion());
ipcMain.handle('app:isDev',      () => isDev);

// ─── App Lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Must run BEFORE createWindow so the permission handler is active
  // when the renderer process first requests microphone access.
  registerPermissionHandlers();

  createWindow();
  createTray();
  registerShortcuts();

  app.on('activate', () => {
    // macOS: re-create window if dock icon clicked and no windows open
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on('window-all-closed', () => {
  // On macOS keep process alive even with no windows
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('second-instance', () => {
  // Focus existing window if a second instance is launched
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// Enforce single instance
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
