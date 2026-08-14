'use strict'

// Settings page (also the app's main window): server status strip, settings
// form, and kernel (harness) update controls.

const $ = (id) => document.getElementById(id)

const els = {
  harnessPath: $('harnessPath'),
  dshHome: $('dshHome'),
  port: $('port'),
  autoRestart: $('autoRestart'),
  status: $('status'),
  log: $('log'),
}

// server status strip
const serverDot = $('server-dot')
const serverPhase = $('server-phase')
const serverUrl = $('server-url')
const serverError = $('server-error')
const openGuiBtn = $('openGui')
const retryBtn = $('retry')

const PHASE_TEXT = {
  idle: '服务器已停止',
  starting: '正在启动服务器…',
  ready: '服务器运行中',
  error: '服务器启动失败',
  stopping: '正在停止…',
}

function renderState(state) {
  const phase = state.phase || 'idle'
  serverDot.className = `dot ${phase === 'ready' ? 'ready' : phase === 'starting' || phase === 'stopping' ? 'starting' : phase === 'error' ? 'error' : 'idle'}`
  serverPhase.textContent = PHASE_TEXT[phase] || phase
  const isError = phase === 'error'
  serverError.classList.toggle('hidden', !isError)
  serverError.textContent = isError ? (state.error || '未知错误') : ''
  const isReady = phase === 'ready'
  serverUrl.classList.toggle('hidden', !isReady)
  serverUrl.textContent = isReady ? `GUI 地址：${state.url}` : ''
  openGuiBtn.classList.toggle('hidden', !isReady)
  retryBtn.classList.toggle('hidden', !isError)
}

function setStatus(text, kind) {
  els.status.textContent = text
  els.status.className = kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : ''
}

function readForm() {
  return {
    harnessPath: els.harnessPath.value.trim(),
    dshHome: els.dshHome.value.trim(),
    port: Number.parseInt(els.port.value, 10) || 0,
    autoRestart: els.autoRestart.checked,
  }
}

async function load() {
  const s = await window.dsh.getSettings()
  els.harnessPath.value = s.harnessPath || ''
  els.dshHome.value = s.dshHome || ''
  els.port.value = String(s.port || 0)
  els.autoRestart.checked = !!s.autoRestart
}

async function save() {
  const port = Number.parseInt(els.port.value, 10)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    setStatus('端口必须是 0–65535 之间的整数（0 = 自动分配空闲端口）。', 'err')
    els.port.focus()
    return
  }
  const changed = await window.dsh.setSettings(readForm())
  setStatus(changed ? '已保存，服务器已重启。' : '设置未变化。', 'ok')
}

$('save').addEventListener('click', save)

$('reset').addEventListener('click', async () => {
  await window.dsh.setSettings({
    harnessPath: '',
    dshHome: '',
    port: 0,
    autoRestart: true,
  })
  await load()
  setStatus('已恢复默认设置，服务器已重启。', 'ok')
})

async function pickInto(inputId, label) {
  const dir = await window.dsh.pickDirectory()
  if (dir) {
    $(inputId).value = dir
    setStatus(`${label}：${dir}`, 'ok')
  }
}

$('browseHarness').addEventListener('click', () => pickInto('harnessPath', '已选择 harness 路径'))
$('browseHome').addEventListener('click', () => pickInto('dshHome', '已选择 DSH_HOME'))

$('detectHarness').addEventListener('click', async () => {
  const found = await window.dsh.detectHarness()
  if (found) {
    els.harnessPath.value = found
    setStatus(`已检测到：${found}`, 'ok')
  } else {
    setStatus('未在常见位置检测到 harness，请手动浏览选择。', 'err')
  }
})

openGuiBtn.addEventListener('click', () => window.dsh.openGui())
retryBtn.addEventListener('click', () => window.dsh.restartServer())

window.dsh.getState().then(renderState)
window.dsh.onState(renderState)

