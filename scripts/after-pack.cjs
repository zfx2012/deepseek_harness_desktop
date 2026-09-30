'use strict'

/**
 * electron-builder afterPack hook: copy the bundled harness and the bundled
 * Node runtime into the packaged app's resources dir.
 *
 * We deliberately do NOT use `extraResources` for either one: electron-builder
 * copies extraResources through a filter that unconditionally drops any
 * top-level `node_modules` directory (util/filter.js in app-builder-lib), so
 * the dependency tree (and npm inside the Node runtime) would silently vanish
 * from the installer. A plain fs.cpSync here bypasses that filter entirely.
 */

const { cpSync, existsSync, rmSync } = require('node:fs')
const path = require('node:path')

module.exports = async function afterPack(context) {
  const ROOT = path.dirname(path.dirname(__filename))

  const src = path.join(ROOT, 'harness-deploy')
  const dest = path.join(context.appOutDir, 'resources', 'harness')
  if (!existsSync(src)) {
    console.warn('afterPack: harness-deploy not found; shipping without a bundled harness')
  } else {
    rmSync(dest, { recursive: true, force: true })
    cpSync(src, dest, { recursive: true, dereference: true })
    console.log(`afterPack: bundled harness copied (${src}) -> ${dest}`)
  }

  // Kernels from 0.2.0 refuse to run on Electron's own runtime, so the app must
  // carry a real Node: resources/node/node.exe runs the kernel (and its npm
  // updates) on machines with no system Node.js.
  const nodeSrc = path.join(ROOT, 'node-runtime')
  const nodeDest = path.join(context.appOutDir, 'resources', 'node')
  if (!existsSync(path.join(nodeSrc, 'node.exe'))) {
    console.warn('afterPack: node-runtime not found; run `npm run bundle:node` (the app then needs a system Node.js)')
    return
  }
  rmSync(nodeDest, { recursive: true, force: true })
  cpSync(nodeSrc, nodeDest, { recursive: true, dereference: true })
  console.log(`afterPack: bundled Node runtime copied (${nodeSrc}) -> ${nodeDest}`)
}
