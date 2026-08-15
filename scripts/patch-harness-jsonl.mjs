#!/usr/bin/env node
'use strict'

/**
 * Patch the bundled JSONL session-persistence backend so a corrupt committed
 * region (e.g. a seq gap) is recovered by truncating at the first bad frame
 * instead of making the whole session history unavailable.
 *
 * The upstream @deepseek-ai/dsh-session-persistence-jsonl package currently
 * throws when a later `turn/end` appears after a gap.  That is too strict for
 * a desktop app: the durable prefix before the gap is still valid and can be
 * repaired with the existing interrupted-turn closers.  This script is applied
 * after `harness-deploy` is bundled so the packaged app gets the same
 * resilience.
 *
 * Usage: node scripts/patch-harness-jsonl.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const TARGET = path.join(
  ROOT,
  'harness-deploy',
  'node_modules',
  '@deepseek-ai',
  'dsh-session-persistence-jsonl',
  'lib',
  'index.js',
)

const replacements = [
  // 1. Once an issue has been seen, do not escalate to a hard failure just
  //    because a later line contains a turn/end.  The scanner already keeps
  //    only the valid contiguous prefix; the coordinator will close the turn.
  {
    from:
      '\t\tif (this.issue !== void 0) {\n' +
      '\t\t\tif (decoded.some((event) => event.type === "turn/end")) throw this.issue;\n' +
      '\t\t\treturn;\n' +
      '\t\t}',
    to:
      '\t\tif (this.issue !== void 0) {\n' +
      '\t\t\treturn;\n' +
      '\t\t}',
  },
  // 2. Same for the seq-gap branch.
  {
    from:
      '\t\t\t\tthis.issue = /* @__PURE__ */ new Error(`corrupt session log: seq gap in committed region at line ${this.eventLine} (expected ${expected}, got ${event.seq})`);\n' +
      '\t\t\t\tif (decoded.some((candidate) => candidate.type === "turn/end")) throw this.issue;\n' +
      '\t\t\t\treturn;',
    to:
      '\t\t\t\tthis.issue = /* @__PURE__ */ new Error(`corrupt session log: seq gap in committed region at line ${this.eventLine} (expected ${expected}, got ${event.seq})`);\n' +
      '\t\t\t\treturn;',
  },
  // 3. For zstd artifacts, a logical gap inside a complete frame must not be
  //    reported as a torn JSONL record.  Drop the whole bad frame (plus any
  //    later frames) and carry the valid events already read from that frame
  //    as recoveredEvents so commitRepair can re-append them after truncation.
  {
    from:
      '\t\t\tconst scanner = new SessionLogScanner(headerFrame.value);\n' +
      '\t\t\tlet remainingFrames = frames.length - 1;\n' +
      '\t\t\tfor (const plaintext of decodedFrames) {\n' +
      '\t\t\t\tsignal?.throwIfAborted();\n' +
      '\t\t\t\tscanner.write(plaintext);\n' +
      '\t\t\t\tremainingFrames -= 1;\n' +
      '\t\t\t\tif (remainingFrames > 0 && performance.now() >= yieldDeadline) {\n' +
      '\t\t\t\t\tawait scheduler.yield();\n' +
      '\t\t\t\t\tsignal?.throwIfAborted();\n' +
      '\t\t\t\t\tyieldDeadline = performance.now() + ZSTD_DECODE_YIELD_INTERVAL_MS;\n' +
      '\t\t\t\t}\n' +
      '\t\t\t}\n' +
      '\t\t\tsignal?.throwIfAborted();\n' +
      '\t\t\tconst complete = scanner.checkpoint();\n' +
      '\t\t\tif (complete.committedBytes !== complete.inputBytes) throw new Error("corrupt Zstandard session log: complete frame contains a torn JSONL record");\n',
    to:
      '\t\t\tconst scanner = new SessionLogScanner(headerFrame.value);\n' +
      '\t\t\tlet remainingFrames = frames.length - 1;\n' +
      '\t\t\tlet logicalTornMarker;\n' +
      '\t\t\tlet frameIndex = 1;\n' +
      '\t\t\tfor (const plaintext of decodedFrames) {\n' +
      '\t\t\t\tsignal?.throwIfAborted();\n' +
      '\t\t\t\tconst beforeFrame = scanner.checkpoint();\n' +
      '\t\t\t\tscanner.write(plaintext);\n' +
      '\t\t\t\t// A seq gap or unparsable line inside a complete frame is a logical\n' +
      '\t\t\t\t// corruption, not a torn physical tail. Drop the whole frame (and any\n' +
      '\t\t\t\t// later frames) so the durable prefix stays contiguous and repairable.\n' +
      '\t\t\t\tif (scanner.committedBytes !== scanner.inputBytes) {\n' +
      '\t\t\t\t\tconst recoveredEvents = scanner.events.slice(beforeFrame.eventCount);\n' +
      '\t\t\t\t\tscanner.events.length = beforeFrame.eventCount;\n' +
      '\t\t\t\t\tscanner.committedBytes = beforeFrame.committedBytes;\n' +
      '\t\t\t\t\tlogicalTornMarker = {\n' +
      '\t\t\t\t\t\ttruncateTo: frames[frameIndex].start,\n' +
      '\t\t\t\t\t\trecoveredEvents\n' +
      '\t\t\t\t\t};\n' +
      '\t\t\t\t\tbreak;\n' +
      '\t\t\t\t}\n' +
      '\t\t\t\tremainingFrames -= 1;\n' +
      '\t\t\t\tif (remainingFrames > 0 && performance.now() >= yieldDeadline) {\n' +
      '\t\t\t\t\tawait scheduler.yield();\n' +
      '\t\t\t\t\tsignal?.throwIfAborted();\n' +
      '\t\t\t\t\tyieldDeadline = performance.now() + ZSTD_DECODE_YIELD_INTERVAL_MS;\n' +
      '\t\t\t\t}\n' +
      '\t\t\t\tframeIndex += 1;\n' +
      '\t\t\t}\n' +
      '\t\t\tsignal?.throwIfAborted();\n' +
      '\t\t\tif (logicalTornMarker !== void 0) {\n' +
      '\t\t\t\tconst prefix = scanner.finish();\n' +
      '\t\t\t\treturn {\n' +
      '\t\t\t\t\tmeta: prefix.meta,\n' +
      '\t\t\t\t\tevents: prefix.events,\n' +
      '\t\t\t\t\ttornMarker: logicalTornMarker\n' +
      '\t\t\t\t};\n' +
      '\t\t\t}\n' +
      '\t\t\tconst complete = scanner.checkpoint();\n' +
      '\t\t\tif (complete.committedBytes !== complete.inputBytes) throw new Error("corrupt Zstandard session log: complete frame contains a torn JSONL record");\n',
  },
]

function main() {
  if (!existsSync(TARGET)) {
    console.log('patch-harness-jsonl: target not found, skipping')
    return
  }

  let source = readFileSync(TARGET, 'utf8')
  let changed = false
  for (const { from, to } of replacements) {
    if (source.includes(to)) {
      // Already patched (idempotent).
      continue
    }
    if (!source.includes(from)) {
      throw new Error(`patch-harness-jsonl: could not find expected snippet in ${TARGET}`)
    }
    source = source.replace(from, to)
    changed = true
  }

  if (changed) {
    writeFileSync(TARGET, source, 'utf8')
    console.log('patch-harness-jsonl: applied corrupt-session recovery patch')
  } else {
    console.log('patch-harness-jsonl: already up to date')
  }
}

main()
