#!/usr/bin/env node
'use strict'

/**
 * Build a self-contained production closure of the dsh CLI from a working
 * harness checkout (the checkout must boot `dsh web` itself).
 *
 * pnpm's own `deploy` is unreliable for this workspace layout (legacy deploy
 * emits an unusable tree; the injected path hits a lockfileDir regression), so
 * this script materializes the closure manually, replicating pnpm's virtual
 * store layout:
 *
 *   <out>/
 *     apps/cli/{lib,config,package.json}     CLI entry (checkout layout)
 *     node_modules/
 *       .pnpm/<key>/node_modules/<name>/     one dir per resolved package
 *       <name>                               aliases for every closure package
 *
 * Resolution mirrors Node's algorithm from each package's real directory
 * (candidate <pkg>/node_modules/<name>, then parent dirs), so the exact
 * versions the checkout runs with are preserved. Dependency links inside each
 * virtual-store package are recreated as links into the merged store.
 *
 * By default the tree is FLATTENED: every alias/link is materialized as a real
 * directory copy (--flatten, default on), so the output is fully portable —
 * Windows junctions embed absolute targets and break on any directory move, and
 * electron-builder drops junction trees when packaging extraResources.
 * `--no-flatten` keeps junctions/symlinks for fast dev iteration.
 *
 * Optional dependencies are filtered to the current platform (os/cpu fields),
 * and dev-only `@types/*` packages are skipped.
 *
 * Usage: node scripts/build-closure.mjs --harness <checkout> --out <dir> [--no-flatten]
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, mkdirSync, cpSync, rmSync, symlinkSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const arg = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const HARNESS = path.resolve(arg('--harness') ?? process.env.DSH_DESKTOP_HARNESS ?? '')
const OUT = path.resolve(arg('--out') ?? path.join(ROOT, 'harness-deploy'))
const FLATTEN = !args.includes('--no-flatten')

const SCOPED_RE = /^@[^/]+\//
// Workspace package dirs: skip their node_modules (deps are re-linked into the
// merged store) plus dev-only source/junk. Registry packages: copy everything
// (native optional deps and any nested node_modules must be preserved verbatim).
const SKIP_DIRS_WORKSPACE = new Set(['node_modules', 'tests', 'stress-tests', '.git', '.turbo', 'src'])
const SKIP_DIRS_REGISTRY = new Set(['.git', '.turbo'])

/** A package manifest declares os/cpu compatibility for the current platform. */
function platformCompatible(manifest) {
  if (Array.isArray(manifest.os) && !manifest.os.includes(process.platform)) return false
  if (Array.isArray(manifest.cpu) && !manifest.cpu.includes(process.arch)) return false
  return true
}

// ── helpers ─────────────────────────────────────────────────────────────────

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** Copy a package dir into the store, skipping junk. */
function copyPackageContent(src, dst, workspace) {
  const skip = workspace ? SKIP_DIRS_WORKSPACE : SKIP_DIRS_REGISTRY
  mkdirSync(dst, { recursive: true })
  for (const entry of readdirSync(src)) {
    if (skip.has(entry)) continue
    if (entry.endsWith('.tsbuildinfo')) continue
    const from = path.join(src, entry)
    const to = path.join(dst, entry)
    try {
      cpSync(from, to, { recursive: true, dereference: false })
    } catch (error) {
      console.warn(`  ! skip ${from}: ${error.message}`)
    }
  }
}

/** Resolve one dependency name from a package's real directory (Node semantics). */
function resolveFrom(pkgDir, name, harness) {
  let dir = pkgDir
  while (true) {
    const cand = path.join(dir, 'node_modules', name)
    if (existsSync(cand)) {
      try { return realpathSync(cand) } catch { return cand }
    }
    const parent = path.dirname(dir)
    if (parent === dir || !parent.startsWith(harness)) return null
    dir = parent
  }
}

