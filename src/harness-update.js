'use strict'

/**
 * dsh-desktop — harness (kernel) update check + direct update.
 *
 * The check source is intentionally hardcoded here and never shown in the UI:
 * the official release channel is npm (`@deepseek-ai/dsh`), so the latest
 * published version is read from the registry's dist-tags. The repo link
 * surfaced to the user points at the official GitHub repository.
 *
 * Direct updates install a published version into a DEPLOY-layout harness root
 * (root/lib/bin.js + root/node_modules, e.g. the bundled resources/harness):
 * `npm install` materializes the official package with its full production
 * dependency tree into a temp stage, which is then merged into the target.
 */

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { patchHarnessJsonl } = require('./harness-jsonl-patch')

const OFFICIAL_REPO_URL = 'https://github.com/deepseek-ai/deepseek-harness'
const NPM_REGISTRY_URL = 'https://registry.npmjs.org/@deepseek-ai/dsh'
/** npm install of the whole harness closure can take a while. */
const NPM_INSTALL_TIMEOUT_MS = 15 * 60 * 1000

/**
 * Compare two semver-ish version strings (x.y.z[-prerelease.N]).
 * @returns negative when a < b, 0 when equal, positive when a > b.
 */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = String(v).trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/)
    if (!m) return null
    const pre = m[4] ?? ''
    const preNums = pre.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre, preNums }
  }
  const pa = parse(a)
  const pb = parse(b)
  if (!pa && !pb) return String(a).localeCompare(String(b))
  if (!pa) return -1
  if (!pb) return 1
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] - pb[key]
  }
  // Identical core: a release outranks any prerelease; prereleases compare
  // field-by-field (numeric fields numerically).
  if (pa.pre === pb.pre) return 0
  if (pa.pre === '') return 1
  if (pb.pre === '') return -1
  const len = Math.max(pa.preNums.length, pb.preNums.length)
  for (let i = 0; i < len; i++) {
    const x = pa.preNums[i]
    const y = pb.preNums[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y
    } else {
      const cmp = String(x).localeCompare(String(y))
      if (cmp !== 0) return cmp
    }
  }
  return 0
}

/**
 * Fetch the official repository's latest PUBLISHED harness version from the
 * npm registry (the official release channel).
 * @param {object} [deps] - { fetchImpl?, registryUrl? } for tests.
 * @returns {Promise<{ latest: string, repoUrl: string }>}
 */
async function fetchOfficialHarnessVersion({ fetchImpl, registryUrl } = {}) {
  const fetchFn = fetchImpl ?? fetch
  const url = registryUrl ?? NPM_REGISTRY_URL
  const res = await fetchFn(url, { signal: AbortSignal.timeout(10000) })
  if (!res.ok) {
    throw new Error(`official version check failed: HTTP ${res.status}`)
  }
  const manifest = await res.json()
  const version = typeof manifest?.['dist-tags']?.latest === 'string' ? manifest['dist-tags'].latest : null
  if (!version) {
    throw new Error('official version manifest has no dist-tags.latest')
  }
  return { latest: version, repoUrl: OFFICIAL_REPO_URL }
}

/**
 * Copy <src>/<entry> over <dst>/<entry> (replace). Returns the number of
 * top-level entries copied. Lockfiles and .bin shims are skipped; entries in
 * `exclude` (relative names) are skipped as well. Scoped (@scope) directories
 * are merged child-by-child so earlier merges into the same scope survive.
 */
function mergeDir(src, dst, exclude = new Set()) {
  if (!fs.existsSync(src)) return 0
  fs.mkdirSync(dst, { recursive: true })
  let copied = 0
  for (const entry of fs.readdirSync(src)) {
    if (entry === '.bin' || entry === '.package-lock.json' || entry === 'package-lock.json') continue
    if (exclude.has(entry)) continue
    const from = path.join(src, entry)
    const to = path.join(dst, entry)
    if (entry.startsWith('@')) {
      mergeDir(from, to)
    } else {
      fs.rmSync(to, { recursive: true, force: true })
      fs.cpSync(from, to, { recursive: true })
    }
    copied++
  }
  return copied
}

