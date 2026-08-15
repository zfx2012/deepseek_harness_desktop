#!/usr/bin/env node
'use strict'

/**
 * Publish a GitHub Release for DeepSeek Harness Desktop.
 *
 * - Creates the release (tag must exist or be pushed first)
 * - Uploads the installer artifacts from release/ (NSIS,
 *   latest.yml, blockmap) as release assets
 *
 * Auth: reuses the git credential manager's cached github.com token
 * (the same credential used for push).
 *
 * Usage: node scripts/publish-release.mjs [--tag v0.1.0] [--name <title>] [--body <notes|@file>]
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const REPO = 'zfx2012/deepseek_harness_desktop'
const API = `https://api.github.com/repos/${REPO}`

const args = process.argv.slice(2)
const arg = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const TAG = arg('--tag')
const NAME = arg('--name') ?? TAG
const BODY_ARG = arg('--body')

function gitCredentialToken() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const match = out.match(/^password=(.+)$/m)
  if (!match) throw new Error('no cached github.com credential (push once to store it)')
  return match[1]
}

function assets() {
  const dir = path.join(ROOT, 'release')
  const picked = []
  for (const file of readdirSync(dir)) {
    if (file === 'builder-debug.yml') continue // build-machine debug artifact
    if (file.endsWith('.exe') || file.endsWith('.yml') || file.endsWith('.blockmap')) {
      if (file.includes('__uninstaller')) continue
      picked.push(path.join(dir, file))
    }
  }
  if (picked.length === 0) throw new Error(`no installer artifacts in ${dir} (run npm run dist first)`)
  return picked
}

function bodyText() {
  if (!BODY_ARG) {
    return [
      '## 安装包',
      '',
      '- `DeepSeek Harness Desktop-<ver>-x64.exe`：NSIS 安装包（可选安装目录）',
      '',
      '内置官方发布版 Harness 内核，安装即用（无需 Node，自动回退内置运行时）。',
      '',
      '## 功能',
      '',
      '- Windows 桌面外壳（Electron 43），自动拉起内置 `dsh web` 服务器',
      '- 自包含：无需 Node / 无需外部 harness',
      '- 设置页：harness 路径 / DSH_HOME / 端口 默认值预填，**内核更新检测 + 一键更新**',
      '- 崩溃自动重启、日志轮转、托盘常驻',
    ].join('\n')
  }
  if (BODY_ARG.startsWith('@')) {
    return readFileSync(path.resolve(ROOT, BODY_ARG.slice(1)), 'utf8')
  }
  return BODY_ARG
}

async function apiJson(url, options, token) {
  const { method = 'GET', headers = {}, body } = options ?? {}
  const allHeaders = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dsh-desktop-publish',
    ...headers,
  }
  if (body !== undefined && allHeaders['Content-Length'] === undefined) {
    allHeaders['Content-Length'] = String(Buffer.byteLength(body))
  }

  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = httpsRequest(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method,
        headers: allHeaders,
        // GitHub large-asset uploads can take a while on slow connections.
        // Node's https has no aggressive default header timeout like undici.
        timeout: 15 * 60 * 1000,
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers: res.headers,
            text: async () => text,
            json: async () => JSON.parse(text),
          })
        })
      },
    )
    req.on('timeout', () => {
      req.destroy(new Error(`GitHub request timed out after 15 minutes: ${url}`))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

async function requireOk(res) {
  if (res.ok) return res
  const text = await res.text()
  const err = new Error(`GitHub API ${res.status}: ${text.slice(0, 400)}`)
  err.status = res.status
  err.body = text
  throw err
}

if (!TAG) {
  console.error('usage: node scripts/publish-release.mjs --tag v0.1.0 [--name <title>] [--body <notes|@file>] [--upload-only] [--force]')
  process.exit(1)
}

const FORCE = args.includes('--force')

const token = gitCredentialToken()
let release
if (args.includes('--upload-only')) {
  console.log(`Release ${TAG} already exists — uploading assets only.`)
  const get = await requireOk(await apiJson(`${API}/releases/tags/${TAG}`, { method: 'GET' }, token))
  release = await get.json()
} else {
  console.log(`Creating release ${TAG} on ${REPO}…`)
  const create = await requireOk(await apiJson(`${API}/releases`, {
    method: 'POST',
    body: JSON.stringify({ tag_name: TAG, name: NAME, body: bodyText(), draft: false, prerelease: false }),
  }, token))
  release = await create.json()
  console.log(`Release created: ${release.html_url}`)
}

/** Assets of a release; matches names with spaces or GitHub's dot variants. */
async function releaseAssets(releaseId, token) {
  const list = await requireOk(await apiJson(`${API}/releases/${releaseId}/assets`, { method: 'GET' }, token))
  return list.json()
}

