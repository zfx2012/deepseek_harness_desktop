#!/usr/bin/env node
'use strict'

/**
 * Bundle the DeepSeek Harness CLI into harness-deploy/ so electron-builder can
 * ship it as extraResources (resources/harness in the packaged app).
 *
 * Delegates to build-closure.mjs, which materializes a self-contained
 * production dependency closure from a working harness checkout (pnpm's own
 * `deploy` is broken on current pnpm versions for this workspace layout).
 *
 * Usage: node scripts/bundle-harness.mjs [--harness <checkout>] [--force]
 */

import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT = path.join(ROOT, 'harness-deploy')

const args = process.argv.slice(2)
const harnessFlag = args.indexOf('--harness')
const HARNESS = harnessFlag >= 0
  ? path.resolve(args[harnessFlag + 1])
  : (process.env.DSH_DESKTOP_HARNESS || 'F:\\Program Files (x86)\\deepseek-harness')
const FORCE = args.includes('--force')

if (existsSync(path.join(OUT, 'apps', 'cli', 'lib', 'bin.js')) && !FORCE) {
  console.log(`harness-deploy/ already exists (use --force to rebuild): ${OUT}`)
  process.exit(0)
}

rmSync(OUT, { recursive: true, force: true })
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-closure.mjs'), '--harness', HARNESS, '--out', OUT], {
  cwd: ROOT,
  stdio: 'inherit',
})
