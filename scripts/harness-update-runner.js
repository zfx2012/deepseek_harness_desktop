#!/usr/bin/env node
'use strict'

/**
 * dsh-desktop — kernel update runner (child process).
 *
 * The main process spawns this script (system Node when available, otherwise
 * this Electron binary with ELECTRON_RUN_AS_NODE) so the long npm install and
 * file merges never block the UI thread. Line protocol on stdout:
 *   [update] <progress text>    — progress
 *   [result] <json>             — success (exit 0)
 *   [error] <message>           — failure (exit 1)
 *
 * Usage: node harness-update-runner.js --version <ver> --target <dir> [--fresh]
 */

const { installHarnessUpdate } = require('../src/harness-update.js')

const args = process.argv.slice(2)
const arg = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const version = arg('--version')
const target = arg('--target')
const fresh = args.includes('--fresh')

if (!version || !target) {
  console.log('[error] 缺少 --version 或 --target 参数')
  process.exit(1)
}

installHarnessUpdate(version, target, {
  fresh,
  log: (text) => console.log(`[update] ${text}`),
})
  .then((result) => {
    console.log(`[result] ${JSON.stringify(result)}`)
    process.exit(0)
  })
  .catch((error) => {
    console.log(`[error] ${error.message}`)
    process.exit(1)
  })
