#!/usr/bin/env node
'use strict'

/**
 * Apply the JSONL corruption-recovery patch to harness-deploy/ after bundling,
 * so the packaged kernel carries the same resilience as an in-app update.
 *
 * The patch itself lives in src/harness-jsonl-patch.js (one implementation for
 * both the build step and the update path). Snippets that no longer match
 * upstream code are skipped there instead of failing the build.
 *
 * Usage: node scripts/patch-harness-jsonl.mjs
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { patchHarnessJsonl } = require('../src/harness-jsonl-patch.js')

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT = path.join(ROOT, 'harness-deploy')

const result = patchHarnessJsonl(OUT, { log: (message) => console.log(`patch-harness-jsonl: ${message}`) })
if (result.changed) {
  console.log(`patch-harness-jsonl: applied corrupt-session recovery patch (${result.applied} snippets)`)
} else if (result.applied === 0 && result.skipped === 0) {
  console.log('patch-harness-jsonl: target not found, skipping')
} else {
  console.log(`patch-harness-jsonl: already up to date (${result.applied} snippets, ${result.skipped} skipped)`)
}
