#!/usr/bin/env node
'use strict'

/**
 * Prepare the dist build: ensure harness-deploy/ exists for the afterPack
 * bundle copy. If a harness checkout is reachable we bundle it (full
 * standalone app); otherwise the packaged app runs against a user-configured
 * harness path (auto-detect + settings page).
 *
 * Usage: node scripts/prepare-dist.mjs [--skip-bundle]
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT = path.join(ROOT, 'harness-deploy')
const HARNESS = process.env.DSH_DESKTOP_HARNESS || 'F:\\Program Files (x86)\\deepseek-harness'

function isHarness(root) {
  return (
    (existsSync(path.join(root, 'apps', 'cli', 'lib', 'bin.js')) ||
      existsSync(path.join(root, 'lib', 'bin.js'))) &&
    (existsSync(path.join(root, 'node_modules')) ||
      existsSync(path.join(root, 'apps', 'cli', 'node_modules')))
  )
}

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
  console.log('harness-deploy: skipped bundling (empty dir created for extraResources)')
} else if (existsSync(path.join(OUT, 'apps', 'cli', 'lib', 'bin.js'))) {
  console.log('harness-deploy: already bundled')
  validateBundle()
} else if (isHarness(HARNESS)) {
  console.log(`harness-deploy: bundling from ${HARNESS}`)
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'bundle-harness.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  })
} else {
  mkdirSync(OUT, { recursive: true })
  console.warn('harness-deploy: no harness checkout found; shipping without a bundled harness')
}
