#!/usr/bin/env node
'use strict'

/**
 * Shared harness resolution for the bundle/prepare scripts.
 *
 * Priority:
 *   1. explicit `--harness <path>`         (must be a BUILT checkout)
 *   2. `DSH_DESKTOP_HARNESS` env
 *   3. known local checkouts (dev-machine paths, sibling `../deepseek-harness`)
 *   4. auto-fetch: shallow-clone the official repo into `.harness-checkout`,
 *      then `pnpm install --frozen-lockfile` + `pnpm run build`
 *      (cached across runs; `--update` re-pulls and rebuilds)
 *
 * `--no-auto-fetch` disables step 4 (offline packaging); a missing local
 * checkout then fails with instructions instead of hitting the network.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export const DEFAULT_HARNESS_URL = 'https://github.com/deepseek-ai/deepseek-harness.git'
export const CACHE_DIR_NAME = '.harness-checkout'

const SHELL = process.platform === 'win32' ? true : false // pnpm.cmd/git.exe need cmd on Windows

/** True when a directory is a BUILT harness checkout (bin + deps in place). */
export function isBuiltHarness(root) {
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

/** Local candidates probed before any network access. */
export function localCandidates(cwd) {
  const list = []
  if (process.env.DSH_DESKTOP_HARNESS) list.push(process.env.DSH_DESKTOP_HARNESS)
  for (const base of ['F:\\Program Files (x86)\\deepseek-harness', 'C:\\deepseek-harness', 'D:\\deepseek-harness']) {
    list.push(base)
  }
  list.push(path.join(cwd, '..', 'deepseek-harness'))
  return list
}

/** Install + build a cloned harness checkout. */
export function buildHarness(root) {
  console.log(`> pnpm install --frozen-lockfile  (cwd: ${root})`)
  execFileSync('pnpm', ['install', '--frozen-lockfile'], { cwd: root, stdio: 'inherit', shell: SHELL })
  console.log(`> pnpm run build  (cwd: ${root})`)
  execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: SHELL })
}

/**
 * Shallow-clone the official repo into <cwd>/.harness-checkout and build it.
 * Cached: existing checkouts are reused; `update` re-pulls; a checkout that
 * was cloned but never built gets built in place.
 */
export function fetchHarness({ cwd, url = DEFAULT_HARNESS_URL, update = false } = {}) {
  const root = path.join(cwd, CACHE_DIR_NAME)
  if (!existsSync(path.join(root, '.git'))) {
    mkdirSync(root, { recursive: true })
    console.log(`No local harness checkout found — cloning ${url} (shallow) into ${root}`)
    console.log('First run also installs and builds the harness (several minutes).')
    execFileSync('git', ['clone', '--depth', '1', url, '.'], { cwd: root, stdio: 'inherit', shell: SHELL })
    buildHarness(root)
  } else if (update) {
    execFileSync('git', ['pull', '--ff-only'], { cwd: root, stdio: 'inherit', shell: SHELL })
    buildHarness(root)
  } else if (!isBuiltHarness(root)) {
    buildHarness(root) // cloned before but never built
  }
  return root
}

/**
 * Resolve a built harness root.
 * @returns {{ root: string, source: 'explicit'|'local'|'fetched' } | { root: null, source: 'none' }}
 */
export function resolveHarness({ cwd, explicit, noAutoFetch = false, url, update = false }) {
  if (explicit) {
    if (!isBuiltHarness(explicit)) {
      console.error(`--harness path is not a built harness checkout: ${explicit}`)
      process.exit(1)
    }
    return { root: explicit, source: 'explicit' }
  }
  for (const candidate of localCandidates(cwd)) {
    if (candidate && isBuiltHarness(candidate)) return { root: candidate, source: 'local' }
  }
  if (noAutoFetch) return { root: null, source: 'none' }
  return { root: fetchHarness({ cwd, url, update }), source: 'fetched' }
}
