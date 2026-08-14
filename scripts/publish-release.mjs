#!/usr/bin/env node
'use strict'

/**
 * Publish a GitHub Release for DeepSeek Harness Desktop.
 *
 * - Creates the release (tag must exist or be pushed first)
 * - Uploads the installer artifacts from release/ (NSIS, portable,
 *   latest.yml, blockmap) as release assets
 *
 * Auth: reuses the git credential manager's cached github.com token
 * (the same credential used for push).
 *
 * Usage: node scripts/publish-release.mjs [--tag v0.1.0] [--name <title>] [--body <notes|@file>]
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
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
      '- `DeepSeek Harness Desktop-<ver>-portable-x64.exe`：便携版（免安装）',
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
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dsh-desktop-publish',
      ...(options?.headers ?? {}),
    },
  })
  return res
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

if (FORCE) {
  // Replace stale assets: GitHub refuses same-name uploads, so delete first.
  const existing = await releaseAssets(release.id, token)
  for (const asset of existing) {
    console.log(`Deleting existing asset ${asset.name}…`)
    await requireOk(await apiJson(`${API}/releases/assets/${asset.id}`, { method: 'DELETE' }, token))
  }
}

/** Assets of a release; matches names with spaces or GitHub's dot variants. */
async function releaseAssets(releaseId, token) {
  const list = await requireOk(await apiJson(`${API}/releases/${releaseId}/assets`, { method: 'GET' }, token))
  return list.json()
}

function sameAsset(name, target) {
  return name === target || name === target.replace(/ /g, '.')
}

async function uploadAsset(release, file, token) {
  const name = path.basename(file)
  const data = readFileSync(file)
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`Uploading ${name} (${(data.length / 1024 / 1024).toFixed(1)} MB)${attempt > 1 ? `, attempt ${attempt}` : ''}…`)
    let upload
    try {
      upload = await apiJson(
        `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: data },
        token,
      )
    } catch (error) {
      // The connection may drop AFTER GitHub accepted the upload — check
      // whether the asset actually landed before retrying.
      const existing = await releaseAssets(release.id, token)
      if (existing.some((a) => sameAsset(a.name, name))) {
        console.log(`  -> received by GitHub (${error.cause?.code ?? error.message})`)
        return
      }
      if (attempt === 3) throw error
      console.log(`  -> ${error.cause?.code ?? error.message}, retrying…`)
      await new Promise((resolve) => setTimeout(resolve, attempt * 5000))
      continue
    }
    if (upload.status === 422 && (await upload.text()).includes('already_exists')) {
      console.log(`  -> already present, skipped`)
      return
    }
    const okRes = await requireOk(upload)
    const asset = await okRes.json()
    console.log(`  -> ${asset.browser_download_url}`)
    return
  }
}

for (const file of assets()) {
  await uploadAsset(release, file, token)
}

console.log('Done.')
