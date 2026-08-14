'use strict'

/**
 * dsh-desktop — Electron main process.
 *
 * Responsibilities:
 *  - single-instance lock
 *  - settings store (userData/config.json)
 *  - ServerManager: spawn `dsh web`, readiness, crash handling, process-tree kill
 *  - main window: the settings page (status strip + settings form + kernel update)
 *  - GUI window: hosts the dsh web GUI once the server is ready
 *  - `--smoke` mode for automated verification: load the GUI, print SMOKE_OK, exit
 */

const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, shell, nativeImage } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const readline = require('node:readline')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { SettingsStore } = require('./store')
const { ServerManager, detectHarnessRoots, isHarness, resolveInstallRelative } = require('./server')
const { compareVersions, fetchOfficialHarnessVersion } = require('./harness-update')

// Auto-update is opt-in: set DSH_DESKTOP_UPDATE_URL to a generic feed URL
// (e.g. https://example.com/releases/) to enable update checks in packaged
// builds. Without it the app never touches the network for updates.
const UPDATE_URL = process.env.DSH_DESKTOP_UPDATE_URL || ''
let autoUpdater = null
let updateReady = false
let installingUpdate = false

/** Default listen port: 0 lets the OS assign a free port (never conflicts). */
const DEFAULT_PORT = 0

/**
 * The app's install directory: where the executable lives (packaged), or the
 * project root (dev).
 */
function installDir() {
  return app.isPackaged ? path.dirname(process.execPath) : app.getAppPath()
}

/**
 * Default harness location, RELATIVE to the install directory:
 * <安装目录>\resources\harness (the bundled kernel). Keeping the default
 * relative means the app — especially the portable build — keeps working
 * after being moved to another directory.
 */
function defaultHarnessPath() {
  return app.isPackaged ? path.join('resources', 'harness') : 'harness-deploy'
}

/** Resolve a (possibly relative) harness path against the install directory. */
function resolveHarnessPath(p) {
  return resolveInstallRelative(p, installDir())
}

/** Effective settings: stored value, falling back to the product defaults. */
function effectiveSettings() {
  return {
    harnessPath: settingsStore.get('harnessPath') || defaultHarnessPath(),
    dshHome: settingsStore.get('dshHome') || path.join(os.homedir(), '.dsh'),
    port: settingsStore.get('port') || DEFAULT_PORT,
    autoRestart: settingsStore.get('autoRestart') !== false,
  }
}

const SMOKE = process.argv.includes('--smoke')

// Startup diagnostics (stderr so they survive any stdout capture).
const diag = (...args) => console.error('[dsh-desktop]', ...args)
process.on('uncaughtException', (error) => diag('uncaughtException', error))
process.on('unhandledRejection', (error) => diag('unhandledRejection', error))

// Sandboxed/dev override: keep all app data inside a chosen directory
// (otherwise Electron uses %APPDATA%/<AppName>).
if (process.env.DSH_DESKTOP_USERDATA) {
  app.setPath('userData', process.env.DSH_DESKTOP_USERDATA)
}

let settingsStore
let server
let mainWindow = null
let tray = null
let isQuitting = false
/** True while the single window is showing the settings page. */
let settingsActive = false

// ── single instance ──────────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // showMainWindow recreates the window when it was closed (tray mode).
    showMainWindow()
  })
}

// ── helpers ──────────────────────────────────────────────────────────────────

function sendToWindow(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function broadcastState() {
  const state = server.state
  sendToWindow(mainWindow, 'dsh:state', state)
}

/**
 * Navigation whitelist: only the loopback HTTP(S) origins the app itself
 * serves. Exact hostname match — `startsWith("http://localhost")` would let
 * through hosts like `localhost.evil.com`.
 */
function isAllowedLocalUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
  )
}

/**
 * The ONE window: it hosts the dsh Web GUI (the main interface) and can be
 * switched to the settings page in place. The preload bridge is exposed by
 * preload.js only on the file:// settings page — the http:// GUI never gets
 * the control API (least privilege).
 */
function createMainWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'DeepSeek Harness Desktop',
    backgroundColor: '#f9fafb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.on('ready-to-show', () => {
    win.show()
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  // Clicking ✕ hides the window to the tray — the app keeps running (tray
  // resident). Only an explicit quit (tray/menu 退出) actually exits, which
  // sets isQuitting so this handler lets the window close.
  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    win.hide()
  })
  // External links open in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isAllowedLocalUrl(url)) return
    // The settings page is the only file:// page this window may show.
    if (url.startsWith('file://') && url.includes('/settings/index.html')) return
    event.preventDefault()
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url)
  })
  return win
}

/** Show (or recreate) the main window. */
function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return
  }
  mainWindow = createMainWindow()
  const { phase, url } = server.state
  if (phase === 'ready' && url) mainWindow.loadURL(url)
  else mainWindow.show() // blank until ready; onState will navigate it
}

/** The settings URL (file:// page inside the app bundle). */
function settingsUrl() {
  return path.join(__dirname, 'settings', 'index.html')
}

/** Switch the single window to the settings page. */
function navigateToSettings() {
  settingsActive = true
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow()
  if (!mainWindow.webContents.getURL().includes('settings/index.html')) {
    mainWindow.loadFile(settingsUrl())
  }
  mainWindow.show()
  mainWindow.focus()
}

/** Open settings (menu / tray / auto on server error). */
function openSettings() {
  navigateToSettings()
}

/** Switch back to the main interface (the Web GUI). */
function backToGui() {
  settingsActive = false
  const { phase, url } = server.state
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (phase === 'ready' && url) {
    if (mainWindow.webContents.getURL() !== url) mainWindow.loadURL(url)
    mainWindow.show()
  } else {
    mainWindow.show()
  }
}

/** Keep the single window in step with the server. */
function syncMainWindow() {
  const { phase, url } = server.state
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (phase === 'ready' && url) {
    if (!settingsActive) {
      // User is on the main interface (or still starting up): navigate there.
      if (mainWindow.webContents.getURL() !== url) mainWindow.loadURL(url)
      mainWindow.show()
    }
  } else if (phase === 'error') {
    // The GUI cannot load — switch to the settings page so the user can fix it.
    navigateToSettings()
  }
  // idle/starting: leave the window as-is.
}