/**
 * File kinds that no runtime path reads:
 *
 *  - `.d.ts` / `.map`: TypeScript declarations and source maps. A published
 *    closure carries thousands of them, and they dominate the *installer* cost
 *    (extraction is per-file bound: measured, extracting the payload and
 *    plain-copying the same tree take the same time).
 *  - `.pdb`: Windows debug symbols shipped inside node-pty's prebuilds (~20 MB).
 *
 * Safety: no runtime module under the closure references `.d.ts` or `.pdb`
 * (verified by scanning every .js/.mjs/.cjs for the literal), `.map` files are
 * only named by `sourceMappingURL` comments, which Node reads only when started
 * with --enable-source-maps (the desktop never passes it), and `.pdb` files are
 * debugger-only artifacts. `.ts`/`.mts` sources are deliberately KEPT — some
 * packages load them at runtime.
 */
const DEV_ARTIFACT_SUFFIXES = ['.d.ts', '.map', '.pdb']

/**
 * Directory fragments that only another platform/architecture would load. The
 * shipped installers are win32-x64 ("--win --x64"), so an arm64 prebuild can
 * never be selected: node-pty and friends resolve `prebuilds/<platform>-<arch>`
 * from `process.arch`.
 */
const FOREIGN_ARCH_DIRS = ['win32-arm64', 'win10-arm64']

/**
 * Delete dev-only and foreign-architecture files under a harness root, in place.
 * @param {string} root - harness root.
 * @param {object} [deps] - { pruneForeignArch?: boolean } (default true; the
 *   release builds x64 only).
 * @returns {number} number of files removed.
 */
function pruneDevArtifacts(root, { pruneForeignArch = true } = {}) {
  const stack = [root]
  let removed = 0
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue // unreadable directory: nothing to prune inside it
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (pruneForeignArch && FOREIGN_ARCH_DIRS.includes(entry.name)) {
          // Count the files so the caller's log line reflects the real saving.
          removed += countFiles(full)
          try {
            fs.rmSync(full, { recursive: true, force: true })
          } catch {
            /* locked: leave it */
          }
          continue
        }
        stack.push(full)
        continue
      }
      if (!DEV_ARTIFACT_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue
      try {
        fs.rmSync(full, { force: true })
        removed += 1
      } catch {
        /* locked by an indexer/antivirus — leave it, it is only dead weight */
      }
    }
  }
  return removed
}

/** Number of files under a directory (best effort, for progress reporting). */
function countFiles(dir) {
  let count = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(path.join(current, entry.name))
      else count += 1
    }
  }
  return count
}

/**
 * The npm command that ships inside the app (scripts/bundle-node.mjs installs
 * the official Node distribution as resources/node), or null when absent. The
 * bundled npm.cmd resolves node.exe from its own directory, so it works with
 * no Node.js on PATH and no PATH lookup at all.
 * @param {object} [deps] - { resourcesPath?, appRoot? } for tests.
 */
function bundledNpmCommand(deps = {}) {
  const resourcesPath = deps.resourcesPath !== undefined ? deps.resourcesPath : process.resourcesPath
  const appRoot = deps.appRoot !== undefined ? deps.appRoot : path.join(__dirname, '..')
  const candidates = []
  if (resourcesPath) candidates.push(path.join(resourcesPath, 'node', 'npm.cmd'))
  candidates.push(path.join(appRoot, 'node-runtime', 'npm.cmd'))
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* unreadable: try the next location */
    }
  }
  return null
}

/**
 * Install a published dsh version into a deploy-layout harness root:
 *
 *   1. `npm install @deepseek-ai/dsh@<version>` into a temp stage
 *      (npm hoists the full dependency closure, incl. dsh-web-app);
 *   2. materialize the COMPLETE new tree (package files + dependency
 *      closure + manifest.json) in a sibling temp directory;
 *   3. atomically swap it into place with two same-volume renames — the old
 *      tree stays untouched until the new one is fully built, so a mid-merge
 *      failure can never leave a mixed old/new tree.
 *
 * The target must be a deploy layout (lib/bin.js), NOT a source checkout —
 * replacing files under a checkout would leave a mixed tree. The running
 * server must be stopped beforehand (native modules lock files on Windows).
 *
 * @param {string} version - exact version to install (e.g. "0.1.0-rc.6").
 * @param {string} targetRoot - deploy-layout harness root.
 * @param {object} [deps] - { npmCommand?, spawnImpl?, log?, fresh? } for tests.
 *   `fresh: true` allows building into a brand-new directory (bundle path);
 *   the default requires an existing deploy-layout root (update path).
 * @returns {Promise<{ ok: true, version: string, packageCount: number }>}
 * @throws when npm fails or the result is not a valid harness.
 */
