'use strict'

/**
 * dsh-desktop — harness (kernel) update check.
 *
 * The check source is intentionally hardcoded here and never shown in the UI:
 * the official release channel is npm (`@deepseek-ai/dsh`), so the latest
 * published version is read from the registry's dist-tags. The repo link
 * surfaced to the user points at the official GitHub repository.
 */

const OFFICIAL_REPO_URL = 'https://github.com/deepseek-ai/deepseek-harness'
const NPM_REGISTRY_URL = 'https://registry.npmjs.org/@deepseek-ai/dsh'

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

module.exports = { compareVersions, fetchOfficialHarnessVersion, OFFICIAL_REPO_URL, NPM_REGISTRY_URL }
