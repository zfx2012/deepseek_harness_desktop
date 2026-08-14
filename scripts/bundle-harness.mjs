#!/usr/bin/env node
'use strict'

/**
 * Bundle the DeepSeek Harness CLI into harness-deploy/ so the afterPack hook
 * ships it as resources/harness in the packaged app.
 *
 * Harness resolution (see harness-resolve.mjs):
 *   --harness <built-checkout>  >  $DSH_DESKTOP_HARNESS  >  local dev-machine
 *   paths  >  auto-fetch: shallow-clone the official repo
 *   (https://github.com/deepseek-ai/deepseek-harness.git) into
 *   .harness-checkout and build it (cached; --update re-pulls).
 *   --no-auto-fetch disables the network step.
 *
 * The resolved checkout is handed to build-closure.mjs, which materializes a
 * self-contained production dependency closure.
 *
 * Usage: node scripts/bundle-harness.mjs [--harness <checkout>] [--force] [--update] [--no-auto-fetch]
 */

import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { resolveHarness } from './harness-resolve.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT = path.join(ROOT, 'harness-deploy')

const args = process.argv.slice(2)
const harnessFlag = args.indexOf('--harness')
const EXPLICIT = harnessFlag >= 0 ? path.resolve(args[harnessFlag + 1]) : undefined
const FORCE = args.includes('--force')
const UPDATE = args.includes('--update')
const NO_FETCH = args.includes('--no-auto-fetch')

if (existsSync(path.join(OUT, 'apps', 'cli', 'lib', 'bin.js')) && !FORCE) {
  console.log(`harness-deploy/ already exists (use --force to rebuild): ${OUT}`)
  process.exit(0)
}

const { root } = resolveHarness({ cwd: ROOT, explicit: EXPLICIT, noAutoFetch: NO_FETCH, update: UPDATE })
if (!root) {
  console.error('No harness checkout available. Provide one with --harness <built-checkout>')
  console.error('or remove --no-auto-fetch to let the script clone and build the official repo.')
  process.exit(1)
}

rmSync(OUT, { recursive: true, force: true })
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-closure.mjs'), '--harness', root, '--out', OUT], {
  cwd: ROOT,
  stdio: 'inherit',
})