async function installHarnessUpdate(version, targetRoot, { npmCommand, spawnImpl, log = () => {}, fresh = false, bundledNpm } = {}) {
  const ver = String(version ?? '').trim()
  // Anchored semver-ish: x.y.z with an optional -prerelease suffix. Anything
  // else must never reach `npm install <pkg>@<ver>`.
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(ver)) throw new Error(`无效的版本号: ${ver}`)
  if (!fresh) {
    const bin = path.join(targetRoot, 'lib', 'bin.js')
    if (!fs.existsSync(bin)) throw new Error(`目标目录不是 deploy 布局（缺少 lib/bin.js），无法直接更新：${targetRoot}`)
    if (!fs.existsSync(path.join(targetRoot, 'node_modules'))) {
      throw new Error(`目标目录缺少 node_modules，无法直接更新：${targetRoot}`)
    }
  }
  const run = spawnImpl ?? spawnSync
  let npmCmd = npmCommand ?? (process.platform === 'win32' ? 'npm.cmd' : 'npm')
  // Some restricted environments refuse to spawn .cmd shims directly
  // (EINVAL/ENOENT); retry through cmd.exe /c only for those spawn-level
  // failures. Other failures (timeouts, non-zero exits) must surface as-is —
  // retrying would double-run a 3-minute install.
  const runNpm = (args, opts) => {
    const direct = run(npmCmd, args, opts)
    if (direct && (direct.status !== null || !direct.error)) return direct
    const code = direct && direct.error ? direct.error.code : undefined
    if (code !== 'EINVAL' && code !== 'ENOENT') return direct
    // cmd.exe /c needs the command itself as the first token (npm, not the
    // first argument); quote arguments that contain whitespace.
    const quoted = args.map((a) => (/[ \t"]/.test(a) ? `"${a}"` : a))
    return run('cmd.exe', ['/d', '/s', '/c', npmCmd, ...quoted], opts)
  }

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-'))
  try {
    // Preflight: the update shells out to npm, so a machine without Node.js
    // would otherwise fail deep inside the install with an opaque spawn error.
    // The bundled runtime is the fallback, so "no system Node" still updates.
    let probe = runNpm(['--version'], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
    if ((!probe || probe.status !== 0) && npmCommand === undefined) {
      const bundled = bundledNpm !== undefined ? bundledNpm : bundledNpmCommand()
      if (bundled !== null && bundled !== npmCmd) {
        log('未检测到系统 npm，改用应用内置的 Node/npm 运行时。')
        npmCmd = bundled
        probe = runNpm(['--version'], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
      }
    }
    if (!probe || probe.status !== 0) {
      const detail = probe && probe.error ? `（${probe.error.code || probe.error.message}）` : ''
      throw new Error(
        `未检测到可用的 npm${detail}。更新内核需要系统安装 Node.js（含 npm），`
        + '或使用带内置 Node 运行时的桌面端安装包；'
        + '也可以直接安装新版桌面端来更新内置内核。',
      )
    }
    // Anchor npm to the stage: without a package.json npm walks up to the
    // nearest project root (or, from a temp dir, ends up installing into the
    // user's HOME directory). A minimal manifest keeps everything in the stage.
    fs.writeFileSync(
      path.join(stage, 'package.json'),
      JSON.stringify({ name: 'dsh-update-stage', private: true, version: '0.0.0' }),
    )
    log(`正在下载并安装 @deepseek-ai/dsh@${ver}（需要几分钟）…`)
    const result = runNpm(['install', `@deepseek-ai/dsh@${ver}`, '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: stage,
      encoding: 'utf8',
      windowsHide: true,
      timeout: NPM_INSTALL_TIMEOUT_MS,
    })
    if (!result || result.status !== 0) {
      const tail = String((result && (result.stderr || result.stdout)) || '')
        .trim()
        .split('\n')
        .slice(-5)
        .join('\n')
      throw new Error(`npm install 失败（exit ${result ? result.status : '?'}）${tail ? `：${tail}` : ''}`)
    }
    const pkg = path.join(stage, 'node_modules', '@deepseek-ai', 'dsh')
    if (!fs.existsSync(path.join(pkg, 'lib', 'bin.js'))) {
      throw new Error('下载的 @deepseek-ai/dsh 缺少 lib/bin.js，更新已中止。')
    }

    // Build the COMPLETE new tree in a sibling temp directory, then swap it
    // into place with two same-volume renames. The old tree stays untouched
    // until the new one is fully materialized — a failure at any merge step
    // can never leave a half-old/half-new mixed tree behind.
    const temp = path.join(path.dirname(targetRoot), `.dsh-harness-new-${process.pid}-${Date.now()}`)
    const backup = `${targetRoot}.old-${process.pid}-${Date.now()}`
    fs.mkdirSync(temp, { recursive: true })
    try {
      // 2. the package's own files form the new root (node_modules handled next).
      mergeDir(pkg, temp, new Set(['node_modules']))
      // 3. dependency closure: hoisted top level (minus the package itself)
      //    plus any nested conflict copies under the package.
      const tempNm = path.join(temp, 'node_modules')
      const newNm = path.join(stage, 'node_modules')
      fs.mkdirSync(tempNm, { recursive: true })
      for (const entry of fs.readdirSync(newNm)) {
        if (entry === '.bin' || entry === '.package-lock.json' || entry === 'package-lock.json') continue
        if (entry === '@deepseek-ai' && fs.existsSync(path.join(newNm, entry, 'dsh'))) {
          for (const child of fs.readdirSync(path.join(newNm, entry))) {
            if (child === 'dsh') continue
            mergeDir(path.join(newNm, entry, child), path.join(tempNm, entry, child))
          }
        } else {
          mergeDir(path.join(newNm, entry), path.join(tempNm, entry))
        }
      }
      mergeDir(path.join(pkg, 'node_modules'), tempNm)

      // 3b. drop declaration files and source maps before the swap: they cost
      //     real install time on every user machine and are never loaded.
      const pruned = pruneDevArtifacts(temp)
      if (pruned > 0) log(`已移除 ${pruned} 个仅开发用的类型声明/源码映射文件（不影响运行）。`)

      // 4. provenance manifest, mirroring scripts/build-closure.mjs.
      let pkgJson = {}
      try {
        pkgJson = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'))
      } catch { /* keep {} */ }
      const count = fs.readdirSync(tempNm).length
      fs.writeFileSync(
        path.join(temp, 'manifest.json'),
        JSON.stringify({
          name: 'dsh-harness-bundle',
          harnessCheckout: 'updated by desktop app',
          harnessVersion: pkgJson.version ?? ver,
          builtAt: new Date().toISOString(),
          node: process.version,
          flattened: true,
          packageCount: count,
          updatedBy: 'dsh-desktop',
        }, null, 2) + '\n',
      )

      // Pin the dependency tree for reproducibility audits: the npm lockfile
      // from the stage records the exact transitive versions that were
      // installed into this tree.
      const lock = path.join(stage, 'package-lock.json')
      if (fs.existsSync(lock)) {
        fs.copyFileSync(lock, path.join(temp, 'package-lock.json'))
      }
      // Local resilience enhancement — never a gate: snippets that no longer
      // match upstream code are skipped and the update continues.
      const patch = patchHarnessJsonl(temp, { log })
      if (patch.skipped > 0) {
        log(`注意：${patch.skipped} 项会话日志韧性补丁未适用（内核代码已变化），更新继续。`)
      }

      // 5. atomic swap: old tree moves aside, new tree takes its name. If the
      //    second rename fails, the old tree is restored (a failing rollback
      //    must not mask the original error — it is attached as a warning).
      const hadOld = fs.existsSync(targetRoot)
      if (hadOld) {
        fs.rmSync(backup, { recursive: true, force: true })
        fs.renameSync(targetRoot, backup)
      }
      try {
        fs.renameSync(temp, targetRoot)
      } catch (error) {
        if (hadOld) {
          try {
            fs.renameSync(backup, targetRoot)
          } catch (rollbackError) {
            error.message = `${error.message}（且回滚失败：${rollbackError.message}，旧树保留在 ${backup}）`
          }
        }
        throw error
      }
      if (hadOld) {
        try { fs.rmSync(backup, { recursive: true, force: true }) } catch { /* leftover backup is harmless */ }
      }
        
      log(`内核已更新到 ${pkgJson.version ?? ver}。`)
      return { ok: true, version: pkgJson.version ?? ver, packageCount: count }
    } catch (error) {
      try { fs.rmSync(temp, { recursive: true, force: true }) } catch { /* best effort */ }
      throw error
    }
  } finally {
    // Temp cleanup is best-effort: antivirus/indexers can briefly lock the
    // stage dir on Windows — a failed cleanup must never mask a successful
    // update (or the real error) with EPERM.
    try {
      fs.rmSync(stage, { recursive: true, force: true })
    } catch {
      /* leftover temp dir is harmless */
    }
  }
}

module.exports = {
  compareVersions,
  fetchOfficialHarnessVersion,
  installHarnessUpdate,
  pruneDevArtifacts,
  bundledNpmCommand,
  OFFICIAL_REPO_URL,
  NPM_REGISTRY_URL,
}
