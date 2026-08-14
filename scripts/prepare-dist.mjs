#!/usr/bin/env node
'use strict'

/**
 * Prepare the dist build: ensure harness-deploy/ exists for the afterPack
 * bundle copy. Harness resolution follows harness-resolve.mjs — a local
 * checkout wins; without one, the official repo is cloned and built
 * automatically (--no-auto-fetch disables the network step).
 *
 * Usage: node scripts/prepare-dist.mjs [--skip-bundle] [--no-auto-fetch]
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveHarness } from './harness-resolve.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT = path.join(ROOT, 'harness-deploy')

/** Hard checks that the bundled harness is complete and self-contained. */
function validateBundle() {
  const required = [
    'apps/cli/lib/bin.js',
    'node_modules/@deepseek-ai/dsh-web-app',
    'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
    'manifest.json',
  ]
  for (const rel of required) {
    if (!existsSync(path.join(OUT, rel))) {
      throw new Error(`bundled harness is incomplete: missing ${rel} (rebuild with npm run bundle:harness)`)
    }
  }
  // A self-contained bundle must not rely on reparse points (junctions carry
  // absolute targets and break on move; electron-builder drops them).
  const probes = [
    'node_modules/@deepseek-ai/dsh-web-app',
    'node_modules/commander',
  ]
  for (const rel of probes) {
    try {
      if (statSync(path.join(OUT, rel)).isSymbolicLink()) {
        throw new Error(`bundled harness still contains a reparse point: ${rel}`)
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('reparse point')) throw error
      // probe missing: the required-list check above covers fatal absence
    }
  }
  console.log('harness-deploy: bundle validation passed')
}

if (process.argv.includes('--skip-bundle')) {
  mkdirSync(OUT, { recursive: true })
  console.log('harness-deploy: skipped bundling (empty dir created for afterPack)')
} else if (existsSync(path.join(OUT, 'apps', 'cli', 'lib', 'bin.js'))) {
  console.log('harness-deploy: already bundled')
  validateBundle()
} else {
  const { root, source } = resolveHarness({
    cwd: ROOT,
    explicit: undefined,
    noAutoFetch: process.argv.includes('--no-auto-fetch'),
  })
  if (root) {
    console.log(`harness-deploy: bundling from ${root} (source: ${source})`)
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'bundle-harness.mjs'), '--harness', root], {
      cwd: ROOT,
      stdio: 'inherit',
    })
  } else {
    mkdirSync(OUT, { recursive: true })
    console.warn('harness-deploy: no harness checkout found; shipping without a bundled harness')
  }
}
