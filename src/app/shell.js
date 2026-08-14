'use strict'

// Shell page: shows a loading spinner while the server boots, an error card
// with the server log tail when boot failed, or a stopped card. The main
// process navigates this window to the GUI URL itself once the server is
// ready. The page also acts as a state fallback: it re-renders on every
// state change and its buttons drive the server through the dsh bridge.

const loading = document.getElementById('loading')
const errorBox = document.getElementById('error')
const errorMsg = document.getElementById('error-msg')
const errorLog = document.getElementById('error-log')
const stoppedBox = document.getElementById('stopped')

function render(state) {
  const isError = state.phase === 'error'
  const isStopped = state.phase === 'idle'
  loading.classList.toggle('hidden', isError || isStopped)
  errorBox.classList.toggle('hidden', !isError)
  stoppedBox.classList.toggle('hidden', !isStopped)
  if (isError) {
    errorMsg.textContent = state.error || '未知错误'
    errorLog.textContent = (state.logTail || []).join('\n')
  }
}

window.dsh.getState().then(render)
window.dsh.onState(render)

document.getElementById('retry').addEventListener('click', () => {
  window.dsh.restartServer()
})
document.getElementById('settings').addEventListener('click', () => {
  window.dsh.openSettings()
})
document.getElementById('start').addEventListener('click', () => {
  window.dsh.restartServer()
})
document.getElementById('settings-stopped').addEventListener('click', () => {
  window.dsh.openSettings()
})
