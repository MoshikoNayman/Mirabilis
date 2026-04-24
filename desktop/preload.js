'use strict';
// Preload runs in a sandboxed context.
// Keep it minimal — only expose what the renderer actually needs.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform
});
