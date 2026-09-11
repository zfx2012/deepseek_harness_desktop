'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { patchHarnessJsonl } = require('../src/harness-jsonl-patch')

// Upstream (>= 0.1.5-rc.1) spells the escalation inline and names the decoded
// row per scanner (`decoded` in the byte scanner, `row` in the row reader).
const CURRENT_SNIPPETS = [
  '\t\tif (this.issue !== void 0) {\n' +
    '\t\t\tif (typeof decoded === "object" && decoded !== null && decoded.type === "turn/end") throw this.issue;\n' +
    '\t\t\treturn;\n' +
    '\t\t}',
  '\t\t\tthis.issue = issue;\n' +
    '\t\t\tif (typeof decoded === "object" && decoded !== null && decoded.type === "turn/end") throw issue;\n' +
    '\t\t\treturn;',
  '\t\tif (this.issue !== void 0) {\n' +
    '\t\t\tif (typeof row === "object" && row !== null && row.type === "turn/end") throw this.issue;\n' +
    '\t\t\treturn;\n' +
    '\t\t}',
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
]

function jsonlTarget(dir) {
  return path.join(dir, 'node_modules', '@deepseek-ai', 'dsh-session-persistence-jsonl', 'lib', 'index.js')
}

function makeFakeHarness(dir, snippets = CURRENT_SNIPPETS) {
  const target = jsonlTarget(dir)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, snippets.join('\n\n'), 'utf8')
  return target
}

test('patchHarnessJsonl removes both turn/end escalations and adds zstd logical-frame recovery', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-jsonl-patch-'))
  const target = makeFakeHarness(tmp)

  const result = patchHarnessJsonl(tmp)
  assert.equal(result.changed, true)
  assert.equal(result.applied, 3)
  assert.equal(result.skipped, 0)
  assert.equal(result.sites, 4, 'all three escalation sites plus the zstd reader')

  const patched = fs.readFileSync(target, 'utf8')
  assert.ok(!patched.includes('throw this.issue'), 'turn/end after a defect must not hard-fail')
  assert.ok(!patched.includes('throw issue;'), 'the invalid-row branch must not hard-fail either')
  assert.ok(patched.includes('logicalTornMarker'), 'zstd reader must recover by dropping the bad frame')
  assert.ok(patched.includes('recoveredEvents'), 'valid events from the bad frame should be preserved for repair')

  // Idempotent: a second run must not modify the file again.
  const before = fs.readFileSync(target, 'utf8')
  const second = patchHarnessJsonl(tmp)
  assert.equal(second.changed, false)
  assert.equal(second.skipped, 0)
  assert.equal(fs.readFileSync(target, 'utf8'), before)

  fs.rmSync(tmp, { recursive: true, force: true })
})

test('patchHarnessJsonl skips missing backend', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-jsonl-patch-missing-'))
  const result = patchHarnessJsonl(tmp)
  assert.deepEqual(result, { changed: false, applied: 0, skipped: 0, sites: 0 })
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('patchHarnessJsonl skips drifted upstream code instead of failing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-jsonl-patch-drift-'))
  // Only the zstd snippet is still present; the escalation guards were
  // refactored upstream again.
  makeFakeHarness(tmp, [CURRENT_SNIPPETS[3]])

  const messages = []
  const result = patchHarnessJsonl(tmp, { log: (m) => messages.push(m) })

  assert.equal(result.changed, true, 'the still-matching snippet is applied')
  assert.equal(result.applied, 1)
  assert.equal(result.skipped, 2, 'drifted snippets are skipped, never fatal')
  assert.equal(messages.length, 2)
  assert.ok(messages.every((m) => m.includes('已跳过')))
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('patchHarnessJsonl applies to the bundled kernel with no drifted anchor', () => {
  const bundled = path.join(__dirname, '..', 'harness-deploy')
  if (!fs.existsSync(jsonlTarget(bundled))) {
    // The bundle is a build artifact and may not exist in a fresh clone.
    return
  }
  const result = patchHarnessJsonl(bundled)
  assert.equal(result.skipped, 0, 'every anchor must still match the kernel we ship')
  assert.equal(result.applied, 3)

  const patched = fs.readFileSync(jsonlTarget(bundled), 'utf8')
  assert.ok(!patched.includes('throw this.issue'), 'the shipped kernel must not hard-fail on a later turn/end')
})