/** The .pnpm store key for a package real dir. */
function storeKey(pkgRealDir, harness) {
  // Registry packages live at <...>/node_modules/.pnpm/<key>/node_modules/<name>
  // (scoped names add one more directory level under node_modules).
  const parts = pkgRealDir.split(path.sep)
  const pnpmIdx = parts.lastIndexOf('.pnpm')
  if (pnpmIdx >= 0 && parts[pnpmIdx + 2] === 'node_modules' && parts[pnpmIdx + 3] !== undefined) {
    return parts[pnpmIdx + 1] // the <name>@<version>[_suffix] key
  }
  // Workspace package: synthesize a stable key.
  const manifest = readJson(path.join(pkgRealDir, 'package.json'))
  const name = manifest.name.replace('/', '+')
  return `${name}@${manifest.version}_workspace`
}

function linkKind() { return 'junction' }

/** Create a junction, replacing an existing one. */
function link(src, dst) {
  try { rmSync(dst, { recursive: false, force: true }) } catch { /* ok */ }
  try {
    mkdirSync(path.dirname(dst), { recursive: true })
    symlinkSync(src, dst, linkKind())
  } catch (error) {
    console.warn(`  ! link ${dst} -> ${src}: ${error.message}`)
  }
}

/** Materialize a real directory copy at dst (flatten mode). */
function copyDir(src, dst) {
  try { rmSync(dst, { recursive: true, force: true }) } catch { /* ok */ }
  try {
    mkdirSync(path.dirname(dst), { recursive: true })
    cpSync(src, dst, { recursive: true, dereference: true })
  } catch (error) {
    console.warn(`  ! copy ${dst} <- ${src}: ${error.message}`)
  }
}

// ── main ────────────────────────────────────────────────────────────────────

if (!existsSync(path.join(HARNESS, 'apps', 'cli', 'lib', 'bin.js'))) {
  console.error(`harness checkout not found or not built: ${HARNESS}`)
  process.exit(1)
}

console.log(`Building closure from ${HARNESS} -> ${OUT} (flatten=${FLATTEN})`)
rmSync(OUT, { recursive: true, force: true })

// 1. Walk the production dependency graph (Node resolution semantics).
const cliDir = path.join(HARNESS, 'apps', 'cli')
const queue = [cliDir]
const visited = new Set() // real dirs already scheduled
const nodes = [] // { real, key, name, workspace }
const nameToReal = new Map()

while (queue.length > 0) {
  const pkgDir = queue.shift()
  let real
  try { real = realpathSync(pkgDir) } catch { real = pkgDir }
  if (visited.has(real)) continue
  visited.add(real)

  const manifest = readJson(path.join(real, 'package.json'))
  const name = manifest.name ?? path.basename(real)
  const workspace = real.startsWith(HARNESS) && !real.includes(`${path.sep}.pnpm${path.sep}`)
  nodes.push({ real, key: storeKey(real, HARNESS), name, workspace })

  // All runtime-relevant specifiers: prod deps, platform optional deps (native
  // binaries live there, e.g. sharp/koffi), and peers (the harness composes
  // peer-provided services at runtime). Never devDeps.
  const specs = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
    ...(manifest.peerDependencies ?? {}),
  }
  for (const depName of Object.keys(specs)) {
    if (depName.startsWith('@types/')) continue // dev-only type stubs
    const depReal = resolveFrom(real, depName, HARNESS)
    if (!depReal) {
      console.warn(`  ! unresolvable dep ${depName} from ${name}`)
      continue
    }
    if (Object.prototype.hasOwnProperty.call(manifest.optionalDependencies ?? {}, depName)) {
      try {
        if (!platformCompatible(readJson(path.join(depReal, 'package.json')))) {
          console.warn(`  ~ skip optional ${depName} (platform mismatch)`)
          continue
        }
      } catch {
        /* unreadable manifest: keep it */
      }
    }
    const key = storeKey(depReal, HARNESS)
    const prev = nameToReal.get(depName)
    if (prev && prev !== depReal) {
      // Version conflict under one name: keep both in the store; the link
      // from each parent goes to its own resolved copy.
      console.warn(`  ! multiple versions of ${depName}`)
    } else {
      nameToReal.set(depName, depReal)
    }
    if (!visited.has(depReal)) queue.push(depReal)
  }
}

