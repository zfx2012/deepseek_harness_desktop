'use strict'

/**
 * Kernel-update helpers: semver-ish comparison, the official version fetch,
 * and the direct-install merge (installHarnessUpdate).
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  compareVersions,
  fetchOfficialHarnessVersion,
  installHarnessUpdate,
} = require('../src/harness-update.js')

/** Fake npm: materializes a plausible stage tree for the requested install. */
function fakeNpmInstall(logs = []) {
  return (cmd, args, opts) => {
    logs.push([cmd, args])
    assert.equal(args[0], 'install')
    assert.match(args[1], /^@deepseek-ai\/dsh@\d+\.\d+\.\d+/)
    const stage = opts.cwd
    // The installed package itself (deploy layout).
    const pkg = path.join(stage, 'node_modules', '@deepseek-ai', 'dsh')
    fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(pkg, 'lib', 'bin.js'), '// new kernel\n')
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.2.3-new' }))
    fs.mkdirSync(path.join(pkg, 'config'), { recursive: true })
    fs.writeFileSync(path.join(pkg, 'config', 'extra.txt'), 'x')
    // Nested dependency (conflict layout).
    const nested = path.join(pkg, 'node_modules', '@deepseek-ai', 'dsh-web-app')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(nested, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-web-app' }))
    fs.mkdirSync(path.join(nested, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(nested, 'dist', 'index.html'), '<html>new</html>')
    // Hoisted top-level dependencies.
    const hoisted = path.join(stage, 'node_modules', '@deepseek-ai', 'dsh-base')
    fs.mkdirSync(hoisted, { recursive: true })
    fs.writeFileSync(path.join(hoisted, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base' }))
    const commander = path.join(stage, 'node_modules', 'commander')
    fs.mkdirSync(commander, { recursive: true })
    fs.writeFileSync(path.join(commander, 'package.json'), JSON.stringify({ name: 'commander' }))
    return { status: 0, stdout: '', stderr: '' }
  }
}

/** A minimal deploy-layout harness root with some stale content. */
function makeDeployHarness(dir) {
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'lib', 'bin.js'), '// old kernel\n')
  fs.mkdirSync(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh-web-app'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'old.txt'), 'stale')
  fs.writeFileSync(path.join(dir, 'old-junk.txt'), 'remove me')
}

test('compareVersions orders releases and prereleases', () => {
  assert.ok(compareVersions('0.1.0-rc.6', '0.1.0-rc.5') > 0)
  assert.ok(compareVersions('0.1.0-rc.5', '0.1.0-rc.6') < 0)
  assert.equal(compareVersions('0.1.0-rc.5', '0.1.0-rc.5'), 0)
  assert.ok(compareVersions('0.2.0', '0.1.9') > 0)
  assert.ok(compareVersions('1.0.0', '0.9.9-rc.9') > 0)
  assert.ok(compareVersions('0.1.0', '0.1.0-rc.10') > 0, 'release outranks prerelease')
  assert.ok(compareVersions('0.1.0-rc.10', '0.1.0-rc.9') > 0, 'numeric prerelease fields compare numerically')
  assert.equal(compareVersions('v0.1.0-rc.5', '0.1.0-rc.5'), 0, 'leading v is tolerated')
})

test('fetchOfficialHarnessVersion reads npm dist-tags and hardcodes the repo URL', async () => {
  const result = await fetchOfficialHarnessVersion({
    fetchImpl: async (url) => {
      assert.match(url, /registry\.npmjs\.org/, 'checks the official npm release channel')
      return { ok: true, status: 200, json: async () => ({ 'dist-tags': { latest: '9.9.9-test' } }) }
    },
  })
  assert.equal(result.latest, '9.9.9-test')
  assert.equal(result.repoUrl, 'https://github.com/deepseek-ai/deepseek-harness')
})

test('fetchOfficialHarnessVersion surfaces HTTP failures', async () => {
  await assert.rejects(
    fetchOfficialHarnessVersion({
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }),
    /HTTP 503/,
  )
})

test('installHarnessUpdate merges the npm closure into a deploy-layout root', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-upd-test-'))
  const target = path.join(tmp, 'harness')
  makeDeployHarness(target)
  const logs = []

  const result = await installHarnessUpdate('1.2.3', target, {
    npmCommand: 'npm',
    spawnImpl: fakeNpmInstall(logs),
    log: () => {},
  })

  assert.equal(result.ok, true)
  assert.equal(result.version, '1.2.3-new')
  // Package files replaced the root-level ones.
  assert.equal(fs.readFileSync(path.join(target, 'lib', 'bin.js'), 'utf8'), '// new kernel\n')
  assert.ok(fs.existsSync(path.join(target, 'config', 'extra.txt')), 'new package files are merged')
  assert.ok(!fs.existsSync(path.join(target, 'old-junk.txt')), 'stale root files are replaced')
  // Dependency closure merged (hoisted + nested) over the old one.
  assert.equal(
    fs.readFileSync(path.join(target, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'dist', 'index.html'), 'utf8'),
    '<html>new</html>',
  )
  assert.ok(!fs.existsSync(path.join(target, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'old.txt')))
  assert.ok(fs.existsSync(path.join(target, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json')))
  assert.ok(fs.existsSync(path.join(target, 'node_modules', 'commander', 'package.json')))
  // Provenance manifest rewritten.
  const manifest = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'))
  assert.equal(manifest.harnessVersion, '1.2.3-new')
  assert.equal(manifest.updatedBy, 'dsh-desktop')
  assert.equal(manifest.packageCount, 2) // @deepseek-ai + commander at the top level
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('installHarnessUpdate rejects invalid versions', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-upd-test-'))
  const target = path.join(tmp, 'harness')
  makeDeployHarness(target)
  await assert.rejects(installHarnessUpdate('latest', target, { spawnImpl: fakeNpmInstall() }), /无效的版本号/)
  await assert.rejects(installHarnessUpdate('', target, { spawnImpl: fakeNpmInstall() }), /无效的版本号/)
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('installHarnessUpdate refuses non-deploy targets and npm failures', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-upd-test-'))
  // Checkout layout (apps/cli/lib/bin.js) must be refused.
  const checkout = path.join(tmp, 'checkout')
  fs.mkdirSync(path.join(checkout, 'apps', 'cli', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(checkout, 'apps', 'cli', 'lib', 'bin.js'), '')
  await assert.rejects(installHarnessUpdate('1.2.3', checkout, { spawnImpl: fakeNpmInstall() }), /deploy 布局/)
  // npm failure surfaces its exit status.
  const target = path.join(tmp, 'harness')
  makeDeployHarness(target)
  await assert.rejects(
    installHarnessUpdate('1.2.3', target, {
      spawnImpl: () => ({ status: 1, stdout: '', stderr: 'ETARGET no matching version' }),
    }),
    /npm install 失败（exit 1）/,
  )
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('installHarnessUpdate fresh mode builds into an empty directory', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-upd-test-'))
  const target = path.join(tmp, 'bundle')
  fs.mkdirSync(target)
  const result = await installHarnessUpdate('1.2.3', target, {
    npmCommand: 'npm',
    spawnImpl: fakeNpmInstall(),
    fresh: true,
  })
  assert.equal(result.ok, true)
  assert.equal(fs.readFileSync(path.join(target, 'lib', 'bin.js'), 'utf8'), '// new kernel\n')
  assert.ok(fs.existsSync(path.join(target, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'dist', 'index.html')))
  assert.ok(fs.existsSync(path.join(target, 'node_modules', 'commander', 'package.json')))
  const manifest = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'))
  assert.equal(manifest.harnessVersion, '1.2.3-new')
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('installHarnessUpdate falls back to cmd.exe when .cmd spawn is blocked', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-upd-test-'))
  const target = path.join(tmp, 'harness')
  makeDeployHarness(target)
  const calls = []
  const spawnImpl = (cmd, args, opts) => {
    calls.push([cmd, args])
    if (cmd === 'npm.cmd') return { status: null, error: new Error('spawnSync npm.cmd EINVAL') }
    // cmd.exe /c fallback: materialize the stage tree like the real npm would.
    const stage = opts.cwd
    const pkg = path.join(stage, 'node_modules', '@deepseek-ai', 'dsh')
    fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(pkg, 'lib', 'bin.js'), '// new kernel\n')
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.2.3-cmd' }))
    const hoisted = path.join(stage, 'node_modules', '@deepseek-ai', 'dsh-web-app')
    fs.mkdirSync(path.join(hoisted, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(hoisted, 'dist', 'index.html'), '<html>ok</html>')
    return { status: 0, stdout: '', stderr: '' }
  }
  const result = await installHarnessUpdate('1.2.3', target, { npmCommand: 'npm.cmd', spawnImpl })
  assert.equal(result.ok, true)
  assert.equal(calls[0][0], 'npm.cmd')
  assert.equal(calls[1][0], 'cmd.exe')
  // cmd.exe /c must receive the npm command itself as the first token.
  assert.deepEqual(calls[1][1].slice(0, 5), ['/d', '/s', '/c', 'npm.cmd', 'install'])
  assert.equal(fs.readFileSync(path.join(target, 'lib', 'bin.js'), 'utf8'), '// new kernel\n')
  fs.rmSync(tmp, { recursive: true, force: true })
})
