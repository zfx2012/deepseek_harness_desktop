'use strict'
// One-off reproduction: late exit from the OLD child after a restart.
// Expected bug: the old child's exit event corrupts the new boot's state.
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ServerManager } = require('../src/server.js')

function fakeChild() {
  const child = new EventEmitter()
  child.pid = Math.floor(Math.random() * 60000) + 1000
  child.killed = false
  child.kill = () => { child.killed = true }
  return child
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-race-'))
const harness = path.join(tmp, 'harness')
fs.mkdirSync(path.join(harness, 'apps', 'cli', 'lib'), { recursive: true })
fs.writeFileSync(path.join(harness, 'apps', 'cli', 'lib', 'bin.js'), '')
fs.mkdirSync(path.join(harness, 'node_modules', '@deepseek-ai', 'dsh-web-app'), { recursive: true })

const spawned = []
const spawnImpl = (...args) => {
  const child = fakeChild()
  spawned.push({ args, child })
  return child
}

const manager = new ServerManager({
  settings: { get: (k) => ({ harnessPath: harness, dshHome: '', port: 0, workspace: '', autoRestart: true }[k]) },
  logFile: path.join(tmp, 'server.log'),
  onState: () => {},
  onLog: () => {},
  spawnImpl,
})

const states = []
manager.onState = (s) => states.push(`${s.phase}${s.url ? '@' + s.url : ''}`)

// 1. first boot -> ready
manager.start()
fs.appendFileSync(manager.logFile, 'dsh web: http://127.0.0.1:11111\n')
setTimeout(() => {
  console.log('after boot:', states[states.length - 1])

  // 2. restart (user changes settings / menu restart)
  const oldChild = spawned[0].child
  manager.start()
  const nodeSpawns = spawned.filter((s) => s.args[0] === 'node')
  console.log('after restart spawns:', nodeSpawns.length)

  // 3. the OLD child's exit arrives late (taskkill latency)
  oldChild.emit('exit', 1, null)
  console.log('after old-child late exit:', states[states.length - 1], '| manager.phase =', manager.phase, '| url =', manager.url, '| error =', manager.error)

  // 4. the NEW child reports ready — does it still reach ready?
  fs.appendFileSync(manager.logFile, 'dsh web: http://127.0.0.1:22222\n')
  setTimeout(() => {
    console.log('after new-child ready line:', manager.phase, '| url =', manager.url, '| error =', manager.error)
    console.log(manager.phase === 'ready' && manager.url === 'http://127.0.0.1:22222' ? 'RACE REPRODUCED: no (unexpected)' : 'RACE REPRODUCED: YES — state corrupted')
    manager.dispose()
    process.exit(0)
  }, 1200)
}, 1200)
