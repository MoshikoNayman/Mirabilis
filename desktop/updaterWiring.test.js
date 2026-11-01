'use strict';
// Tests the IPC wiring of updater.js under plain node, with Electron stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const UPDATER = require.resolve('./updater.js');

// Stays installed for the whole file: updater.js loads electron-updater lazily.
let current = null;
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (current && request === 'electron') return current.electron;
  if (current && request === 'electron-updater') { current.state.updaterLoaded += 1; return current.electronUpdater; }
  return realLoad.call(this, request, parent, isMain);
};

/** Load updater.js fresh against stubbed Electron internals. */
function loadUpdater() {
  const handlers = new Map();
  const dialogs = [];
  const opened = [];
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mirabilis-updater-'));
  const state = { updaterLoaded: 0, checked: 0, autoDownload: null, userData };

  const electron = {
    app: { isPackaged: true, getVersion: () => '26.3.1', getPath: () => userData },
    dialog: {
      showMessageBox: async (opts) => { dialogs.push(opts); return { response: 2 }; }
    },
    shell: { openExternal: async (url) => { opened.push(url); } },
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }
  };

  const electronUpdater = {
    autoUpdater: {
      set autoDownload(v) { state.autoDownload = v; },
      get autoDownload() { return state.autoDownload; },
      autoInstallOnAppQuit: false,
      logger: null,
      checkForUpdates: async () => { state.checked += 1; return { updateInfo: { version: '26.3.1' } }; },
      downloadUpdate: async () => {},
      quitAndInstall: () => {}
    }
  };

  current = { electron, electronUpdater, state };
  delete require.cache[UPDATER];
  const mod = require('./updater.js');
  delete require.cache[UPDATER];
  return { mod, handlers, dialogs, opened, state };
}

test('initUpdater registers both IPC channels', () => {
  const { mod, handlers } = loadUpdater();
  mod.initUpdater();
  assert.ok(handlers.has('mirabilis:set-local-only'), 'the renderer must be able to report Go Dark');
  assert.ok(handlers.has('mirabilis:check-for-updates'), 'a manual check must be reachable');
});

test('nothing contacts the update server before the renderer reports in', async () => {
  // localOnly is still null here.
  const { mod, state, dialogs } = loadUpdater();
  mod.initUpdater();
  await mod.checkForUpdates({ userInitiated: false });
  assert.equal(state.updaterLoaded, 0, 'electron-updater must not even be loaded');
  assert.equal(state.checked, 0);
  assert.equal(dialogs.length, 0, 'a launch check stays silent');
});

test('reporting Go Dark ON keeps the update server unreachable', async () => {
  const { mod, handlers, state } = loadUpdater();
  mod.initUpdater();
  await handlers.get('mirabilis:set-local-only')({}, true);
  await mod.checkForUpdates({ userInitiated: false });
  assert.equal(state.checked, 0, 'Go Dark means no egress, including from the main process');
});

test('reporting Go Dark OFF schedules the launch check, and it runs', async () => {
  // Capture the scheduled callback rather than waiting on it.
  const { mod, handlers, state } = loadUpdater();
  mod.initUpdater();

  const realTimeout = global.setTimeout;
  let scheduled = null;
  global.setTimeout = (fn) => { scheduled = fn; return { unref() {} }; };
  try {
    await handlers.get('mirabilis:set-local-only')({}, false);
  } finally {
    global.setTimeout = realTimeout;
  }

  assert.equal(typeof scheduled, 'function', 'the first clear "not locked down" should start a check');
  await scheduled();
  assert.equal(state.checked, 1, 'the scheduled callback should reach the update server');
  assert.equal(state.autoDownload, false, 'nothing is downloaded without being asked');
});

test('the launch check is scheduled once, not on every report', async () => {
  const { mod, handlers } = loadUpdater();
  mod.initUpdater();
  const realTimeout = global.setTimeout;
  let scheduledCount = 0;
  global.setTimeout = () => { scheduledCount += 1; return { unref() {} }; };
  try {
    await handlers.get('mirabilis:set-local-only')({}, false);
    await handlers.get('mirabilis:set-local-only')({}, false);
    await handlers.get('mirabilis:set-local-only')({}, true);
    await handlers.get('mirabilis:set-local-only')({}, false);
  } finally {
    global.setTimeout = realTimeout;
  }
  assert.equal(scheduledCount, 1, 'toggling Go Dark must not queue a check each time');
});

test('a manual check always answers, even when it declines to check', async () => {
  // Silence on a menu click reads as a broken app.
  const { mod, dialogs } = loadUpdater();
  mod.initUpdater();
  await mod.checkForUpdates({ userInitiated: true });
  assert.equal(dialogs.length, 1, 'the user clicked something and must get a reply');
  assert.match(String(dialogs[0].detail), /waiting|Go Dark/);
});

test('the settings file is written owner-only', async () => {
  const { mod, handlers, state } = loadUpdater();
  mod.initUpdater();
  const realTimeout = global.setTimeout;
  let scheduled = null;
  global.setTimeout = (fn) => { scheduled = fn; return { unref() {} }; };
  try {
    await handlers.get('mirabilis:set-local-only')({}, false);
  } finally {
    global.setTimeout = realTimeout;
  }
  await scheduled();

  const file = path.join(state.userData, 'update-settings.json');
  assert.ok(fs.existsSync(file), 'the check should have recorded when it ran');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'same standard as every other file the app writes');
  fs.rmSync(state.userData, { recursive: true, force: true });
});

test('the menu entry is labelled and clickable', () => {
  const { mod } = loadUpdater();
  const item = mod.updateMenuItem();
  assert.match(item.label, /Update/i);
  assert.equal(typeof item.click, 'function');
});
