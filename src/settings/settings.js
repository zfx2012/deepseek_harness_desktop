'use strict'

// Settings window logic.

const $ = (id) => document.getElementById(id)

const els = {
  harnessPath: $('harnessPath'),
  dshHome: $('dshHome'),
  port: $('port'),
  workspace: $('workspace'),
  autoRestart: $('autoRestart'),
  status: $('status'),
  log: $('log'),
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
    workspace: els.workspace.value.trim(),
    autoRestart: els.autoRestart.checked,
  }
}

async function load() {
  const s = await window.dsh.getSettings()
  els.harnessPath.value = s.harnessPath || ''
  els.dshHome.value = s.dshHome || ''
  els.port.value = String(s.port || 0)
  els.workspace.value = s.workspace || ''
  els.autoRestart.checked = !!s.autoRestart
}

async function save() {
  const port = Number.parseInt(els.port.value, 10)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    setStatus('端口必须是 0–65535 之间的整数（0 = 自动分配）。', 'err')
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
    workspace: '',
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
$('browseWorkspace').addEventListener('click', () => pickInto('workspace', '已选择工作目录'))

$('detectHarness').addEventListener('click', async () => {
  const found = await window.dsh.detectHarness()
  if (found) {
    els.harnessPath.value = found
    setStatus(`已检测到：${found}`, 'ok')
  } else {
    setStatus('未在常见位置检测到 harness，请手动浏览选择。', 'err')
  }
})

window.dsh.onLog((line) => {
  els.log.textContent += line
  const el = els.log
  el.scrollTop = el.scrollHeight
  if (el.textContent.length > 20000) {
    el.textContent = el.textContent.slice(-15000)
  }
})

// Reflect server state so the settings page can show failures too.
window.dsh.onState(() => {})

// Provenance block: desktop version, runtimes, and the bundled harness version.
window.dsh.getBundleInfo().then((info) => {
  const lines = [
    `桌面端版本：${info.appVersion}`,
    `Electron ${info.electron} / Chromium ${info.chrome} / Node ${info.node}`,
    info.harnessVersion
      ? `内置 Harness：${info.harnessVersion}（${info.packageCount ?? '?'} 包，构建于 ${(info.builtAt || '').slice(0, 19).replace('T', ' ')}）`
      : '内置 Harness：未捆绑（将使用外部 checkout 或检测路径）',
  ]
  if (info.harnessCheckout) lines.push(`来源 checkout：${info.harnessCheckout}`)
  document.getElementById('about').textContent = lines.join('\n')
})

load()