window.dsh.onLog((line) => {
  els.log.textContent += line
  const el = els.log
  el.scrollTop = el.scrollHeight
  if (el.textContent.length > 20000) {
    el.textContent = el.textContent.slice(-15000)
  }
})

// Provenance block: desktop version, runtimes, and the bundled harness version.
async function renderAbout(info) {
  const lines = [
    `桌面端版本：${info.appVersion}`,
    `Electron ${info.electron} / Chromium ${info.chrome} / Node ${info.node}`,
    info.harnessVersion
      ? `内置 Harness：${info.harnessVersion}（${info.packageCount ?? '?'} 包，构建于 ${(info.builtAt || '').slice(0, 19).replace('T', ' ')}）`
      : '内置 Harness：未捆绑（将使用外部 checkout 或检测路径）',
  ]
  document.getElementById('about').textContent = lines.join('\n')
}
window.dsh.getBundleInfo().then(renderAbout)

// Kernel update check + direct update against the official harness repository
// (the URL is hardcoded in the main process and never shown here).
const updateStatus = document.getElementById('updateStatus')
const checkUpdateBtn = document.getElementById('checkUpdate')
const updateNowBtn = document.getElementById('updateNow')
const openOfficial = document.getElementById('openOfficial')
let pendingVersion = null
let officialRepoUrl = null

document.getElementById('checkUpdate').addEventListener('click', async () => {
  updateStatus.textContent = '正在检测内核更新…'
  updateStatus.className = 'ok'
  updateNowBtn.classList.add('hidden')
  openOfficial.classList.add('hidden')
  pendingVersion = null
  const result = await window.dsh.checkHarnessUpdate()
  if (!result.ok) {
    updateStatus.textContent = `检测失败：${result.error || '网络错误'}`
    updateStatus.className = 'err'
    return
  }
  if (result.hasUpdate) {
    updateStatus.textContent = `发现新版本：${result.latest}（当前 ${result.current}）。可直接点击「立即更新」。`
    updateStatus.className = 'ok'
    pendingVersion = result.latest
    updateNowBtn.textContent = `立即更新到 ${result.latest}`
    updateNowBtn.classList.remove('hidden')
    officialRepoUrl = result.repoUrl
    openOfficial.classList.remove('hidden')
  } else {
    updateStatus.textContent = `内核已是最新（${result.current || result.latest}）。`
    updateStatus.className = 'ok'
  }
})

updateNowBtn.addEventListener('click', async () => {
  if (!pendingVersion) return
  if (!window.confirm(`将把内核更新到 ${pendingVersion}（下载并安装需要几分钟），确定继续？`)) return
  updateStatus.textContent = '正在下载并安装内核更新…（请勿关闭应用）'
  updateStatus.className = 'ok'
  updateNowBtn.disabled = true
  checkUpdateBtn.disabled = true
  try {
    const result = await window.dsh.updateHarness(pendingVersion)
    if (result.ok) {
      updateStatus.textContent = result.switched
        ? `内核已更新到 ${result.version}。安装目录无写权限，已切换到用户副本并保存为新内核路径：${result.harnessPath}`
        : `内核已更新到 ${result.version}，服务器已用新内核重启。`
      updateStatus.className = 'ok'
      pendingVersion = null
      updateNowBtn.classList.add('hidden')
      openOfficial.classList.add('hidden')
      const info = await window.dsh.getBundleInfo()
      renderAbout(info)
    } else {
      updateStatus.textContent = `更新失败：${result.error}`
      updateStatus.className = 'err'
    }
  } catch (error) {
    updateStatus.textContent = `更新失败：${error.message}`
    updateStatus.className = 'err'
  } finally {
    updateNowBtn.disabled = false
    checkUpdateBtn.disabled = false
  }
})

openOfficial.addEventListener('click', () => {
  if (officialRepoUrl) window.dsh.openExternal(officialRepoUrl)
})

// Live progress from the child-process kernel update.
window.dsh.onUpdateProgress((text) => {
  updateStatus.textContent = text
  updateStatus.className = 'ok'
})

load()
