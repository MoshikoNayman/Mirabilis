'use strict';

// Must be set before app is ready
const { app, BrowserWindow, shell, Tray, Menu, nativeImage } = require('electron');
app.name = 'Mirabilis AI';
const path = require('node:path');
const { fork } = require('node:child_process');
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const ROOT_DIR = path.join(__dirname, '..');

// When packaged, child processes need real filesystem paths (not virtual asar paths).
// asarUnpack ensures backend and standalone are in app.asar.unpacked on disk.
const SPAWN_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked')
  : ROOT_DIR;

const ICON_PATH = path.join(__dirname, 'icons', process.platform === 'darwin' ? 'icon.icns' : 'icon.png');

// Custom About panel (macOS)
if (process.platform === 'darwin') {
  app.setAboutPanelOptions({
    applicationName: 'Mirabilis AI',
    applicationVersion: '26.3R1-S25',
    version: '',
    copyright: '\u00a9 2025 Moshiko Nayman',
    credits: 'Privacy-first local AI assistant',
    iconPath: path.join(__dirname, 'icons', 'icon.png')
  });
}

let mainWindow = null;
let tray = null;
let backendProc = null;
let frontendProc = null;
let servicesStarted = false;

// ── Resolve paths ──────────────────────────────────────────────────────────
const BACKEND_DIR  = path.join(SPAWN_ROOT, 'backend');
const FRONTEND_DIR = path.join(ROOT_DIR, 'frontend');
// Standalone server.js is at frontend/.next/standalone/frontend/server.js
// (Next.js inferred workspace root as Mirabilis-electron root)
const STANDALONE_SERVER = path.join(SPAWN_ROOT, 'frontend', '.next', 'standalone', 'frontend', 'server.js');
const LOG_DIR      = app.getPath('logs');

// ── Logging helpers ────────────────────────────────────────────────────────
function makeLog(name) {
  const logPath = path.join(LOG_DIR, `${name}.log`);
  return fs.createWriteStream(logPath, { flags: 'a' });
}

// ── Start backend (Express) ────────────────────────────────────────────────
function startBackend() {
  return new Promise((resolve, reject) => {
    const out = makeLog('backend');
    // Use process.execPath (Electron binary, which also runs Node) to execute server.js
    // When packaged, backend is asarUnpacked so cwd is a real directory
    backendProc = spawn(process.execPath, ['src/server.js'], {
      cwd: BACKEND_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: '1' }
    });
    backendProc.stdout.pipe(out);
    backendProc.stderr.pipe(out);

    // Give backend up to 30s to start (Windows + Defender needs extra time)
    const deadline = Date.now() + 30000;
    const check = setInterval(async () => {
      try {
        const res = await fetch('http://localhost:4000/api/providers/health', { signal: AbortSignal.timeout(1000) });
        if (res.ok) { clearInterval(check); resolve(); }
      } catch {
        if (Date.now() > deadline) { clearInterval(check); reject(new Error('Backend did not start in time')); }
      }
    }, 500);

    backendProc.on('error', (err) => { clearInterval(check); reject(err); });
    backendProc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearInterval(check);
        reject(new Error(`Backend exited with code ${code} — check ${path.join(LOG_DIR, 'backend.log')}`));
      }
    });
  });
}

// ── Start Next.js frontend ─────────────────────────────────────────────────
function startFrontend() {
  return new Promise((resolve, reject) => {
    const out = makeLog('frontend');
    const isWin = process.platform === 'win32';

    if (app.isPackaged) {
      // Packaged: use the standalone server.js (no npm/node_modules needed)
      frontendProc = spawn(process.execPath, [STANDALONE_SERVER], {
        cwd: path.dirname(STANDALONE_SERVER),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: '3000', HOSTNAME: '127.0.0.1', NEXT_TELEMETRY_DISABLED: '1', ELECTRON_RUN_AS_NODE: '1' }
      });
    } else {
      // Dev: use npm run start
      frontendProc = spawn(
        isWin ? 'cmd.exe' : 'npm',
        isWin ? ['/d', '/s', '/c', 'npm', 'run', 'start'] : ['run', 'start'],
        {
          cwd: FRONTEND_DIR,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PORT: '3000', NEXT_TELEMETRY_DISABLED: '1' }
        }
      );
    }
    frontendProc.stdout.pipe(out);
    frontendProc.stderr.pipe(out);

    const deadline = Date.now() + 30000;
    const check = setInterval(async () => {
      try {
        const res = await fetch('http://localhost:3000', { signal: AbortSignal.timeout(1000) });
        if (res.ok || res.status < 500) { clearInterval(check); resolve(); }
      } catch {
        if (Date.now() > deadline) { clearInterval(check); reject(new Error('Frontend did not start in time')); }
      }
    }, 1000);

    frontendProc.on('error', (err) => { clearInterval(check); reject(err); });
  });
}

// ── Create the browser window ──────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Mirabilis',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadURL('http://localhost:3000');

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (e) => {
    // On macOS keep running in tray when window is closed
    if (process.platform === 'darwin' && !app.isQuiting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Tray icon ──────────────────────────────────────────────────────────────
function createTray() {
  // Use a blank 16x16 tray icon (replace with actual icon later)
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icons', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Mirabilis');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show', click: () => { mainWindow ? mainWindow.show() : createWindow(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuiting = true; app.quit(); } }
  ]));
  tray.on('click', () => { mainWindow ? mainWindow.show() : createWindow(); });
}

// ── App lifecycle ──────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Override the default application menu so nothing says "Electron"
  const appMenu = Menu.buildFromTemplate([
    {
      label: 'Mirabilis AI',
      submenu: [
        { label: 'About Mirabilis AI', role: 'about' },
        { type: 'separator' },
        { label: 'Hide Mirabilis AI', accelerator: 'Command+H', role: 'hide' },
        { label: 'Hide Others', accelerator: 'Command+Option+H', role: 'hideOthers' },
        { label: 'Show All', role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit Mirabilis AI', accelerator: 'Command+Q', click: () => { app.isQuiting = true; app.quit(); } }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' }, { role: 'zoom' }, { role: 'front' }
      ]
    }
  ]);
  Menu.setApplicationMenu(appMenu);

  if (process.platform === 'darwin') {
    // Set dock icon explicitly (BrowserWindow icon option doesn't affect dock on macOS)
    const dockIcon = nativeImage.createFromPath(path.join(__dirname, 'icons', 'icon.png'));
    app.dock.setIcon(dockIcon);
    createTray();
  }

  try {
    await Promise.all([startBackend(), startFrontend()]);
    servicesStarted = true;
  } catch (err) {
    const { dialog } = require('electron');
    dialog.showErrorBox('Mirabilis failed to start', err.message);
    app.quit();
    return;
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on('window-all-closed', () => {
  // On macOS, keep the app alive in the tray
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  app.isQuiting = true;
  if (frontendProc) { frontendProc.kill(); frontendProc = null; }
  if (backendProc)  { backendProc.kill();  backendProc = null; }
});
