'use strict';
// desktop/updater.js
// The Electron half of updates. All of the judgement lives in updatePolicy.js;
// this file is the wiring, kept thin so the parts worth testing are testable.
//
// Shape of the feature, and why:
//
//   Nothing is downloaded without being asked. autoDownload is off. A local
//   first app that silently pulls a binary in the background is not one.
//
//   Nothing is checked while Go Dark is on, or before we know whether it is.
//   See updatePolicy.js. The renderer reports the state over IPC.
//
//   On an unsigned macOS build we do not offer to install. Squirrel.Mac will
//   not swap an unsigned bundle, so the download would fail at the last step.
//   We open the releases page instead and say why.

const { app, dialog, shell, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const { shouldCheck, installMode, shouldNotify } = require('./updatePolicy.js');

const RELEASES_URL = 'https://github.com/MoshikoNayman/Mirabilis/releases/latest';

// Set at build time once the app is signed and notarized. Until then macOS
// updates are notify-only, which is the truth rather than a broken button.
const SIGNED_BUILD = process.env.MIRABILIS_SIGNED === '1';

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'update-settings.json');

/** Same 0600 standard as every other file the app writes. */
function readSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      enabled: parsed.enabled !== false,
      skippedVersion: typeof parsed.skippedVersion === 'string' ? parsed.skippedVersion : '',
      lastCheckAt: Number(parsed.lastCheckAt) || 0
    };
  } catch {
    return { enabled: true, skippedVersion: '', lastCheckAt: 0 };
  }
}

function writeSettings(next) {
  try {
    const file = SETTINGS_FILE();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } catch {
    // A settings write failing must never break the app. The cost is one
    // extra check next launch.
  }
}

let localOnly = null;      // null until the renderer reports: fail closed
let checking = false;
let started = false;

function log(...args) {
  console.log('[updater]', ...args);
}

/**
 * electron-updater is loaded lazily. It is only needed in a packaged build, and
 * requiring it in dev pulls in a module that expects app-update.yml to exist.
 */
function loadAutoUpdater() {
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };
  return autoUpdater;
}

async function openReleasesPage() {
  await shell.openExternal(RELEASES_URL);
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.userInitiated] a manual check reports "you are up to
 *   date" and ignores the rate limit; a launch check stays silent.
 */
async function check({ userInitiated = false } = {}) {
  if (checking) return;
  const settings = readSettings();
  const decision = shouldCheck({
    isPackaged: app.isPackaged,
    localOnly,
    enabled: settings.enabled,
    now: Date.now(),
    lastCheckAt: userInitiated ? 0 : settings.lastCheckAt
  });

  if (!decision.check) {
    log('skipping check:', decision.reason);
    if (userInitiated) {
      // A manual check must always say something. Silence reads as a bug.
      dialog.showMessageBox({
        type: 'info',
        title: 'Check for Updates',
        message: 'Not checking right now',
        detail: `${decision.reason}.\n\nYou can always see the latest release at:\n${RELEASES_URL}`,
        buttons: ['Open Releases', 'Close'],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      }).then(({ response }) => { if (response === 0) openReleasesPage(); });
    }
    return;
  }

  checking = true;
  try {
    const autoUpdater = loadAutoUpdater();
    writeSettings({ ...settings, lastCheckAt: Date.now() });

    const result = await autoUpdater.checkForUpdates();
    const available = result?.updateInfo?.version || '';
    const current = app.getVersion();
    const verdict = shouldNotify({ available, current, skipped: settings.skippedVersion });

    if (!verdict.notify) {
      log('no update offered:', verdict.reason);
      if (userInitiated) {
        await dialog.showMessageBox({
          type: 'info',
          title: 'Check for Updates',
          message: `Mirabilis ${current} is up to date`,
          buttons: ['OK'],
          noLink: true
        });
      }
      return;
    }

    await offer({ autoUpdater, available, current, settings });
  } catch (err) {
    log('check failed:', err?.message || err);
    if (userInitiated) {
      await dialog.showMessageBox({
        type: 'warning',
        title: 'Check for Updates',
        message: 'Could not check for updates',
        detail: `${err?.message || err}\n\nYou can check manually at:\n${RELEASES_URL}`,
        buttons: ['Open Releases', 'Close'],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      }).then(({ response }) => { if (response === 0) openReleasesPage(); });
    }
  } finally {
    checking = false;
  }
}

async function offer({ autoUpdater, available, current, settings }) {
  const mode = installMode(process.platform, SIGNED_BUILD);

  if (mode === 'manual') {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Update available',
      message: `Mirabilis ${available} is available`,
      detail: `You have ${current}.\n\nThis build is not code signed, so it cannot replace itself. `
        + 'Download the new version and drag it over the old one.',
      buttons: ['Download', 'Skip This Version', 'Later'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    });
    if (response === 0) await openReleasesPage();
    if (response === 1) writeSettings({ ...readSettings(), skippedVersion: available });
    return;
  }

  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'Update available',
    message: `Mirabilis ${available} is available`,
    detail: `You have ${current}. Download it now? The app restarts to finish installing.`,
    buttons: ['Download', 'Skip This Version', 'Later'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  });
  if (response === 1) { writeSettings({ ...readSettings(), skippedVersion: available }); return; }
  if (response !== 0) return;

  try {
    await autoUpdater.downloadUpdate();
    const { response: install } = await dialog.showMessageBox({
      type: 'info',
      title: 'Update ready',
      message: `Mirabilis ${available} is ready to install`,
      detail: 'The app will close, install the update, and reopen.',
      buttons: ['Restart Now', 'On Next Quit'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (install === 0) {
      app.isQuiting = true;
      autoUpdater.quitAndInstall();
    } else {
      autoUpdater.autoInstallOnAppQuit = true;
    }
  } catch (err) {
    log('download failed:', err?.message || err);
    await dialog.showMessageBox({
      type: 'warning',
      title: 'Update failed',
      message: 'The update could not be downloaded',
      detail: `${err?.message || err}\n\nYou can download it manually at:\n${RELEASES_URL}`,
      buttons: ['Open Releases', 'Close'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    }).then(({ response: r }) => { if (r === 0) openReleasesPage(); });
  }
}

/**
 * Wire up IPC and schedule the launch check.
 *
 * The launch check is deliberately late and event driven rather than on a
 * timer: it runs when the renderer reports Go Dark is off, which is the first
 * moment it is allowed to run at all.
 */
function initUpdater() {
  if (started) return;
  started = true;

  ipcMain.handle('mirabilis:set-local-only', (_event, value) => {
    const next = value === true;
    const first = localOnly === null;
    localOnly = next;
    // First honest "not locked down" we have seen: this is the earliest moment
    // a check is permitted, so take it rather than waiting for a timer.
    if (first && next === false) setTimeout(() => { check({ userInitiated: false }); }, 5000).unref?.();
    return true;
  });

  ipcMain.handle('mirabilis:check-for-updates', () => { check({ userInitiated: true }); return true; });
}

/** Menu and tray entry. */
function updateMenuItem() {
  return { label: 'Check for Updates...', click: () => check({ userInitiated: true }) };
}

module.exports = { initUpdater, updateMenuItem, checkForUpdates: check, RELEASES_URL };
