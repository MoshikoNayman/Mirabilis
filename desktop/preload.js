'use strict';
// Preload runs in a sandboxed context.
// Keep it minimal - only expose what the renderer actually needs.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,

  // Go Dark lives in the renderer, but the update check runs in the main
  // process, which is outside both the renderer and the backend send path.
  // Without this the main process would have no way to honour the lockdown,
  // and "nothing leaves the machine" would quietly stop being true. The main
  // process refuses to check until this has been called with false.
  setLocalOnly: (on) => ipcRenderer.invoke('mirabilis:set-local-only', on === true),

  checkForUpdates: () => ipcRenderer.invoke('mirabilis:check-for-updates')
});
