'use strict'

/**
 * Patch the bundled JSONL session-persistence backend so a corrupt committed
 * region (e.g. an unparsable row or a seq gap) is recovered by truncating at
 * the first bad frame instead of making the whole session history unavailable.
 *
 * The upstream @deepseek-ai/dsh-session-persistence-jsonl package throws when a
 * later `turn/end` appears after such a defect. That is too strict for a
 * desktop app: the durable prefix before the defect is still valid and can be
 * repaired with the existing interrupted-turn closers. This helper is applied
 * both when bundling a fresh harness and after an in-app kernel update.
 */

const fs = require('node:fs')
const path = require('node:path')

const TARGET_REL = [
  'node_modules',
  '@deepseek-ai',
  'dsh-session-persistence-jsonl',
  'lib',
  'index.js',
]

/**
 * Upstream spells the escalation inline and names the decoded row differently
 * per scanner, so the guard is matched structurally (back-reference) rather
 * than as one literal block. The throw line is OPTIONAL in the pattern, so an
 * already-patched file still matches and the replacement is a no-op there —
 * which makes the patch idempotent without a separate "done" marker.
 */
const TURN_END_GUARD =
  /(\t\tif \(this\.issue !== void 0\) \{\n)(?:\t\t\tif \(typeof (\w+) === "object" && \2 !== null && \2\.type === "turn\/end"\) throw this\.issue;\n)?(\t\t\treturn;\n\t\t\})/g

const INVALID_ROW_GUARD =
  /(\t\t\tthis\.issue = issue;\n)(?:\t\t\tif \(typeof (\w+) === "object" && \2 !== null && \2\.type === "turn\/end"\) throw issue;\n)?(\t\t\treturn;)/g

const replacements = [
  // 1. Once an issue has been seen, do not escalate to a hard failure just
  //    because a later line contains a turn/end. The scanner already keeps
  //    only the valid contiguous prefix; the coordinator will close the turn.
  { id: 'turn/end escalation guard', pattern: TURN_END_GUARD, replace: '$1$3' },
  // 2. Same for the invalid-committed-row branch.
  { id: 'invalid-row escalation guard', pattern: INVALID_ROW_GUARD, replace: '$1$3' },
  // 3. For zstd artifacts, a logical gap inside a complete frame must not be
  //    reported as a torn JSONL record. Drop the whole bad frame (plus any
  //    later frames) and carry the valid events already read from that frame
  //    as recoveredEvents so commitRepair can re-append them after truncation.
  {
    id: 'zstd logical-frame recovery',
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

/**
 * Apply the JSONL corruption-recovery patch to a harness root.
 *
 * This is a local resilience enhancement, never a requirement: upstream code
 * changes are expected, so a snippet that no longer matches is SKIPPED (with a
 * log line) instead of failing the caller. A kernel update must never be
 * blocked by a stale patch anchor — but see scripts/prepare-dist.mjs, which
 * refuses to ship a bundle whose anchors drifted.
 *
 * @param {string} harnessRoot - deploy-layout harness root.
 * @param {object} [deps] - { log? } progress sink.
 * @returns {{ changed: boolean, applied: number, skipped: number, sites: number }}
 */
function patchHarnessJsonl(harnessRoot, { log = () => {} } = {}) {
  const target = path.join(harnessRoot, ...TARGET_REL)
  if (!fs.existsSync(target)) return { changed: false, applied: 0, skipped: 0, sites: 0 }

  let source = fs.readFileSync(target, 'utf8')
  let changed = false
  let applied = 0
  let skipped = 0
  let sites = 0
  for (const entry of replacements) {
    if (entry.pattern) {
      // The pattern matches the guard in either state, so this is idempotent:
      // an already-patched site simply re-replaces to itself.
      const pattern = new RegExp(entry.pattern.source, entry.pattern.flags)
      const hits = source.match(pattern)
      if (hits === null) {
        skipped += 1
        log(`会话日志韧性补丁「${entry.id}」未匹配当前内核代码，已跳过（不影响内核更新）`)
        continue
      }
      const next = source.replace(entry.pattern, entry.replace)
      if (next !== source) changed = true
      source = next
      applied += 1
      sites += hits.length
      continue
    }
    if (source.includes(entry.to)) {
      // Already patched (idempotent).
      applied += 1
      sites += 1
      continue
    }
    if (!source.includes(entry.from)) {
      skipped += 1
      log(`会话日志韧性补丁「${entry.id}」未匹配当前内核代码，已跳过（不影响内核更新）`)
      continue
    }
    source = source.replace(entry.from, entry.to)
    changed = true
    applied += 1
    sites += 1
  }

  if (changed) {
    fs.writeFileSync(target, source, 'utf8')
  }
  return { changed, applied, skipped, sites }
}

module.exports = { patchHarnessJsonl }
