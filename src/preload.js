'use strict'

/**
 * dsh-desktop — preload bridge.
 * Exposes a minimal, typed surface to the renderer(s) over contextBridge.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dsh', {
  // state + logs (main window and settings window)
  getState: () => ipcRenderer.invoke('dsh:get-state'),
  onState: (cb) => {
    const listener = (_event, state) => cb(state)
    ipcRenderer.on('dsh:state', listener)
    return () => ipcRenderer.removeListener('dsh:state', listener)
  },
  onLog: (cb) => {
    const listener = (_event, line) => cb(line)
    ipcRenderer.on('dsh:log', listener)
    return () => ipcRenderer.removeListener('dsh:log', listener)
  },

  // settings
  getSettings: () => ipcRenderer.invoke('dsh:get-settings'),
  setSettings: (partial) => ipcRenderer.invoke('dsh:set-settings', partial),
  pickDirectory: () => ipcRenderer.invoke('dsh:pick-directory'),
  detectHarness: () => ipcRenderer.invoke('dsh:detect-harness'),

  // provenance
  getBundleInfo: () => ipcRenderer.invoke('dsh:get-bundle-info'),

  // control
  restartServer: () => ipcRenderer.invoke('dsh:restart-server'),
  openSettings: () => ipcRenderer.send('dsh:open-settings'),
})
