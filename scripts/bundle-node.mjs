#!/usr/bin/env node
'use strict'

/**
 * Bundle the official Node.js Windows x64 runtime into node-runtime/ so the
 * packaged app can run the harness kernel — and its own kernel updates — on a
 * machine with NO system Node.js.
 *
 * Why a real Node instead of Electron's ELECTRON_RUN_AS_NODE mode: kernels from
 * 0.2.0 load `node-addon-require-builtin`, a native addon that probes internal
 * module loaders and accepts only an exact table of Electron runtime
 * fingerprints (V8 build strings such as 15.0.245.13-electron.0 for Electron
 * 43.0.0). Any other Electron patch release is rejected with "unsupported
 * Electron runtime fingerprint", so tying the kernel to our own Electron would
 * freeze the app on one exact Electron build. A plain Node runtime has no such
 * table.
 *
 * The full distribution is kept (node.exe + npm), so in-app "更新内核" also
 * works without a system npm.
 *
 * Usage: node scripts/bundle-node.mjs [--version v24.21.0] [--force]
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT = path.join(ROOT, 'node-runtime')
const CACHE = path.join(ROOT, '.cache', 'node')

/** Node release line kept in step with the harness engines (^22.19 || >=24). */
const DEFAULT_VERSION = 'v24.21.0'
/** Primary and mirror download roots; the mirror is used when nodejs.org fails. */
const SOURCES = [
  (version) => `https://nodejs.org/dist/${version}`,
  (version) => `https://npmmirror.com/mirrors/node/${version}`,
]

const args = process.argv.slice(2)
const versionFlag = args.indexOf('--version')
const VERSION = versionFlag >= 0 ? args[versionFlag + 1] : DEFAULT_VERSION
const FORCE = args.includes('--force')

const log = (...m) => console.log(...m)
const zipName = `node-${VERSION}-win-x64.zip`

function readManifest() {
  try {
    return JSON.parse(readFileSync(path.join(OUT, 'manifest.json'), 'utf8'))
  } catch {
    return null
  }
}

/** Download a URL to a file, returning false instead of throwing. */
async function download(url, file) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) })
    if (!res.ok) {
      log(`  下载失败 HTTP ${res.status}: ${url}`)
      return false
    }
    writeFileSync(file, Buffer.from(await res.arrayBuffer()))
    return true
  } catch (error) {
    log(`  下载失败（${error.message}）: ${url}`)
    return false
  }
}

/** Fetch the release directory's SHASUMS256.txt and return the expected hash. */
async function expectedSha256(baseUrl) {
  const file = path.join(CACHE, `SHASUMS256-${VERSION}.txt`)
  if (!(await download(`${baseUrl}/SHASUMS256.txt`, file))) return null
  const line = readFileSync(file, 'utf8').split('\n').find((l) => l.trim().endsWith(zipName))
  return line ? line.trim().split(/\s+/)[0].toLowerCase() : null
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Extract a zip with the in-box bsdtar (fast); fall back to Expand-Archive. */
function extractZip(zip, dest) {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  const tar = spawnSync('tar', ['-xf', zip, '-C', dest], { windowsHide: true })
  if (tar.status === 0 && !tar.error) return
  log('  tar 解压失败，改用 Expand-Archive…')
  const ps = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`],
    { windowsHide: true },
  )
  if (ps.status !== 0) throw new Error(`解压失败: ${zip}`)
}

/** Copy the runtime pieces we ship (node.exe + npm, no docs/headers). */
function installRuntime(extractDir) {
  const from = path.join(extractDir, `node-${VERSION}-win-x64`)
  if (!existsSync(path.join(from, 'node.exe'))) throw new Error(`发行包结构异常，未找到 node.exe: ${from}`)
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  for (const rel of ['node.exe', 'node_modules/npm', 'npm', 'npm.cmd', 'npx', 'npx.cmd']) {
    const src = path.join(from, rel)
    if (existsSync(src)) cpSync(src, path.join(OUT, rel), { recursive: true })
  }
  const npmCli = path.join(OUT, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!existsSync(npmCli)) throw new Error(`缺少 npm: ${npmCli}`)
  return npmCli
}

// ── main ────────────────────────────────────────────────────────────────────

const current = readManifest()
if (!FORCE && current?.version === VERSION && existsSync(path.join(OUT, 'node.exe'))) {
  log(`node-runtime/ already bundled (${current.version}, node.exe ${current.nodeExeBytes} bytes)`)
  process.exit(0)
}

log(`Bundling the official Node.js runtime ${VERSION} (win-x64)`)
mkdirSync(CACHE, { recursive: true })
const zip = path.join(CACHE, zipName)

let base = null
if (!existsSync(zip)) {
  for (const make of SOURCES) {
    const candidate = make(VERSION)
    log(`  尝试 ${candidate}`)
    if (await download(`${candidate}/${zipName}`, zip)) {
      base = candidate
      break
    }
  }
  if (base === null) throw new Error(`无法下载 ${zipName}（nodejs.org 与镜像均失败）`)
} else {
  base = SOURCES[0](VERSION)
  log(`  复用已下载的 ${zip}`)
}

// Integrity: the runtime executes the harness kernel, so never ship an
// unverified copy of it. A missing SHASUMS (offline mirror) is a hard failure
// unless the hash was already recorded for this exact archive.
const expected = await expectedSha256(base)
const actual = sha256(zip)
if (expected === null) {
  throw new Error(`无法获取 ${VERSION} 的 SHASUMS256.txt 校验值，拒绝使用未校验的运行时`)
}
if (expected !== actual) throw new Error(`校验失败：${zipName} sha256 ${actual} != ${expected}`)
log(`  校验通过 sha256=${actual}`)

const extractDir = path.join(CACHE, `extract-${VERSION}`)
extractZip(zip, extractDir)
const npmCli = installRuntime(extractDir)

const nodeExe = path.join(OUT, 'node.exe')
const probe = spawnSync(nodeExe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
if (probe.status !== 0) throw new Error(`打包的 node.exe 无法运行: ${probe.stderr || probe.error}`)
writeFileSync(
  path.join(OUT, 'manifest.json'),
  JSON.stringify(
    {
      name: 'dsh-node-runtime',
      version: VERSION,
      node: probe.stdout.trim(),
      platform: 'win32',
      arch: 'x64',
      sha256: actual,
      nodeExeBytes: existsSync(nodeExe) ? readFileSync(nodeExe).length : 0,
      npmCli,
      builtAt: new Date().toISOString(),
      host: `${os.platform()}-${os.arch()}`,
    },
    null,
    2,
  ) + '\n',
)
log(`Bundled Node runtime: ${probe.stdout.trim()} (${OUT})`)
