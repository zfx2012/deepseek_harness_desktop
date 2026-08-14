'use strict'

/**
 * ServerManager state-machine tests: readiness detection, stale-log guard,
 * restart race, crash auto-restart, stop, spawn errors,
 * pre-heal, log rotation, and the Node-version launch gate — with an injected
 * fake child process and spawnSync.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  ServerManager,
  parseNodeVersion,
  satisfiesHarnessEngines,
  resolveNodeLaunch,
  resetNodeLaunchCache,
} = require('../src/server.js')

// ── fake process plumbing ────────────────────────────────────────────────────

function fakeChild() {
  const child = new EventEmitter()
  child.pid = Math.floor(Math.random() * 60000) + 1000
  child.killed = false
  child.kill = () => { child.killed = true }
  return child
}

function makeFakeHarness(dir) {
  const cli = path.join(dir, 'apps', 'cli', 'lib')
  fs.mkdirSync(cli, { recursive: true })
  fs.writeFileSync(path.join(cli, 'bin.js'), '')
  fs.mkdirSync(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh-web-app'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'), '')
}

function makeManager(opts) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-test-'))
  const harness = path.join(tmp, 'harness')
  makeFakeHarness(harness)
  const settings = {
    get: (key) => ({ harnessPath: harness, dshHome: '', port: 0, workspace: '', autoRestart: true }[key]),
  }
  const spawned = []
  const spawnImpl = (...args) => {
    const child = fakeChild()
    spawned.push({ args, child })
    return child
  }
  const manager = new ServerManager({
    settings,
    logFile: path.join(tmp, 'server.log'),
    onState: () => {},
    onLog: () => {},
    spawnImpl,
    spawnSyncImpl: () => ({ status: 0 }),
    ...opts,
  })
  return { manager, spawned, tmp, harness }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── pure helpers ─────────────────────────────────────────────────────────────

test('parseNodeVersion handles common formats', () => {
  assert.deepEqual(parseNodeVersion('v24.18.0\n'), [24, 18, 0])
  assert.deepEqual(parseNodeVersion('22.19.1'), [22, 19, 1])
  assert.equal(parseNodeVersion('garbage'), null)
})

test('satisfiesHarnessEngines mirrors engines ^22.19.0 || >=24.0.0', () => {
  assert.equal(satisfiesHarnessEngines([22, 19, 0]), true)
  assert.equal(satisfiesHarnessEngines([22, 18, 0]), false)
  assert.equal(satisfiesHarnessEngines([23, 0, 0]), false) // not in range
  assert.equal(satisfiesHarnessEngines([24, 0, 0]), true)
  assert.equal(satisfiesHarnessEngines([24, 18, 0]), true)
  assert.equal(satisfiesHarnessEngines(null), false)
})

test('resolveNodeLaunch uses system node only when engines are satisfied', () => {
  resetNodeLaunchCache()
  const launch = resolveNodeLaunch(() => ({ status: 0, stdout: 'v22.18.0\n' }))
  assert.equal(launch.command, process.execPath) // too old -> fallback
  assert.deepEqual(launch.args, ['--expose-internals'])

  resetNodeLaunchCache()
  const ok = resolveNodeLaunch(() => ({ status: 0, stdout: 'v24.18.1\n' }))
  assert.equal(ok.command, 'node')
  resetNodeLaunchCache()
})

// ── readiness / lifecycle ────────────────────────────────────────────────────

test('becomes ready when the log gains the readiness line', async () => {
  const { manager, spawned, tmp } = makeManager()
  const states = []
  manager.onState = (s) => states.push(s.phase)

  manager.start()
  assert.equal(states[0], 'starting')
  assert.equal(spawned.length, 1)
  const [cmd, args] = spawned[0].args
  assert.equal(cmd, 'node')
  assert.ok(args.includes('--port'))

  // The child writes the readiness line to the log file (as its fd would).
  fs.appendFileSync(manager.logFile, 'boot noise\n')
  await sleep(900)
  assert.equal(manager.phase, 'starting', 'noise must not trigger ready')

  fs.appendFileSync(manager.logFile, 'dsh web: http://127.0.0.1:39999\n')
  await sleep(900)
  assert.equal(manager.phase, 'ready')
  assert.equal(manager.url, 'http://127.0.0.1:39999')

  manager.dispose()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('stale readiness lines from previous boots never trigger ready', async () => {
  const { manager, tmp } = makeManager()
  // Simulate a previous boot whose readiness line is already in the log.
  fs.appendFileSync(manager.logFile, 'dsh web: http://127.0.0.1:11111\n')

  manager.start()
  await sleep(900)
  assert.equal(manager.phase, 'starting', 'old readiness line must not match')

  fs.appendFileSync(manager.logFile, 'dsh web: http://127.0.0.1:22222\n')
  await sleep(900)
  assert.equal(manager.phase, 'ready')
  assert.equal(manager.url, 'http://127.0.0.1:22222')

  manager.dispose()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('restart: the old child late exit must not corrupt the new boot', async () => {
  const { manager, spawned, tmp } = makeManager()
  const nodeSpawns = () => spawned.filter((s) => s.args[0] === 'node').length

  // 1. first boot -> ready
  manager.start()
  fs.appendFileSync(manager.logFile, 'dsh web: http://127.0.0.1:11111\n')
  await sleep(900)
  assert.equal(manager.phase, 'ready')

  // 2. restart (settings save / menu restart)
  const oldChild = spawned[0].child
  manager.start()
  assert.equal(nodeSpawns(), 2)
  assert.equal(manager.phase, 'starting')

  // 3. the OLD child's exit arrives late (taskkill latency)
  oldChild.emit('exit', 1, null)
  assert.equal(manager.phase, 'starting', 'stale exit must be ignored')
  assert.notEqual(manager.child, null, 'new child reference must survive')

  // 4. the NEW child reports ready -> ready state, correct URL
  fs.appendFileSync(manager.logFile, 'dsh web: http://127.0.0.1:22222\n')
  await sleep(900)
  assert.equal(manager.phase, 'ready')
  assert.equal(manager.url, 'http://127.0.0.1:22222')

  manager.dispose()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('crash after ready auto-restarts (autoRestart)', async () => {
  const { manager, spawned, tmp } = makeManager()
  const nodeSpawns = () => spawned.filter((s) => s.args[0] === 'node').length
  manager.start()
  fs.appendFileSync(manager.logFile, 'dsh web: http://127.0.0.1:33333\n')
  await sleep(900)
  assert.equal(manager.phase, 'ready')
  assert.equal(nodeSpawns(), 1)

  spawned[0].child.emit('exit', 1, null) // unexpected crash
  assert.equal(manager.phase, 'starting')

  await sleep(3400) // crash restart delay is 3s
  assert.equal(nodeSpawns(), 2, 'server must respawn after crash')
  manager.dispose()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('stop() lands in idle without respawn', async () => {
  const { manager, spawned, tmp } = makeManager()
  const nodeSpawns = () => spawned.filter((s) => s.args[0] === 'node').length
  manager.start()
  fs.appendFileSync(manager.logFile, 'dsh web: http://127.0.0.1:44444\n')
  await sleep(900)
  assert.equal(manager.phase, 'ready')

  manager.stop()
  assert.equal(manager.phase, 'idle')
  await sleep(3400)
  assert.equal(nodeSpawns(), 1, 'no respawn after explicit stop')
  manager.dispose()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('spawn error surfaces as phase error', () => {
  const { manager, spawned, tmp } = makeManager()
  manager.start()
  spawned[0].child.emit('error', Object.assign(new Error('boom'), { code: 'EPERM' }))
  assert.equal(manager.phase, 'error')
  assert.match(manager.error, /boom/)
  manager.dispose()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('harness source is tracked in state', () => {
  const { manager, tmp } = makeManager()
  manager.start()
  assert.equal(manager.state.harnessSource, 'setting') // explicit harnessPath
  manager.dispose()
  fs.rmSync(tmp, { recursive: true, force: true })
})

// ── pre-heal / log rotation ──────────────────────────────────────────────────

test('preHealProfiles replaces a real directory with a junction', () => {
  const { manager, harness, tmp } = makeManager()
  const home = path.join(tmp, 'dsh-home')
  const dest = path.join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-web-app')
  fs.mkdirSync(dest, { recursive: true })
  fs.writeFileSync(path.join(dest, 'leftover.txt'), 'old data')

  manager.preHealProfiles(home, harness)

  const st = fs.lstatSync(dest)
  assert.equal(st.isSymbolicLink(), true, 'real dir must be replaced by a junction')
  assert.equal(fs.existsSync(`${dest}.dsh-bak`), true, 'old dir moved aside')
  assert.equal(fs.existsSync(path.join(`${dest}.dsh-bak`, 'leftover.txt')), true)
  manager.dispose()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('preHealProfiles keeps an existing junction untouched', () => {
  const { manager, harness, tmp } = makeManager()
  const home = path.join(tmp, 'dsh-home')
  const dest = path.join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-web-app')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const target = path.join(harness, 'node_modules', '@deepseek-ai', 'dsh-web-app')
  fs.symlinkSync(target, dest, 'junction')

  manager.preHealProfiles(home, harness)
  assert.equal(fs.lstatSync(dest).isSymbolicLink(), true)
  assert.equal(fs.existsSync(`${dest}.dsh-bak`), false, 'existing link must not be renamed')
  manager.dispose()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('rotateLog keeps two generations when the log outgrows the cap', () => {
  const { manager, tmp } = makeManager()
  // Write a fake oversize log (content size, not on-disk blocks).
  const big = Buffer.alloc(5 * 1024 * 1024 + 100, 0x61)
  fs.writeFileSync(manager.logFile, big)

  manager.rotateLog()
  assert.equal(fs.existsSync(`${manager.logFile}.1`), true)
  assert.equal(fs.existsSync(manager.logFile), false, 'old log moved aside; the next spawn recreates it')

  // Second rotation: .1 moves to .2.
  fs.writeFileSync(manager.logFile, big)
  manager.rotateLog()
  assert.equal(fs.existsSync(`${manager.logFile}.2`), true)
  manager.dispose()
  fs.rmSync(tmp, { recursive: true, force: true })
})