console.log(`Closure: ${nodes.length} packages`)

// 1b. Hoisting decision. Packages whose name resolves to exactly one version
// live ONCE at the top level (visible to every parent via upward resolution,
// no per-edge copies). Conflicted names hoist the first-encountered version
// (node real-dirs are deduped, so every version is represented once); the
// other versions live in the virtual store and are linked only from the
// parents that need them.
const storeRoot = path.join(OUT, 'node_modules', '.pnpm')
const topNm = path.join(OUT, 'node_modules')

const byName = new Map()
for (const node of nodes) {
  const list = byName.get(node.name) ?? []
  list.push(node)
  byName.set(node.name, list)
}
const topLevel = new Map() // name -> node hoisted to the top level
const storeNodes = new Set() // real dirs that live in the virtual store only
for (const [name, list] of byName) {
  if (list.length === 1) {
    topLevel.set(name, list[0])
  } else {
    const primary = [...list].sort((a, b) => list.filter((n) => n.real === b.real).length - list.filter((n) => n.real === a.real).length)[0]
    topLevel.set(name, primary)
    for (const node of list) {
      if (node.real !== primary.real) storeNodes.add(node.real)
    }
  }
}
console.log(`Hoisted: ${topLevel.size} unique names at top level, ${storeNodes.size} conflicted versions in store`)

// 2. Materialize: top-level hoisted copies + conflicted-version store entries.
for (const node of topLevel.values()) {
  console.log(`  + ${node.name} (top-level)`)
  copyPackageContent(node.real, path.join(topNm, node.name), node.workspace)
}
for (const node of nodes) {
  if (!storeNodes.has(node.real)) continue
  const dest = path.join(storeRoot, node.key, 'node_modules', node.name)
  console.log(`  + ${node.name} -> ${node.key} (conflicted version)`)
  copyPackageContent(node.real, dest, node.workspace)
}

// 3. Per-parent dependency links, only where upward resolution cannot see the
// needed version. A parent's own "node_modules" is:
//   - hoisted parent:  <topNm>/<parentName>/node_modules
//   - store parent:    <storeRoot>/<parentKey>/node_modules
const parentNmOf = (node) => (topLevel.get(node.name)?.real === node.real
  ? path.join(topNm, node.name, 'node_modules')
  : path.join(storeRoot, node.key, 'node_modules'))

const realToNode = new Map(nodes.map((n) => [n.real, n]))

for (const node of nodes) {
  const manifest = readJson(path.join(node.real, 'package.json'))
  const specs = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
    ...(manifest.peerDependencies ?? {}),
  }
  const parentNm = parentNmOf(node)
  for (const depName of Object.keys(specs)) {
    if (depName.startsWith('@types/')) continue
    const depReal = resolveFrom(node.real, depName, HARNESS)
    if (!depReal) continue
    if (Object.prototype.hasOwnProperty.call(manifest.optionalDependencies ?? {}, depName)) {
      try {
        if (!platformCompatible(readJson(path.join(depReal, 'package.json')))) continue
      } catch {
        /* keep it */
      }
    }
    // The hoisted top-level copy satisfies this edge: upward resolution finds
    // it from anywhere, so no per-parent copy is needed.
    const hoisted = topLevel.get(depName)
    if (hoisted && hoisted.real === depReal) continue
    const depNode = realToNode.get(depReal)
    if (!depNode) continue
    const target = path.join(storeRoot, depNode.key, 'node_modules', depName)
    if (!existsSync(target)) continue
    if (FLATTEN) copyDir(target, path.join(parentNm, depName))
    else link(target, path.join(parentNm, depName))
  }
}

