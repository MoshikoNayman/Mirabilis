'use strict';
// Sandboxed preload: expose only what the renderer needs.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,

  // Go Dark lives in the renderer but the update check runs in main, so main
  // learns it here. Main refuses to check until this is called with false.
  setLocalOnly: (on) => ipcRenderer.invoke('mirabilis:set-local-only', on === true),

  checkForUpdates: () => ipcRenderer.invoke('mirabilis:check-for-updates')
});