function buildMenu() {
  const viewSubmenu = [
    { label: '重新加载', role: 'reload' },
    { label: '实际大小', role: 'resetZoom' },
    { label: '放大', role: 'zoomIn' },
    { label: '缩小', role: 'zoomOut' },
  ]
  if (!app.isPackaged) {
    viewSubmenu.unshift({ label: '开发者工具', role: 'toggleDevTools' })
    viewSubmenu.unshift({ type: 'separator' })
  }
  const helpSubmenu = [
    {
      label: 'DeepSeek Harness 官方仓库',
      click: () => shell.openExternal('https://github.com/deepseek-ai/deepseek-harness'),
    },
    {
      label: '本项目仓库',
      click: () => shell.openExternal('https://github.com/zfx2012/deepseek_harness_desktop'),
    },
    { label: '关于', role: 'about' },
  ]
  if (UPDATE_URL && app.isPackaged) {
    helpSubmenu.unshift({ label: '检查更新…', click: checkForUpdates })
  }
  const template = [
    {
      // Settings live in an on-demand window; the main window is the Web GUI.
      label: '设置',
      submenu: [
        { label: '打开设置', accelerator: 'CmdOrCtrl+,', click: () => openSettings() },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: '服务器',
      submenu: [
        // The main window IS the GUI — it loads automatically on ready.
        { label: '重启服务器', accelerator: 'CmdOrCtrl+R', click: () => restartServer() },
        { label: '停止服务器', click: () => server.stop() },
        { type: 'separator' },
        {
          label: '打开服务器日志文件',
          click: () => {
            const logFile = path.join(app.getPath('userData'), 'server.log')
            // Open directly in Notepad (detached so it outlives the app).
            try {
              const child = spawn('notepad.exe', [logFile], { detached: true, stdio: 'ignore', windowsHide: false })
              child.unref()
            } catch (error) {
              shell.showItemInFolder(logFile) // fallback: reveal the file
            }
          },
        },
      ],
    },
    {
      label: '视图',
      submenu: viewSubmenu,
    },
    {
      label: '帮助',
      submenu: helpSubmenu,
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Initialize the (optional) auto-updater against the generic feed. */
function initAutoUpdater() {
  if (!UPDATE_URL || !app.isPackaged || autoUpdater) return
  try {
    // Lazy require: electron-updater is only loaded when updates are enabled.
    const { autoUpdater: updater } = require('electron-updater')
    autoUpdater = updater
    updater.autoDownload = false
    updater.setFeedURL({ provider: 'generic', url: UPDATE_URL })
    // Silent background check; failures are logged, never surfaced.
    updater.checkForUpdates().catch((error) => diag('update check failed:', error.message))
    updater.on('error', (error) => diag('autoUpdater error:', error.message))
  } catch (error) {
    diag('autoUpdater init failed:', error.message)
  }
}

/** Manual "check for updates" with dialog feedback. */
async function checkForUpdates() {
  if (!autoUpdater) {
    dialog.showMessageBox({ type: 'info', message: '未配置更新源（DSH_DESKTOP_UPDATE_URL）。' })
    return
  }
  try {
    const result = await autoUpdater.checkForUpdates()
    const version = result?.updateInfo?.version
    if (!version || version === app.getVersion()) {
      dialog.showMessageBox({ type: 'info', message: `已是最新版本（${app.getVersion()}）。` })
      return
    }
    const choice = await dialog.showMessageBox({
      type: 'question',
      buttons: ['下载并安装', '稍后'],
      defaultId: 0,
      message: `发现新版本 ${version}（当前 ${app.getVersion()}），是否下载并安装？`,
    })
    if (choice.response !== 0) return
    await autoUpdater.downloadUpdate()
    updateReady = true
    const installChoice = await dialog.showMessageBox({
      type: 'question',
      buttons: ['立即重启并安装', '退出时安装'],
      defaultId: 0,
      message: '更新已下载完成。',
    })
    if (installChoice.response === 0) {
      installingUpdate = true
      autoUpdater.quitAndInstall()
    }
  } catch (error) {
    dialog.showMessageBox({ type: 'error', message: `检查更新失败：${error.message}` })
  }
}

function createTray() {
  // .ico renders reliably in the Windows notification area (multi-size);
  // fall back to the PNG when the ICO is missing.
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.ico')
  let icon
  try {
    icon = nativeImage.createFromPath(iconPath)
    if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png'))
    if (icon.isEmpty()) icon = nativeImage.createEmpty()
  } catch {
    icon = nativeImage.createEmpty()
  }
  tray = new Tray(icon)
  tray.setToolTip('DeepSeek Harness Desktop')
  const menu = Menu.buildFromTemplate([
    { label: '显示主界面', click: () => showMainWindow() },
    { label: '设置…', click: () => openSettings() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ])
  tray.setContextMenu(menu)
  tray.on('double-click', showMainWindow)
}

function restartServer() {
  server.start({ quiet: true })
}

// ── app lifecycle ────────────────────────────────────────────────────────────

app.setName('DeepSeek Harness Desktop')

app.whenReady().then(() => {
  diag('whenReady, electron', process.versions.electron, 'chrome', process.versions.chrome)
  settingsStore = new SettingsStore(app.getPath('userData'))
  server = new ServerManager({
    settings: settingsStore,
    defaults: {
      harnessPath: defaultHarnessPath(),
      dshHome: path.join(os.homedir(), '.dsh'),
      port: DEFAULT_PORT,
      installDir: installDir(),
    },
    logFile: path.join(app.getPath('userData'), 'server.log'),
    onState: () => {
      broadcastState()
      syncMainWindow()
    },
    onLog: (line) => {
      sendToWindow(mainWindow, 'dsh:log', String(line))
    },
  })

  // Main window: the Web GUI (opens straight into it once the server is up).
  mainWindow = createMainWindow()

  buildMenu()
  createTray()

  registerIpc()
  initAutoUpdater()

  if (SMOKE_UPDATE) {
    // Update-feed verification is standalone: no window, no server child.
    runSmokeUpdate()
    return
  }

  diag('calling server.start()')
  server.start()
  diag('server.start() returned, state=', JSON.stringify(server.state))

  if (SMOKE || SMOKE_BUNDLED || SMOKE_ERROR) {
    runSmoke()
  }
})

// Tray-resident app: clicking ✕ hides the window (the close handler in
// createMainWindow preventDefaults it), so window-all-closed never fires for a
// hidden window. Quitting is explicit — tray/menu 退出 — and disposes the
// server child (process-tree kill), so a quit app never blocks reinstall.
app.on('before-quit', () => {
  isQuitting = true
  if (server) server.dispose()
  // A downloaded update installs on quit: hand over to electron-updater
  // once, guarded so quitAndInstall's own re-quit is a no-op.
  if (updateReady && !installingUpdate && autoUpdater) {
    installingUpdate = true
    autoUpdater.quitAndInstall()
  }
})

/** Read the bundled-harness manifest (provenance) from the known locations. */
function readBundleManifest() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'harness', 'manifest.json') : null,
    path.join(__dirname, '..', 'harness-deploy', 'manifest.json'),
  ]
  for (const file of candidates) {
    if (!file) continue
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      /* not present or unreadable */
    }
  }
  return null
}

/**
 * Version of the harness at a root: checkout layout (apps/cli/package.json)
 * first, then deploy layout (package.json at the root).
 */
function readHarnessRootVersion(root) {
  if (!root) return null
  for (const rel of [path.join('apps', 'cli', 'package.json'), 'package.json']) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))
      if (typeof pkg.version === 'string' && pkg.version) return pkg.version
    } catch {
      /* keep probing */
    }
  }
  return null
}

