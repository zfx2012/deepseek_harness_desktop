'use strict'

/**
 * dsh-desktop — server manager.
 *
 * Spawns the DeepSeek Harness web server (`dsh web`) as a child process,
 * waits for its readiness line (`dsh web: http://127.0.0.1:<port>`) and owns
 * its lifecycle: restart, crash handling, and a reliable process-tree kill on
 * Windows (taskkill /T /F).
 *
 * The child's stdout/stderr are redirected to a log FILE through open file
 * descriptors (no pipes). This keeps the parent decoupled from the child's
 * output (a long-lived child can never wedge the parent's pipe buffers) and
 * works in sandboxed environments where pipe-based spawns are denied.
 * Readiness is detected by polling the file tail.
 */

const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const READY_RE = /dsh web: (https?:\/\/[^\s]+)/
const READY_POLL_MS = 350
/** server.log rotates once it exceeds this size; two generations are kept. */
const LOG_ROTATE_BYTES = 5 * 1024 * 1024
/** Harness engines: ^22.19.0 || >=24.0.0 (mirrors the checkout's engines). */
const MIN_NODE_MAJOR_MINOR = { 22: 19 }

/** Known locations probed when no harness path is configured, with provenance. */
function harnessCandidates() {
  const candidates = []
  // Bundled harness shipped inside the packaged app (extraResources).
  if (process.resourcesPath) {
    candidates.push({ path: path.join(process.resourcesPath, 'harness'), source: 'bundled' })
  }
  if (process.env.DSH_DESKTOP_HARNESS) {
    candidates.push({ path: process.env.DSH_DESKTOP_HARNESS, source: 'env' })
  }
  candidates.push({ path: path.join(os.homedir(), 'deepseek-harness'), source: 'detected' })
  return candidates
}

/** Relative CLI bin locations, in preference order: checkout layout, deploy layout. */
const RELATIVE_BINS = [path.join('apps', 'cli', 'lib', 'bin.js'), path.join('lib', 'bin.js')]

/**
 * Resolve a configured path against the app install directory. Relative
 * values (e.g. "resources\harness") keep working when the app — especially
 * the portable build — is moved to another directory.
 * @param {string} p - the configured path (absolute or relative).
 * @param {string} [installDir] - app install dir; relative values resolve
 *   against it. When absent, relative paths pass through unchanged.
 */
function resolveInstallRelative(p, installDir) {
  if (!p || path.isAbsolute(p)) return p
  return path.join(installDir || '', p)
}

/**
 * Resolve the CLI bin inside a harness root. Two layouts are supported:
 *  - checkout:  <root>/apps/cli/lib/bin.js
 *  - deploy:    <root>/lib/bin.js            (pnpm deploy of @deepseek-ai/dsh)
 * @returns the bin path, or null when neither layout is present.
 */
function resolveBin(root) {
  for (const rel of RELATIVE_BINS) {
    const bin = path.join(root, rel)
    if (fs.existsSync(bin)) return bin
  }
  return null
}

/** True when a directory looks like a built dsh harness checkout/deploy. */
function isHarness(root) {
  try {
    if (resolveBin(root) === null) return false
    // pnpm layouts vary: root node_modules (deploy), or per-package node_modules
    // (workspace checkout). The web-app bundle must be resolvable either way.
    return (
      fs.existsSync(path.join(root, 'node_modules', '@deepseek-ai', 'dsh-web-app')) ||
      fs.existsSync(path.join(root, 'apps', 'cli', 'node_modules', '@deepseek-ai', 'dsh-web-app'))
    )
  } catch {
    return false
  }
}

/**
 * Resolve the effective harness root plus its provenance.
 * @returns {{ root: string, source: 'setting'|'bundled'|'env'|'detected' } | null}
 */
function resolveHarnessRootWithSource(explicit) {
  if (explicit && isHarness(explicit)) return { root: explicit, source: 'setting' }
  for (const candidate of harnessCandidates()) {
    if (candidate.path && isHarness(candidate.path)) {
      return { root: candidate.path, source: candidate.source }
    }
  }
  return null
}

