'use strict'

/**
 * dsh-desktop — preload bridge.
 *
 * The single window serves BOTH the dsh Web GUI (http://127.0.0.1/…) and the
 * settings page (file://…/settings/index.html). The control API is exposed
 * ONLY on the trusted settings page — the Web GUI never receives it, so an
 * XSS in the web UI cannot reach updateHarness/restartServer.
 */

const { contextBridge, ipcRenderer } = require('electron')

if (window.location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('dsh', {
    // state + logs (settings page)
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
    checkHarnessUpdate: () => ipcRenderer.invoke('dsh:check-harness-update'),
    updateHarness: (version) => ipcRenderer.invoke('dsh:update-harness', version),
    onUpdateProgress: (cb) => {
      const listener = (_event, text) => cb(text)
      ipcRenderer.on('dsh:update-progress', listener)
      return () => ipcRenderer.removeListener('dsh:update-progress', listener)
    },

    // control
    restartServer: () => ipcRenderer.invoke('dsh:restart-server'),
    backToGui: () => ipcRenderer.invoke('dsh:back-to-gui'),
    openExternal: (url) => ipcRenderer.invoke('dsh:open-external', url),
  })
}