/** True when a probe file can be created and removed inside the directory. */
function isWritableDir(dir) {
  try {
    const probe = path.join(dir, `.dsh-write-probe-${process.pid}`)
    fs.writeFileSync(probe, '')
    fs.rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Run the kernel update in a CHILD process so the long npm install and the
 * ~250MB file merges never freeze the UI. The runner reports progress on
 * stdout (`[update] …`) and a final `[result]`/`[error]` line.
 * @returns {Promise<{ ok: boolean, result?: object, error?: string }>}
 */
function runHarnessUpdateInChild(version, target, fresh, onProgress) {
  return new Promise((resolve) => {
    const runner = path.join(__dirname, '..', 'scripts', 'harness-update-runner.js')
    const args = [runner, '--version', String(version), '--target', target]
    if (fresh) args.push('--fresh')
    let child
    try {
      // System Node when available, else this Electron binary as a Node runtime.
      const probe = spawnSync('node', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
      child = probe.status === 0
        ? spawn('node', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        : spawn(process.execPath, args, {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          })
    } catch (error) {
      resolve({ ok: false, error: error.message })
      return
    }
    let settled = false
    const settle = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      if (line.startsWith('[update] ')) {
        onProgress(line.slice('[update] '.length))
      } else if (line.startsWith('[result] ')) {
        try {
          settle({ ok: true, result: JSON.parse(line.slice('[result] '.length)) })
        } catch {
          settle({ ok: false, error: `无法解析更新结果：${line}` })
        }
      } else if (line.startsWith('[error] ')) {
        settle({ ok: false, error: line.slice('[error] '.length) })
      }
    })
    child.on('error', (error) => settle({ ok: false, error: error.message }))
    child.on('exit', (code) => {
      if (!settled) settle({ ok: false, error: `更新进程异常退出（exit ${code}）` })
    })
    // The runner itself caps npm at 15 minutes; allow generous headroom here.
    const timer = setTimeout(() => {
      if (settled) return
      try { child.kill() } catch { /* already gone */ }
      settle({ ok: false, error: '内核更新超时（超过 20 分钟），已中止。' })
    }, 20 * 60 * 1000)
  })
}

// ── IPC ──────────────────────────────────────────────────────────────────────

function registerIpc() {
  ipcMain.handle('dsh:get-state', () => server.state)
  ipcMain.handle('dsh:get-bundle-info', () => {
    const manifest = readBundleManifest()
    return {
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      harnessVersion: manifest ? manifest.harnessVersion : null,
      builtAt: manifest ? manifest.builtAt : null,
      packageCount: manifest ? manifest.packageCount : null,
      // Note: the manifest's harnessCheckout is a build-machine path and is
      // intentionally NOT exposed here.
    }
  })
  // Kernel (harness) update check against the official repository. The check
  // URL is hardcoded in harness-update.js and never shown in the UI.
  ipcMain.handle('dsh:check-harness-update', async () => {
    const manifest = readBundleManifest()
    const root = server.state.harnessRoot || resolveHarnessPath(effectiveSettings().harnessPath)
    const current = readHarnessRootVersion(root) || (manifest ? manifest.harnessVersion : null)
    try {
      const { latest, repoUrl } = await fetchOfficialHarnessVersion()
      const hasUpdate = current !== null && compareVersions(latest, current) > 0
      return { ok: true, current, latest, hasUpdate, repoUrl }
    } catch (error) {
      return { ok: false, current, latest: null, hasUpdate: false, error: error.message }
    }
  })
  // Direct kernel update: install the published version into the harness the
  // app actually runs (deploy layout only — source checkouts are untouched).
  // Per-machine installs under C:\Program Files are read-only for normal
  // users, so an unwritable target transparently falls back to a writable
  // per-user copy under userData; the setting is then persisted so future
  // updates keep hitting that copy.
  ipcMain.handle('dsh:update-harness', async (_event, version) => {
    // Validate the version BEFORE stopping the server — an invalid value must
    // not cost a needless stop/start round-trip.
    const ver = String(version ?? '').trim()
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(ver)) {
      return { ok: false, error: `无效的版本号: ${ver}` }
    }
    const effective = effectiveSettings()
    const targetPath = resolveHarnessPath(effective.harnessPath)
    const target =
      server.state.harnessRoot || (targetPath && isHarness(targetPath) ? targetPath : null)
    if (!target) {
      return { ok: false, error: '未找到可更新的 harness 目录。' }
    }
    if (fs.existsSync(path.join(target, 'apps', 'cli', 'lib', 'bin.js'))) {
      return { ok: false, error: '当前 harness 是源码 checkout，无法直接更新；请改指向内置内核目录（安装目录\\resources\\harness）。' }
    }
    const writable = isWritableDir(target)
    let installTarget = target
    let fresh = false
    let switched = false
    if (!writable) {
      installTarget = path.join(app.getPath('userData'), 'harness-current')
      fresh = !fs.existsSync(path.join(installTarget, 'lib', 'bin.js'))
      switched = true
    }
    server.stop() // native modules lock files on Windows while the server runs
    try {
      const outcome = await runHarnessUpdateInChild(ver, installTarget, fresh, (text) => {
        sendToWindow(mainWindow, 'dsh:update-progress', String(text))
      })
      if (!outcome.ok) throw new Error(outcome.error || '更新失败（未知错误）')
      const result = outcome.result
      if (switched) {
        // Persist the per-user copy so the next boot (and next update) uses it.
        settingsStore.set({ harnessPath: installTarget })
      }
      // Update done: return to the main interface once the server is ready.
      settingsActive = false
      server.start({ quiet: true })
      return { ok: true, version: result.version, packageCount: result.packageCount, harnessPath: installTarget, switched }
    } catch (error) {
      // Resume with the old kernel; stay on the settings page to show the error.
      server.start({ quiet: true })
      return { ok: false, error: error.message }
    }
  })
  ipcMain.handle('dsh:get-settings', () => effectiveSettings())
  ipcMain.handle('dsh:set-settings', (_event, partial) => {
    // Re-validate in the main process too — the renderer may be compromised.
    const clean = { ...(partial ?? {}) }
    if (clean.port !== undefined) {
      const port = Number(clean.port)
      if (!Number.isInteger(port) || port < 0 || port > 65535) delete clean.port
    }
    const changed = settingsStore.set(clean)
    if (changed) {
      // Apply immediately: settings affect the running server.
      // The user finished configuring — switch back once the server is ready.
      settingsActive = false
      server.start({ quiet: true })
      broadcastState()
    }
    return changed
  })
  ipcMain.handle('dsh:pick-directory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
  ipcMain.handle('dsh:detect-harness', () => detectHarnessRoots())
  ipcMain.handle('dsh:restart-server', () => {
    restartServer()
    return true
  })
  ipcMain.handle('dsh:back-to-gui', () => {
    backToGui()
    return true
  })
  ipcMain.handle('dsh:open-external', (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url)
    return true
  })
}

// ── smoke verification (--smoke / --smoke-bundled / --smoke-error / --smoke-update) ─

const SMOKE_BUNDLED = process.argv.includes('--smoke-bundled')
const SMOKE_ERROR = process.argv.includes('--smoke-error')
const SMOKE_UPDATE = process.argv.includes('--smoke-update')

/** Update-feed verification: expect DSH_DESKTOP_UPDATE_URL to offer DSH_DESKTOP_EXPECT_VERSION. */
async function runSmokeUpdate() {
  const url = process.env.DSH_DESKTOP_UPDATE_URL
  const expected = process.env.DSH_DESKTOP_EXPECT_VERSION
  if (!url) {
    console.log('SMOKE_UPDATE_FAIL DSH_DESKTOP_UPDATE_URL is not set')
    app.exit(1)
    return
  }
  try {
    const { autoUpdater } = require('electron-updater')
    autoUpdater.autoDownload = false
    autoUpdater.setFeedURL({ provider: 'generic', url })
    const result = await autoUpdater.checkForUpdates()
    const version = result?.updateInfo?.version
    if (expected && version !== expected) {
      console.log(`SMOKE_UPDATE_FAIL version=${version} expected=${expected}`)
      app.exit(1)
      return
    }
    console.log(`SMOKE_UPDATE_OK version=${version}`)
    app.exit(0)
  } catch (error) {
    console.log(`SMOKE_UPDATE_FAIL ${error.message}`)
    app.exit(1)
  }
}

function runSmoke() {
  const finish = (ok, message) => {
    clearTimeout(timer)
    clearInterval(interval)
    console.log(message)
    // app.exit() skips before-quit; dispose the server child explicitly.
    server.dispose()
    app.exit(ok ? 0 : 1)
  }
  const timer = setTimeout(() => finish(false, 'SMOKE_FAIL timeout'), 90000)
  const interval = setInterval(check, 500)

  async function check() {
    const state = server.state
    if (SMOKE_ERROR) {
      // Error-path verification: the server error switches the single window
      // to the settings page, which must render the error strip with buttons.
      if (state.phase !== 'error') return
      if (!mainWindow || mainWindow.isDestroyed()) return
      if (!mainWindow.webContents.getURL().includes('settings/index.html')) return
      try {
        const dom = await mainWindow.webContents.executeJavaScript(`(() => {
          const error = document.getElementById('server-error')
          return {
            hasBridge: typeof window.dsh === 'object' && window.dsh !== null,
            errVisible: !!error && !error.classList.contains('hidden'),
            errText: (document.getElementById('server-error') || {}).textContent || '',
            retryExists: !!document.getElementById('retry'),
            saveExists: !!document.getElementById('save'),
            backExists: !!document.getElementById('backToGui'),
          }
        })()`)
        const ok =
          dom.hasBridge && dom.errVisible && dom.errText.length > 0 && dom.retryExists && dom.saveExists && dom.backExists
        finish(ok, ok
          ? `SMOKE_ERROR_OK phase=${state.phase} errText=${JSON.stringify(dom.errText)}`
          : `SMOKE_FAIL error page broken: ${JSON.stringify(dom)}`)
      } catch (error) {
        finish(false, `SMOKE_FAIL executeJavaScript: ${error.message}`)
      }
      return
    }
    if (state.phase === 'error') {
      finish(false, `SMOKE_FAIL server error: ${state.error}\n--- server log ---\n${state.logTail.join('\n')}`)
      return
    }
    if (state.phase !== 'ready') return
    // Provenance assertion: --smoke-bundled must run from the bundled harness
    // (the default setting points at <install>/resources/harness, so the
    // source may be 'setting' rather than 'bundled' — the root must match).
    if (SMOKE_BUNDLED) {
      const expected = path.join(process.resourcesPath, 'harness')
      if (state.harnessRoot !== expected) {
        finish(false, `SMOKE_FAIL harnessRoot=${state.harnessRoot} (expected ${expected})`)
        return
      }
    }
    // The MAIN window is the GUI now — it navigates automatically on ready.
    const wc = mainWindow.webContents
    if (!wc.isLoading() && wc.getURL().startsWith(state.url)) {
      finish(true, `SMOKE_OK ${state.url} harnessSource=${state.harnessSource}`)
    }
  }
  mainWindow.webContents.on('did-finish-load', check)
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    if (code === -3) return
    finish(false, `SMOKE_FAIL did-fail-load ${code} ${desc}`)
  })
}
