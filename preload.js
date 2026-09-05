/**
 * preload.js — Vision Assistant Secure IPC Bridge
 *
 * Exposes a minimal, typed API surface to the renderer via contextBridge.
 * The renderer has ZERO access to Node.js or Electron internals directly.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// ─── Whitelist of allowed external URLs for shell:openExternal ────────────────
const ALLOWED_EXTERNAL_PREFIXES = [
  'https://aistudio.google.com',
  'https://generativelanguage.googleapis.com',
  'https://ai.google.dev',
];

contextBridge.exposeInMainWorld('electronAPI', {

  // ── Storage (electron-store, persists across restarts) ─────────────────────
  store: {
    get:    (key)         => ipcRenderer.invoke('store:get', key),
    set:    (key, value)  => ipcRenderer.invoke('store:set', key, value),
    delete: (key)         => ipcRenderer.invoke('store:delete', key),
    getAll: ()            => ipcRenderer.invoke('store:getAll'),
    clear:  ()            => ipcRenderer.invoke('store:clear'),
  },

  // ── Window controls ────────────────────────────────────────────────────────
  window: {
    hide:     ()             => ipcRenderer.send('window:hide'),
    close:    ()             => ipcRenderer.send('window:close'),
    minimize: ()             => ipcRenderer.send('window:minimize'),
    pin:      (alwaysOnTop)  => ipcRenderer.send('window:pin', alwaysOnTop),
  },

  // ── Screen / Desktop capture ───────────────────────────────────────────────
  capture: {
    /**
     * getSources(opts?)
     * Returns array of { id, name, thumbnail (base64 PNG dataURL), display_id }
     */
    getSources: (opts) => ipcRenderer.invoke('capture:getSources', opts),
  },

  // ── Shell ──────────────────────────────────────────────────────────────────
  shell: {
    openExternal: (url) => {
      if (ALLOWED_EXTERNAL_PREFIXES.some(p => url.startsWith(p))) {
        ipcRenderer.send('shell:openExternal', url);
      }
    },
  },

  // ── App info ───────────────────────────────────────────────────────────────
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    isDev:      () => ipcRenderer.invoke('app:isDev'),
  },

});
