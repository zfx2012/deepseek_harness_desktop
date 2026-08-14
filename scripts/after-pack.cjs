'use strict'

/**
 * electron-builder afterPack hook: copy the bundled harness into the packaged
 * app's resources dir.
 *
 * We deliberately do NOT use `extraResources` for the harness: electron-builder
 * copies extraResources through a filter that unconditionally drops any
 * top-level `node_modules` directory (util/filter.js in app-builder-lib), so
 * the dependency tree would silently vanish from the installer. A plain
 * fs.cpSync here bypasses that filter entirely.
 */

const { cpSync, existsSync, rmSync } = require('node:fs')
const path = require('node:path')

module.exports = async function afterPack(context) {
  const ROOT = path.dirname(path.dirname(__filename))
  const src = path.join(ROOT, 'harness-deploy')
  const dest = path.join(context.appOutDir, 'resources', 'harness')

  if (!existsSync(src)) {
    console.warn('afterPack: harness-deploy not found; shipping without a bundled harness')
    return
  }
  rmSync(dest, { recursive: true, force: true })
  cpSync(src, dest, { recursive: true, dereference: true })
  console.log(`afterPack: bundled harness copied (${src}) -> ${dest}`)
}