function sameAsset(name, target) {
  return name === target || name === target.replace(/ /g, '.')
}

async function deleteAsset(assetId, token) {
  await requireOk(await apiJson(`${API}/releases/assets/${assetId}`, { method: 'DELETE' }, token))
}

async function renameAsset(assetId, newName, token) {
  await requireOk(
    await apiJson(`${API}/releases/assets/${assetId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    }, token),
  )
}

/**
 * Poll the release assets until an asset whose name EXACTLY equals `name`
 * shows up. Exact (not variant) matching is deliberate: after a --force
 * delete, GitHub's asset list can briefly still show the deleted asset under
 * its dot-variant name — a variant match would mistake that stale entry for
 * a landed upload.
 */
async function waitForAsset(releaseId, name, token, tries = 8) {
  for (let i = 0; i < tries; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10000))
    const existing = await releaseAssets(releaseId, token)
    if (existing.some((a) => a.name === name)) return true
  }
  return false
}

async function uploadAsset(release, file, token, force) {
  const name = path.basename(file)
  const data = readFileSync(file)
  // --force: upload under a unique temp name first, then atomically replace —
  // delete the old asset and rename only AFTER the new one has landed. A
  // failed upload leaves the old asset untouched.
  const uploadName = force ? `${name}.uploading` : name
  if (force) {
    for (const asset of await releaseAssets(release.id, token)) {
      if (asset.name === uploadName) {
        console.log(`Deleting stale upload remnant ${uploadName}…`)
        await deleteAsset(asset.id, token)
      }
    }
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`Uploading ${force ? `${name} (as ${uploadName})` : name} (${(data.length / 1024 / 1024).toFixed(1)} MB)${attempt > 1 ? `, attempt ${attempt}` : ''}…`)
    let upload
    try {
      upload = await apiJson(
        `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(uploadName)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: data },
        token,
      )
    } catch (error) {
      // The connection may drop AFTER GitHub accepted the upload — poll the
      // asset list before retrying (GitHub lands large uploads asynchronously).
      if (await waitForAsset(release.id, uploadName, token)) {
        console.log(`  -> received by GitHub (${error.cause?.code ?? error.message})`)
        break
      }
      if (attempt === 3) throw error
      console.log(`  -> ${error.cause?.code ?? error.message}, not landed yet, retrying…`)
      await new Promise((resolve) => setTimeout(resolve, attempt * 5000))
      continue
    }
    if (upload.status === 422 && (await upload.text()).includes('already_exists')) {
      console.log(`  -> already present, skipped`)
      return
    }
    if (upload.ok) {
      const asset = await upload.json()
      console.log(`  -> ${asset.browser_download_url}`)
      break
    }
    throw new Error(`upload ${uploadName} failed: HTTP ${upload.status}`)
  }
  if (force) {
    // The new asset is landed under the temp name — now replace the old one.
    const landed = (await releaseAssets(release.id, token)).find((a) => a.name === uploadName)
    if (!landed) throw new Error(`${uploadName} did not land on GitHub`)
    for (const asset of await releaseAssets(release.id, token)) {
      if (sameAsset(asset.name, name)) {
        console.log(`Deleting old asset ${asset.name}…`)
        await deleteAsset(asset.id, token)
      }
    }
    console.log(`Renaming ${uploadName} -> ${name}…`)
    await renameAsset(landed.id, name, token)
  }
}

for (const file of assets()) {
  await uploadAsset(release, file, token, FORCE)
}

console.log('Done.')
