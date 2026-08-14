'use strict'

/**
 * dsh-desktop — settings persistence.
 * A tiny JSON store in the app's userData directory. No external deps.
 */

const fs = require('node:fs')
const path = require('node:path')

const DEFAULTS = Object.freeze({
  /** Absolute path to a dsh harness checkout; '' means auto-detect (bundled, env, known locations). */
  harnessPath: '',
  /** DSH_HOME for the spawned server; '' means the harness default (~/.dsh). */
  dshHome: '',
  /** Listen port; 0 lets the OS pick a free port. */
  port: 0,
  /** Working directory for the spawned server; '' means the user's home. */
  workspace: '',
  /** Restart the server automatically if it exits unexpectedly. */
  autoRestart: true,
})

class SettingsStore {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'config.json')
    this.data = { ...DEFAULTS }
    this.load()
  }

  load() {
    try {
      // Strip a UTF-8 BOM: editors that save with a BOM would otherwise make
      // JSON.parse throw and silently reset the whole configuration.
      const raw = fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '')
      const parsed = JSON.parse(raw)
      for (const key of Object.keys(DEFAULTS)) {
        if (typeof parsed[key] === typeof DEFAULTS[key] && parsed[key] !== undefined && parsed[key] !== null) {
          this.data[key] = parsed[key]
        }
      }
    } catch {
      // First run or unreadable config: keep defaults.
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      // Atomic write: temp file + rename, so a crash mid-write never corrupts
      // the stored configuration.
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch (error) {
      console.error('[dsh-desktop] failed to write config:', error)
    }
  }

  get(key) {
    return this.data[key]
  }

  set(partial) {
    let changed = false
    for (const [key, value] of Object.entries(partial)) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, key) && typeof value === typeof DEFAULTS[key]) {
        if (this.data[key] !== value) {
          this.data[key] = value
          changed = true
        }
      }
    }
    if (changed) this.save()
    return changed
  }
}

module.exports = { SettingsStore, DEFAULTS }