/** Candidate list exposed for the settings "detect" button. */
function detectHarnessRoots() {
  const found = []
  for (const candidate of harnessCandidates()) {
    if (candidate.path && isHarness(candidate.path) && !found.includes(candidate.path)) found.push(candidate.path)
  }
  if (found.length === 0) return null
  return found[0]
}

/** Parse `v22.19.0` into [22, 19, 0]; null when malformed. */
function parseNodeVersion(output) {
  const m = String(output).trim().match(/^v?(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** True when a version satisfies the harness engines (^22.19.0 || >=24.0.0). */
function satisfiesHarnessEngines(version) {
  if (!version) return false
  const [major, minor] = version
  if (major === 22) return minor >= (MIN_NODE_MAJOR_MINOR[22] ?? 0)
  return major >= 24
}

let cachedLaunch = null

/**
 * Resolve how to launch the dsh CLI.
 *
 * 1. `node` on PATH when it satisfies the harness engines (^22.19 || >=24).
 * 2. This Electron executable in ELECTRON_RUN_AS_NODE mode — a full Node
 *    runtime, so packaged apps work on machines without Node installed.
 * @returns {{ command: string, args: string[], env: object, nodeVersion: string|null }}
 */
function resolveNodeLaunch(spawnSyncImpl = spawnSync) {
  if (cachedLaunch) return cachedLaunch
  try {
    const probe = spawnSyncImpl('node', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    if (probe.status === 0 && probe.stdout !== null) {
      const version = parseNodeVersion(probe.stdout.toString())
      if (satisfiesHarnessEngines(version)) {
        cachedLaunch = { command: 'node', args: [], env: {}, nodeVersion: version }
        return cachedLaunch
      }
      console.error(`[dsh-desktop] system node ${version ? version.join('.') : '(unparsable)'} does not satisfy harness engines (^22.19 || >=24); using the bundled Electron runtime`)
    }
  } catch {
    /* fall through */
  }
  cachedLaunch = {
    command: process.execPath,
    // Under ELECTRON_RUN_AS_NODE the node-addon-require-builtin native module
    // cannot load (ABI mismatch with Electron's Node), so the harness's HMR
    // service falls back to internal-module access, which needs this flag.
    args: ['--expose-internals'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    nodeVersion: null,
  }
  return cachedLaunch
}

class ServerManager {
  /**
   * @param {object} deps
   * @param {import('./store').SettingsStore} deps.settings
   * @param {object} [deps.defaults] - effective defaults used when a stored
   *   setting is empty: { harnessPath, dshHome, port, installDir }.
   * @param {(state: object) => void} deps.onState
   * @param {(line: string) => void} deps.onLog
   * @param {string} deps.logFile - path of the server log file (appended).
   */
  constructor({ settings, defaults, onState, onLog, logFile, spawnImpl, spawnSyncImpl }) {
    this.settings = settings
    this.defaults = { harnessPath: '', dshHome: '', port: 0, installDir: '', ...(defaults ?? {}) }
    this.onState = onState
    this.onLog = onLog
    this.logFile = logFile
    this.spawnImpl = spawnImpl ?? spawn
    this.spawnSyncImpl = spawnSyncImpl ?? spawnSync
    this.child = null
    this.url = null
    this.phase = 'idle' // idle | starting | ready | error | stopping
    this.error = null
    this.stopping = false
    this.expectExit = false
    this.readyTimer = null
    this.crashTimer = null
    this.pollTimer = null
    this.logTail = []
    this.filePos = 0
  }

  get state() {
    return {
      phase: this.phase,
      url: this.url,
      error: this.error ? String(this.error) : null,
      harnessRoot: this.harnessRoot ?? null,
      harnessSource: this.harnessSource ?? null,
      logTail: this.logTail.slice(-40),
    }
  }

  setState(patch) {
    const { quiet, ...rest } = patch // quiet is a start() hint, never instance state
    Object.assign(this, rest)
    this.onState(this.state)
  }

  log(line) {
    this.logTail.push(String(line).replace(/\s+$/, ''))
    if (this.logTail.length > 400) this.logTail.splice(0, this.logTail.length - 400)
    this.onLog(line)
  }

  /**
   * Start (or restart) the server.
   * @param {object} [opts] - { quiet?: boolean } suppresses the "restarting" state blip.
   */
  start({ quiet = false } = {}) {
    this.stopChild()
    const explicit = resolveInstallRelative(
      this.settings.get('harnessPath') || this.defaults.harnessPath || '',
      this.defaults.installDir,
    )
    let resolved
    if (explicit) {
      // An explicitly configured path must win or fail loudly — silently
      // falling back to auto-detect would confuse users with a wrong setting.
      if (isHarness(explicit)) {
        resolved = { root: explicit, source: 'setting' }
      } else {
        this.error = `设置的 harness 路径无效（未找到 apps/cli/lib/bin.js）：${explicit}`
        this.setState({ phase: 'error', url: null, quiet })
        return
      }
    } else {
      resolved = resolveHarnessRootWithSource('')
    }
    this.harnessRoot = resolved ? resolved.root : null
    this.harnessSource = resolved ? resolved.source : null
    if (!this.harnessRoot) {
      this.error = '找不到 DeepSeek Harness（未检测到 apps/cli/lib/bin.js）。请在设置中指定 harness 路径。'
      this.setState({ phase: 'error', url: null, quiet })
      return
    }

    const bin = resolveBin(this.harnessRoot)
    if (!bin) {
      this.error = `harness CLI 不存在：${this.harnessRoot}`
      this.setState({ phase: 'error', url: null, quiet })
      return
    }

    const port = this.settings.get('port') || this.defaults.port || 0
    const args = [bin, 'web']
    // Always pass an explicit port: 0 = OS-assigned free port (no conflicts).
    args.push('--port', String(port > 0 ? port : 0))

    const home = this.settings.get('dshHome') || this.defaults.dshHome || ''
    const cwd = os.homedir()
    const env = { ...process.env }
    if (home) env.DSH_HOME = home
    env.DSH_DESKTOP = '1'
    // Fresh DSH_HOME + symlink-less Windows: pre-heal the profile fallback so
    // the child never needs the SeCreateSymbolicLinkPrivilege.
    this.preHealProfiles(home ?? path.join(os.homedir(), '.dsh'), this.harnessRoot)

    const launch = resolveNodeLaunch()
    this.log(`启动: ${launch.command} ${[...launch.args, ...args].join(' ')}  (cwd: ${cwd}${home ? `, DSH_HOME: ${home}` : ''})`)
    this.error = null
    this.url = null
    this.stopping = false
    this.expectExit = false
    this.setState({ phase: 'starting', quiet })

    // Rotate an oversized log before appending this boot's output.
    this.rotateLog()

    // Redirect the child's output to the log file via real file descriptors:
    // no pipes, so a long-lived child never wedges the parent, and the spawn
    // works in sandboxed environments that deny pipe-based stdio.
    let fdOut = null
    let fdErr = null
    let child
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true })
      fdOut = fs.openSync(this.logFile, 'a')
      fdErr = fs.openSync(this.logFile, 'a')
      child = this.spawnImpl(launch.command, [...launch.args, ...args], {
        cwd,
        env: { ...env, ...launch.env },
        windowsHide: true,
        stdio: ['ignore', fdOut, fdErr],
      })
    } catch (error) {
      if (fdOut !== null) {
        try { fs.closeSync(fdOut) } catch { /* already closed */ }
      }
      if (fdErr !== null && fdErr !== fdOut) {
        try { fs.closeSync(fdErr) } catch { /* already closed */ }
      }
      this.error = `无法启动服务器进程: ${error.message}`
      this.setState({ phase: 'error' })
      return
    }
    // Parent-side handles are only needed to pass into the child; close them.
    try { fs.closeSync(fdOut) } catch { /* already closed */ }
    if (fdErr !== fdOut) {
      try { fs.closeSync(fdErr) } catch { /* already closed */ }
    }
    this.child = child
    // Readiness detection starts AFTER the existing log content: historical
    // readiness lines from previous boots must never match a fresh start.
    this.filePos = this.currentLogSize()

    child.on('error', (error) => {
      // Identity guard: this child may already have been replaced by a restart;
      // a stale child's events must never touch the current state machine.
      if (this.child !== child) return
      this.log(`[server] spawn error: ${error.message}`)
      if (!this.stopping) {
        this.error = `启动失败: ${error.message}`
        this.setState({ phase: 'error' })
      }
    })

    child.on('exit', (code, signal) => {
      // Identity guard: after start() replaces the child, a stale child's
      // late exit must be ignored entirely — otherwise it clears the new
      // child reference, resets the URL, and forces the state machine into
      // error, permanently blocking ready.
      if (this.child !== child) return
      this.drainLog() // catch any final diagnostics the poller hasn't read yet
      this.log(`[server] exited code=${code} signal=${signal}`)
      this.child = null
      this.stopPolling()
      if (this.stopping) return
      if (this.expectExit) return // replaced by a fresh start()
      if (this.phase === 'ready') {
        this.url = null
        if (this.settings.get('autoRestart') && !this.crashTimer) {
          this.setState({ phase: 'starting' })
          this.log('[server] 意外退出，3 秒后自动重启…')
          this.crashTimer = setTimeout(() => {
            this.crashTimer = null
            this.start({ quiet: true })
          }, 3000)
        } else {
          this.error = `服务器意外退出 (code=${code})`
          this.setState({ phase: 'error' })
        }
      } else {
        this.error = this.error || `服务器退出 (code=${code})`
        this.setState({ phase: 'error' })
      }
    })

    // Readiness watchdog: a stuck boot should not leave a blank window forever.
    this.readyTimer = setTimeout(() => {
      if (this.phase === 'starting') {
        this.error = '服务器启动超时（90 秒未就绪）。请检查 harness 路径与 DSH_HOME。'
        this.setState({ phase: 'error' })
      }
    }, 90000)

    this.startPolling()
  }

  /** Current log file size (0 when absent). */
  currentLogSize() {
    try {
      return fs.statSync(this.logFile).size
    } catch {
      return 0
    }
  }

  /**
   * Pre-heal the profile module fallback with junctions. On first boot with a
   * fresh DSH_HOME, dsh's profile init tries to create *symlinks* under
   * $DSH_HOME/profiles/node_modules — which requires the Windows
   * SeCreateSymbolicLinkPrivilege (developer mode / admin) and fails with
   * EPERM for ordinary users. Junctions need no privilege; dsh's heal step
   * sees the pre-created links and keeps them.
   */
  preHealProfiles(home, harnessRoot) {
    try {
      const topAi = path.join(harnessRoot, 'node_modules', '@deepseek-ai')
      if (!fs.existsSync(topAi)) return
      const profilesNm = path.join(home, 'profiles', 'node_modules')
      fs.mkdirSync(path.join(profilesNm, '@deepseek-ai'), { recursive: true })
      for (const entry of fs.readdirSync(topAi)) {
        const target = path.join(topAi, entry)
        const dest = path.join(profilesNm, '@deepseek-ai', entry)
        try {
          const st = fs.lstatSync(dest)
          if (st.isSymbolicLink()) continue // already linked
          // A real directory would make dsh's own heal step throw; move it
          // aside so the junction can take its place.
          if (st.isDirectory()) {
            try {
              fs.renameSync(dest, `${dest}.dsh-bak`)
            } catch {
              continue // in use or not movable; leave it alone
            }
          }
        } catch {
          /* dest missing — proceed to create */
        }
        try {
          fs.symlinkSync(target, dest, 'junction')
        } catch {
          /* already linked or not a directory — heal will handle */
        }
      }
    } catch {
      /* best effort */
    }
  }

  /** Rotate server.log to server.log.1 once it exceeds the size cap. */
  rotateLog() {
    try {
      if (this.currentLogSize() < LOG_ROTATE_BYTES) return
      const one = `${this.logFile}.1`
      const two = `${this.logFile}.2`
      try { fs.rmSync(two, { force: true }) } catch { /* ok */ }
      try { fs.renameSync(one, two) } catch { /* first rotation */ }
      fs.renameSync(this.logFile, one)
      this.log(`[server] log rotated (>${Math.round(LOG_ROTATE_BYTES / 1024 / 1024)}MB)`)
    } catch {
      /* rotation is best-effort */
    }
  }

  /** Poll the log file tail for the readiness line and forward new lines. */
  startPolling() {
    this.pollTimer = setInterval(() => {
      let stat
      try {
        stat = fs.statSync(this.logFile)
      } catch {
        return
      }
      if (stat.size <= this.filePos) {
        if (stat.size < this.filePos) this.filePos = 0 // truncated
        return
      }
      let chunk
      try {
        const fd = fs.openSync(this.logFile, 'r')
        try {
          const length = Math.min(stat.size - this.filePos, 65536)
          const buf = Buffer.alloc(length)
          fs.readSync(fd, buf, 0, length, this.filePos)
          chunk = buf.toString('utf8')
        } finally {
          fs.closeSync(fd)
        }
      } catch {
        return
      }
      this.filePos += chunk.length
      if (chunk.length === 0) return
      this.log(chunk)
      // Readiness matches only while booting; after ready the poller keeps
      // forwarding new log lines to the settings window.
      const match = chunk.match(READY_RE)
      if (match && this.phase === 'starting') {
        this.url = match[1]
        this.setState({ phase: 'ready' })
      }
    }, READY_POLL_MS)
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  /** Synchronously drain any unread log-file bytes (crash diagnostics). */
  drainLog() {
    try {
      const stat = fs.statSync(this.logFile)
      if (stat.size <= this.filePos) return
      const fd = fs.openSync(this.logFile, 'r')
      try {
        const buf = Buffer.alloc(stat.size - this.filePos)
        fs.readSync(fd, buf, 0, buf.length, this.filePos)
        this.filePos += buf.length
        this.log(buf.toString('utf8'))
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      /* log file unavailable */
    }
  }

  /** Stop the child and all of its descendants, reliably on Windows. */
  stopChild() {
    const child = this.child
    this.child = null
    this.expectExit = true
    this.stopPolling()
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    if (this.crashTimer) {
      clearTimeout(this.crashTimer)
      this.crashTimer = null
    }
    if (!child || child.pid === undefined) return
    // Synchronous process-tree kill: by the time stopChild returns, the tree
    // is gone — restart and app-quit cleanup can no longer race with a
    // half-dead child.
    try {
      this.spawnSyncImpl('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 10000,
      })
    } catch {
      /* best effort */
    }
    try {
      if (!child.killed) child.kill()
    } catch {
      /* already gone */
    }
  }

  /** User-requested stop: no auto-restart, terminal 'stopped' state. */
  stop() {
    this.stopping = true
    this.stopChild()
    this.url = null
    this.setState({ phase: 'idle' })
  }

  /** Kill any child synchronously at app quit (best effort). */
  dispose() {
    this.stopping = true
    this.stopChild()
  }
}

/** Test hook: reset the cached node-launch decision. */
function resetNodeLaunchCache() {
  cachedLaunch = null
}

module.exports = {
  ServerManager,
  resolveHarnessRootWithSource,
  detectHarnessRoots,
  isHarness,
  parseNodeVersion,
  satisfiesHarnessEngines,
  resolveNodeLaunch,
  resolveInstallRelative,
  resetNodeLaunchCache,
}