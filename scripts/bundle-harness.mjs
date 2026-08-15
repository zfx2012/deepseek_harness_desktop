#!/usr/bin/env node
'use strict'

/**
 * Bundle the DeepSeek Harness CLI into harness-deploy/ so the afterPack hook
 * ships it as resources/harness in the packaged app.
 *
 * Source resolution:
 *   --harness <built-checkout>  a checkout layout, materialized as a flattened
 *                               closure by build-closure.mjs
 *   (default)                    the OFFICIAL npm channel: the published
 *                               @deepseek-ai/dsh (--version <ver>, or
 *                               dist-tags.latest) is installed as a
 *                               self-contained deploy-layout closure — the
 *                               exact same code path the in-app kernel update
 *                               uses, so the bundled kernel and future
 *                               updates stay consistent.
 *
 * Usage: node scripts/bundle-harness.mjs [--harness <checkout>] [--version <ver>] [--force] [--no-auto-fetch]
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, openSync, closeSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installHarnessUpdate, fetchOfficialHarnessVersion } from '../src/harness-update.js'

/** True when a directory is a built harness checkout (bin + deps in place). */
function isBuiltHarness(root) {
  if (!root) return false
  try {
    return (
      (existsSync(path.join(root, 'apps', 'cli', 'lib', 'bin.js')) ||
        existsSync(path.join(root, 'lib', 'bin.js'))) &&
      (existsSync(path.join(root, 'node_modules')) ||
        existsSync(path.join(root, 'apps', 'cli', 'node_modules')))
    )
  } catch {
    return false
  }
}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT = path.join(ROOT, 'harness-deploy')

const args = process.argv.slice(2)
const harnessFlag = args.indexOf('--harness')
const EXPLICIT = harnessFlag >= 0 ? path.resolve(args[harnessFlag + 1]) : undefined
const versionFlag = args.indexOf('--version')
const EXPLICIT_VERSION = versionFlag >= 0 ? args[versionFlag + 1] : undefined
const FORCE = args.includes('--force')
const NO_FETCH = args.includes('--no-auto-fetch')

const binExists = existsSync(path.join(OUT, 'lib', 'bin.js')) || existsSync(path.join(OUT, 'apps', 'cli', 'lib', 'bin.js'))

function readManifestVersion() {
  try {
    return JSON.parse(readFileSync(path.join(OUT, 'manifest.json'), 'utf8')).harnessVersion
  } catch {
    return null
  }
}

const log = (...m) => console.log(...m)

/** Boot the bundled CLI once and require the readiness line (3s typical). */
async function bootSmoke() {
  const bin = existsSync(path.join(OUT, 'lib', 'bin.js'))
    ? path.join(OUT, 'lib', 'bin.js')
    : path.join(OUT, 'apps', 'cli', 'lib', 'bin.js')
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-bundle-smoke-'))
  const logFile = path.join(home, 'boot.log')
  const fd = openSync(logFile, 'a')
  const child = spawn(process.execPath, [bin, 'web', '--port', '0'], {
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  })
  const start = Date.now()
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`boot timeout after 120s`)), 120000)
      const poll = setInterval(() => {
        try {
          const content = readFileSync(logFile, 'utf8')
          const line = content.split('\n').filter((l) => l.includes('dsh web:')).pop()
          if (line) {
            clearTimeout(timer)
            clearInterval(poll)
            resolve(line.trim())
          }
        } catch { /* not yet */ }
      }, 250)
      child.on('exit', (code) => {
        clearTimeout(timer)
        clearInterval(poll)
        reject(new Error(`CLI exited early (code ${code})`))
      })
    })
    log(`Boot smoke OK (${((Date.now() - start) / 1000).toFixed(1)}s): ${ready}`)
  } finally {
    try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* gone */ }
    try { closeSync(fd) } catch { /* ok */ }
    rmSync(home, { recursive: true, force: true })
  }
}

// ── checkout path (--harness): flattened closure via build-closure.mjs ──────

async function bundleFromCheckout(root) {
  log(`Bundling from checkout: ${root}`)
  rmSync(OUT, { recursive: true, force: true })
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-closure.mjs'), '--harness', root, '--out', OUT], {
    cwd: ROOT,
    stdio: 'inherit',
  })
}

// ── npm channel (default): published @deepseek-ai/dsh deploy closure ────────

async function bundleFromNpm(version) {
  log(`Bundling from the official npm channel (version: ${version})`)
  rmSync(OUT, { recursive: true, force: true })
  await installHarnessUpdate(version, OUT, { fresh: true, log })
  log(`Bundled harness: ${readManifestVersion()} (${OUT})`)
  await bootSmoke()
}

// ── main ────────────────────────────────────────────────────────────────────

const explicitCheckout = EXPLICIT || process.env.DSH_DESKTOP_HARNESS
const manifestVersion = readManifestVersion()
const requested = EXPLICIT_VERSION

if (binExists && !FORCE && (!requested || requested === manifestVersion)) {
  console.log(`harness-deploy/ already bundled (${manifestVersion ?? '?'}); use --force to rebuild: ${OUT}`)
  execFileSync(process.execPath, ['scripts/patch-harness-jsonl.mjs'], { cwd: ROOT, stdio: 'inherit' })
  process.exit(0)
}

if (explicitCheckout) {
  if (!isBuiltHarness(explicitCheckout)) {
    console.error(`--harness path is not a built harness checkout: ${explicitCheckout}`)
    process.exit(1)
  }
  await bundleFromCheckout(explicitCheckout)
  execFileSync(process.execPath, ['scripts/patch-harness-jsonl.mjs'], { cwd: ROOT, stdio: 'inherit' })
  process.exit(0)
}

if (NO_FETCH) {
  console.error('No --harness given and --no-auto-fetch is set: the npm channel needs network.')
  process.exit(1)
}

let version = requested
if (!version) {
  try {
    const { latest } = await fetchOfficialHarnessVersion()
    version = latest
  } catch (error) {
    console.error(`Failed to resolve the latest published version: ${error.message}`)
    process.exit(1)
  }
}

await bundleFromNpm(version)
execFileSync(process.execPath, ['scripts/patch-harness-jsonl.mjs'], { cwd: ROOT, stdio: 'inherit' })
