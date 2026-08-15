#!/usr/bin/env node
'use strict'

/**
 * Prepare the dist build: ensure harness-deploy/ exists for the afterPack
 * bundle copy. The bundle is produced by bundle-harness.mjs — by default
 * from the official npm channel (the latest published @deepseek-ai/dsh,
 * deploy layout); --harness <checkout> switches to a checkout closure.
 * --no-auto-fetch disables the network step (fails when a bundle is missing).
 *
 * Usage: node scripts/prepare-dist.mjs [--skip-bundle] [--no-auto-fetch]
 *        [--harness <checkout>] [--version <ver>]
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT = path.join(ROOT, 'harness-deploy')

/** Both supported layouts: checkout (apps/cli/lib/bin.js) and npm deploy (lib/bin.js). */
const BIN_RELS = ['apps/cli/lib/bin.js', 'lib/bin.js']

function hasBin() {
  return BIN_RELS.some((rel) => existsSync(path.join(OUT, rel)))
}

/** Hard checks that the bundled harness is complete and self-contained. */
function validateBundle() {
  if (!hasBin()) {
    throw new Error(`bundled harness is missing the CLI bin (${BIN_RELS.join(' / ')}) — rebuild with npm run bundle:harness`)
  }
  const required = [
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
} else if (hasBin()) {
  console.log('harness-deploy: already bundled')
  validateBundle()
} else {
  const bundleArgs = ['scripts/bundle-harness.mjs']
  const harnessFlag = process.argv.indexOf('--harness')
  if (harnessFlag >= 0) bundleArgs.push('--harness', process.argv[harnessFlag + 1])
  const versionFlag = process.argv.indexOf('--version')
  if (versionFlag >= 0) bundleArgs.push('--version', process.argv[versionFlag + 1])
  if (process.argv.includes('--no-auto-fetch')) bundleArgs.push('--no-auto-fetch')
  execFileSync(process.execPath, bundleArgs, { cwd: ROOT, stdio: 'inherit' })
  validateBundle()
}

// Apply the local resilience patch to the generated JSONL persistence backend.
// This is a tracked build step because harness-deploy/ itself is gitignored.
if (existsSync(path.join(OUT, 'node_modules', '@deepseek-ai', 'dsh-session-persistence-jsonl'))) {
  execFileSync(process.execPath, ['scripts/patch-harness-jsonl.mjs'], { cwd: ROOT, stdio: 'inherit' })
}
