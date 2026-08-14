#!/usr/bin/env node
'use strict'

/**
 * Local generic-feed server for the update smoke test.
 *
 * Serves a fake `latest.yml` (version 0.2.0, newer than the app's 0.1.0) on
 * 127.0.0.1:<port> until killed. The smoke test only exercises update
 * DISCOVERY (checkForUpdates), which parses the feed and compares versions —
 * no file is downloaded, so the file list needs no real artifacts.
 *
 * Usage: node scripts/update-feed.mjs [--port 18765]
 */

import { createServer } from 'node:http'

const args = process.argv.slice(2)
const portIdx = args.indexOf('--port')
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : 18765

const LATEST_YML = `version: 0.2.0
files:
  - url: DeepSeek Harness Desktop-0.2.0-x64.exe
    sha512: ${'0'.repeat(128)}
    size: 1
path: DeepSeek Harness Desktop-0.2.0-x64.exe
sha512: ${'0'.repeat(128)}
releaseDate: '2026-08-14T00:00:00.000Z'
`

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost')
  if (pathname === '/latest.yml' || pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/yaml' })
    res.end(LATEST_YML)
  } else {
    res.writeHead(404)
    res.end()
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`update-feed listening on http://127.0.0.1:${PORT}/latest.yml`)
})
