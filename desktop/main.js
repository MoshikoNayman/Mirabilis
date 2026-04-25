'use strict';

// Must be set before app is ready
const { app, BrowserWindow, shell, Tray, Menu, nativeImage, dialog } = require('electron');
app.name = 'Mirabilis AI';

// ── Single-instance lock ───────────────────────────────────────────────────
// Prevents a second launch fighting over ports 3000/4000
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
}
const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs');

// Windows: set AppUserModelId so the taskbar groups correctly, pinning works,
// and toast notifications show the right icon/name.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.mirabilis.ai');
}

const ROOT_DIR = path.join(__dirname, '..');

// When packaged, backend/frontend standalone are copied via extraResources
// and live directly under process.resourcesPath.
const SPAWN_ROOT = app.isPackaged
  ? process.resourcesPath
  : ROOT_DIR;

const ICON_PATH = path.join(__dirname, 'icons',
  process.platform === 'darwin' ? 'icon.icns' :
  process.platform === 'win32'  ? 'Mirabilis.ico' :
  'icon.png');

// Custom About panel (macOS)
if (process.platform === 'darwin') {
  app.setAboutPanelOptions({
    applicationName: 'Mirabilis AI',
    applicationVersion: app.getVersion(),
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
// Next standalone output can be either:
// - frontend/.next/standalone/frontend/server.js
// - frontend/.next/standalone/server.js
const STANDALONE_SERVER_CANDIDATES = [
  path.join(SPAWN_ROOT, 'frontend', '.next', 'standalone', 'frontend', 'server.js'),
  path.join(SPAWN_ROOT, 'frontend', '.next', 'standalone', 'server.js')
];

function resolveStandaloneServer() {
  for (const candidate of STANDALONE_SERVER_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return STANDALONE_SERVER_CANDIDATES[0];
}
const LOG_DIR      = app.getPath('logs');

// ── Logging helpers ────────────────────────────────────────────────────────
function makeLog(name) {
  const logPath = path.join(LOG_DIR, `${name}.log`);
  return fs.createWriteStream(logPath, { flags: 'a' });
}

function buildStartupDiagnostics(err) {
  const checks = [
    { label: 'Backend dir', value: BACKEND_DIR, exists: fs.existsSync(BACKEND_DIR) },
    { label: 'Backend entry', value: path.join(BACKEND_DIR, 'src', 'server.js'), exists: fs.existsSync(path.join(BACKEND_DIR, 'src', 'server.js')) },
    {
      label: 'Frontend standalone entry',
      value: resolveStandaloneServer(),
      exists: STANDALONE_SERVER_CANDIDATES.some((candidate) => fs.existsSync(candidate))
    },
    { label: 'Backend log', value: path.join(LOG_DIR, 'backend.log'), exists: fs.existsSync(path.join(LOG_DIR, 'backend.log')) },
    { label: 'Frontend log', value: path.join(LOG_DIR, 'frontend.log'), exists: fs.existsSync(path.join(LOG_DIR, 'frontend.log')) }
  ];

  const lines = [
    `Reason: ${err?.message || String(err)}`,
    `Platform: ${process.platform}`,
    `Packaged: ${app.isPackaged ? 'yes' : 'no'}`,
    `resourcesPath: ${process.resourcesPath}`,
    `userData: ${app.getPath('userData')}`,
    `logs: ${LOG_DIR}`,
    '',
    'Checks:'
  ];

  for (const item of checks) {
    lines.push(`- ${item.label}: ${item.exists ? 'OK' : 'MISSING'}`);
    lines.push(`  ${item.value}`);
  }

  return lines.join('\n');
}

// ── Start backend (Express) ────────────────────────────────────────────────
function startBackend() {
  return new Promise((resolve, reject) => {
    const out = makeLog('backend');
    // Use process.execPath (Electron binary, which also runs Node) to execute server.js
    // When packaged, backend is copied under process.resourcesPath (extraResources)
    backendProc = spawn(process.execPath, ['src/server.js'], {
      cwd: BACKEND_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: '1', DATA_DIR: app.getPath('userData') }
    });
    backendProc.stdout.pipe(out);
    backendProc.stderr.pipe(out);

    // Give backend up to 30s to start (Windows + Defender needs extra time)
    const deadline = Date.now() + 30000;
    const check = setInterval(async () => {
      try {
        const res = await fetch('http://localhost:4000/health', { signal: AbortSignal.timeout(1000) });
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
  }).then(() => {
    // Runtime crash handler — fires if backend dies after successful startup
    backendProc.once('exit', (code) => {
      if (code !== 0 && code !== null && !app.isQuiting) {
        dialog.showErrorBox('Mirabilis — backend crashed',
          `Backend exited unexpectedly (code ${code}).\nCheck ${path.join(LOG_DIR, 'backend.log')}`);
        app.quit();
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
      const standaloneServer = resolveStandaloneServer();
      frontendProc = spawn(process.execPath, [standaloneServer], {
        cwd: path.dirname(standaloneServer),
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
    // Minimize to tray on both macOS and Windows instead of quitting
    if (!app.isQuiting) {
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
  if (process.platform === 'darwin') {
    // macOS: keep a proper app menu (required for standard Mac keyboard shortcuts)
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
  } else {
    // Windows/Linux: no menu bar — cleaner UI for a chat app.
    // Users can still right-click the tray icon to quit.
    Menu.setApplicationMenu(null);
  }

  // Tray on all platforms — lets the app run in the background
  createTray();

  if (process.platform === 'darwin') {
    // Set dock icon explicitly (BrowserWindow icon option doesn't affect dock on macOS)
    const dockIcon = nativeImage.createFromPath(path.join(__dirname, 'icons', 'icon.png'));
    app.dock.setIcon(dockIcon);
  }

  try {
    await Promise.all([startBackend(), startFrontend()]);
    servicesStarted = true;
  } catch (err) {
    const details = buildStartupDiagnostics(err);
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: 'Mirabilis failed to start',
      message: 'Mirabilis failed to start',
      detail: details,
      buttons: ['Open Logs Folder', 'Quit'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (choice === 0) {
      shell.openPath(LOG_DIR);
    }
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

// ── Orphaned process cleanup ───────────────────────────────────────────────
// Kill child processes on any exit path including crashes
function killChildren() {
  try { if (frontendProc) { frontendProc.kill('SIGKILL'); frontendProc = null; } } catch {}
  try { if (backendProc)  { backendProc.kill('SIGKILL');  backendProc = null; } } catch {}
}

app.on('before-quit', () => {
  app.isQuiting = true;
  killChildren();
});

process.on('exit', killChildren);
process.on('SIGTERM', killChildren);
