'use strict'

/**
 * Kernel-update helpers: semver-ish comparison and the official version fetch.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { compareVersions, fetchOfficialHarnessVersion } = require('../src/harness-update.js')

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