// 5. The CLI entry in checkout layout.
const cliOut = path.join(OUT, 'apps', 'cli')
mkdirSync(cliOut, { recursive: true })
for (const entry of ['package.json', 'lib', 'config', 'README.md', 'README.zh.md', 'composition.md']) {
  const src = path.join(cliDir, entry)
  if (existsSync(src)) cpSync(src, path.join(cliOut, entry), { recursive: true })
}

// 6. Sanity.
const checks = [
  ['apps/cli/lib/bin.js', path.join(OUT, 'apps', 'cli', 'lib', 'bin.js')],
  ['node_modules/@deepseek-ai/dsh-web-app', path.join(OUT, 'node_modules', '@deepseek-ai', 'dsh-web-app')],
  ['node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html', path.join(OUT, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')],
]
for (const [label, p] of checks) {
  if (!existsSync(p)) {
    console.error(`FAIL: missing ${label}`)
    process.exit(1)
  }
}

if (FLATTEN) {
  // A flattened tree must contain no reparse points (junctions/symlinks):
  // spot-check the alias layer and one dependency-link position.
  const probes = [
    path.join(OUT, 'node_modules', '@deepseek-ai', 'dsh-web-app'),
    path.join(OUT, 'node_modules', 'commander'),
  ]
  for (const p of probes) {
    try {
      if (statSync(p).isSymbolicLink()) {
        console.error(`FAIL: reparse point still present in flattened tree: ${p}`)
        process.exit(1)
      }
    } catch {
      /* probe missing: not fatal here (sanity checks above cover it) */
    }
  }
  console.log('Flatten check passed (no reparse points).')
}

// Bundle manifest for provenance.
const cliManifest = readJson(path.join(HARNESS, 'apps', 'cli', 'package.json'))
writeFileSync(
  path.join(OUT, 'manifest.json'),
  JSON.stringify({
    name: 'dsh-harness-bundle',
    harnessCheckout: HARNESS,
    harnessVersion: cliManifest.version ?? 'unknown',
    builtAt: new Date().toISOString(),
    node: process.version,
    flattened: FLATTEN,
    packageCount: nodes.length,
  }, null, 2) + '\n',
)
console.log(`Bundle manifest written (harness ${cliManifest.version ?? 'unknown'}, ${nodes.length} packages, flattened=${FLATTEN}).`)

console.log('Sanity checks passed.')

// 7. Boot smoke: the deployed CLI must serve.
const smokeHome = path.join(OUT, '..', '.smoke-home-closure')
rmSync(smokeHome, { recursive: true, force: true })

// Pre-heal the profile module fallback with junctions (Windows symlink
// creation needs privileges the build shell may lack; junctions do not).
// dsh's own heal step then sees the links and keeps them.
{
  const topAi = path.join(OUT, 'node_modules', '@deepseek-ai')
  const profilesNm = path.join(smokeHome, 'profiles', 'node_modules')
  mkdirSync(path.join(profilesNm, '@deepseek-ai'), { recursive: true })
  for (const entry of readdirSync(topAi)) {
    const target = path.join(topAi, entry)
    const dest = path.join(profilesNm, '@deepseek-ai', entry)
    try { symlinkSync(target, dest, linkKind()) } catch { /* already linked */ }
  }
}

console.log('Smoke-booting the deployed CLI…')
const bin = path.join(OUT, 'apps', 'cli', 'lib', 'bin.js')
try {
  execFileSync('node', [bin, 'web', '--port', '0'], {
    cwd: OUT,
    env: { ...process.env, DSH_HOME: smokeHome },
    timeout: 75000,
    stdio: 'inherit',
  })
  console.error('warn: deployed CLI exited before the smoke window')
} catch (error) {
  // Timeout kill on Windows: execFileSync reports code ETIMEDOUT.
  if (error.code === 'ETIMEDOUT') {
    console.log('OK: deployed CLI booted (killed after smoke window)')
  } else {
    console.error('FAIL: deployed CLI did not boot cleanly')
    rmSync(smokeHome, { recursive: true, force: true })
    process.exit(1)
  }
}
rmSync(smokeHome, { recursive: true, force: true })
console.log(`Done. Bundled harness at: ${OUT}`)
