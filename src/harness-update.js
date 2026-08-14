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
 * Install a published dsh version into a deploy-layout harness root:
 *
 *   1. `npm install @deepseek-ai/dsh@<version>` into a temp stage
 *      (npm hoists the full dependency closure, incl. dsh-web-app);
 *   2. merge the package's own files (lib/, package.json, …) onto the root;
 *   3. merge the dependency closure into <root>/node_modules;
 *   4. rewrite manifest.json so the "built-in" version display stays true.
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
async function installHarnessUpdate(version, targetRoot, { npmCommand, spawnImpl, log = () => {}, fresh = false } = {}) {
  const ver = String(version ?? '').trim()
  if (!/^\d+\.\d+\.\d+/.test(ver)) throw new Error(`无效的版本号: ${ver}`)
  if (!fresh) {
    const bin = path.join(targetRoot, 'lib', 'bin.js')
    if (!fs.existsSync(bin)) throw new Error(`目标目录不是 deploy 布局（缺少 lib/bin.js），无法直接更新：${targetRoot}`)
    if (!fs.existsSync(path.join(targetRoot, 'node_modules'))) {
      throw new Error(`目标目录缺少 node_modules，无法直接更新：${targetRoot}`)
    }
  }
  const run = spawnImpl ?? spawnSync
  const npmCmd = npmCommand ?? (process.platform === 'win32' ? 'npm.cmd' : 'npm')
  // Some sandboxed/CI environments refuse to spawn .cmd shims directly
  // (EINVAL); retry through cmd.exe /c when that happens.
  const runNpm = (args, opts) => {
    const direct = run(npmCmd, args, opts)
    if (direct && (direct.status !== null || !direct.error)) return direct
    // cmd.exe /c needs the command itself as the first token (npm, not the
    // first argument); quote arguments that contain whitespace.
    const quoted = args.map((a) => (/[ \t"]/.test(a) ? `"${a}"` : a))
    return run('cmd.exe', ['/d', '/s', '/c', npmCmd, ...quoted], opts)
  }

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-'))
  try {
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

    // 2. the package's own files replace the root-level ones (node_modules and
    //    manifest.json are handled separately and never clobbered). Stale root
    //    files that no longer ship in the package are removed.
    mergeDir(pkg, targetRoot, new Set(['node_modules']))
    {
      const pkgEntries = new Set(fs.readdirSync(pkg))
      const keep = new Set(['node_modules', 'manifest.json'])
      for (const entry of fs.readdirSync(targetRoot)) {
        if (!pkgEntries.has(entry) && !keep.has(entry)) {
          fs.rmSync(path.join(targetRoot, entry), { recursive: true, force: true })
        }
      }
    }
    // 3. replace the dependency closure with the freshly installed one. The
    //    old tree is moved aside first so a mid-merge failure can roll back
    //    (fresh bundles have nothing to preserve).
    {
      const targetNm = path.join(targetRoot, 'node_modules')
      const backup = `${targetNm}.bak`
      const hadOld = fs.existsSync(targetNm)
      if (hadOld) {
        fs.rmSync(backup, { recursive: true, force: true })
        fs.renameSync(targetNm, backup)
      }
      try {
        fs.mkdirSync(targetNm, { recursive: true })
        // Hoisted closure (everything except the installed package itself,
        // which lives at the root after step 2).
        const newNm = path.join(stage, 'node_modules')
        for (const entry of fs.readdirSync(newNm)) {
          if (entry === '.bin' || entry === '.package-lock.json' || entry === 'package-lock.json') continue
          if (entry === '@deepseek-ai' && fs.existsSync(path.join(newNm, entry, 'dsh'))) {
            for (const child of fs.readdirSync(path.join(newNm, entry))) {
              if (child === 'dsh') continue
              mergeDir(path.join(newNm, entry, child), path.join(targetNm, entry, child))
            }
          } else {
            mergeDir(path.join(newNm, entry), path.join(targetNm, entry))
          }
        }
        // Nested conflict copies under the installed package: additive.
        mergeDir(path.join(pkg, 'node_modules'), targetNm)
        if (hadOld) fs.rmSync(backup, { recursive: true, force: true })
      } catch (error) {
        fs.rmSync(targetNm, { recursive: true, force: true })
        if (hadOld) fs.renameSync(backup, targetNm) // roll back to the old closure
        throw error
      }
    }

    // 4. provenance manifest, mirroring scripts/build-closure.mjs.
    let pkgJson = {}
    try {
      pkgJson = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'))
    } catch { /* keep {} */ }
    const count = fs.existsSync(path.join(targetRoot, 'node_modules'))
      ? fs.readdirSync(path.join(targetRoot, 'node_modules')).length
      : 0
    fs.writeFileSync(
      path.join(targetRoot, 'manifest.json'),
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
    log(`内核已更新到 ${pkgJson.version ?? ver}。`)
    return { ok: true, version: pkgJson.version ?? ver, packageCount: count }
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
  OFFICIAL_REPO_URL,
  NPM_REGISTRY_URL,
}
