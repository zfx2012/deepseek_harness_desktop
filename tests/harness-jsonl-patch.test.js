'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { patchHarnessJsonl } = require('../src/harness-jsonl-patch')

const OLD_SNIPPETS = [
  '\t\tif (this.issue !== void 0) {\n' +
    '\t\t\tif (decoded.some((event) => event.type === "turn/end")) throw this.issue;\n' +
    '\t\t\treturn;\n' +
    '\t\t}',
  '\t\t\t\tthis.issue = /* @__PURE__ */ new Error(`corrupt session log: seq gap in committed region at line ${this.eventLine} (expected ${expected}, got ${event.seq})`);\n' +
    '\t\t\t\tif (decoded.some((candidate) => candidate.type === "turn/end")) throw this.issue;\n' +
    '\t\t\t\treturn;',
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

function makeFakeHarness(dir) {
  const target = path.join(
    dir,
    'node_modules',
    '@deepseek-ai',
    'dsh-session-persistence-jsonl',
    'lib',
    'index.js',
  )
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, OLD_SNIPPETS.join('\n\n'), 'utf8')
  return target
}

test('patchHarnessJsonl removes turn/end escalation and adds zstd logical-frame recovery', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-jsonl-patch-'))
  const target = makeFakeHarness(tmp)

  const result = patchHarnessJsonl(tmp)
  assert.equal(result.changed, true)
  assert.equal(result.applied, 3)
  assert.equal(result.skipped, 0)

  const patched = fs.readFileSync(target, 'utf8')
  assert.ok(!patched.includes('throw this.issue'), 'turn/end after a gap must not hard-fail')
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
  assert.deepEqual(result, { changed: false, applied: 0, skipped: 0 })
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('patchHarnessJsonl skips drifted upstream code instead of failing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-jsonl-patch-drift-'))
  const target = path.join(
    tmp,
    'node_modules',
    '@deepseek-ai',
    'dsh-session-persistence-jsonl',
    'lib',
    'index.js',
  )
  fs.mkdirSync(path.dirname(target), { recursive: true })
  // Only the first snippet is still present; the rest were refactored upstream.
  fs.writeFileSync(target, OLD_SNIPPETS[0], 'utf8')

  const messages = []
  const result = patchHarnessJsonl(tmp, { log: (m) => messages.push(m) })

  assert.equal(result.changed, true, 'the still-matching snippet is applied')
  assert.equal(result.applied, 1)
  assert.equal(result.skipped, 2, 'drifted snippets are skipped, never fatal')
  assert.equal(messages.length, 2)
  assert.ok(messages.every((m) => m.includes('已跳过')))
  fs.rmSync(tmp, { recursive: true, force: true })
})
