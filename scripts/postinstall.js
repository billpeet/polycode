#!/usr/bin/env node
/**
 * postinstall.js
 *
 * Runs after `bun install` (or npm install) to ensure native binaries are present:
 *   1. Electron binary  — runs node_modules/electron/install.js if path.txt is missing
 *   2. better-sqlite3   — downloads the prebuilt .node for the installed Electron ABI
 *
 * Needed because `bun install --ignore-scripts` skips postinstall hooks in sub-packages.
 */

const { execSync, spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const https = require('https')

const ROOT = path.resolve(__dirname, '..')

// ── 1. Electron binary ────────────────────────────────────────────────────────

const electronPathTxt = path.join(ROOT, 'node_modules', 'electron', 'path.txt')
if (!fs.existsSync(electronPathTxt)) {
  console.log('[postinstall] Downloading Electron binary...')
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'electron', 'install.js')
  ], { stdio: 'inherit', cwd: ROOT })
  if (result.status !== 0) {
    console.error('[postinstall] Electron install failed')
    process.exit(1)
  }
} else {
  console.log('[postinstall] Electron binary already present.')
}

// ── 2. better-sqlite3 prebuilt ────────────────────────────────────────────────

const bsq3PkgPath = path.join(ROOT, 'node_modules', 'better-sqlite3', 'package.json')
if (!fs.existsSync(bsq3PkgPath)) {
  console.log('[postinstall] better-sqlite3 not found, skipping.')
  process.exit(0)
}

const bsq3Version = require(bsq3PkgPath).version

// Determine the installed Electron's ABI directly — a hardcoded version→ABI
// map silently goes stale the moment Electron is bumped, which packages a
// prebuilt for the wrong ABI and crashes the app at startup.
// Recent electron packages ship an abi_version file; fall back to asking the
// binary itself for older versions.
let abiNumber = null
const abiVersionFile = path.join(ROOT, 'node_modules', 'electron', 'abi_version')
if (fs.existsSync(abiVersionFile)) {
  abiNumber = fs.readFileSync(abiVersionFile, 'utf8').trim()
} else {
  const electronExeName = fs
    .readFileSync(path.join(ROOT, 'node_modules', 'electron', 'path.txt'), 'utf8')
    .trim()
  const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', electronExeName)
  const abiProbe = spawnSync(electronExe, ['-p', 'process.versions.modules'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8'
  })
  abiNumber = (abiProbe.stdout || '').trim()
}
if (!/^\d+$/.test(abiNumber)) {
  console.error('[postinstall] Could not determine Electron ABI.')
  process.exit(1)
}
const abi = `v${abiNumber}`

// The ABI-specific binding path is the source of truth for "already installed" —
// checking an ABI-less path would let a stale binary from a previous Electron
// version short-circuit the download.
const bindingDir = path.join(
  ROOT, 'node_modules', 'better-sqlite3', 'lib', 'binding', `node-${abi}-win32-x64`
)
const bindingNode = path.join(bindingDir, 'better_sqlite3.node')

if (fs.existsSync(bindingNode)) {
  // Refresh the generic copies in case they hold a binary for a different ABI
  const buildReleaseDir = path.join(ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release')
  fs.mkdirSync(buildReleaseDir, { recursive: true })
  fs.copyFileSync(bindingNode, path.join(buildReleaseDir, 'better_sqlite3.node'))
  const genericPrebuilt = path.join(
    ROOT, 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64', 'build', 'Release'
  )
  fs.mkdirSync(genericPrebuilt, { recursive: true })
  fs.copyFileSync(bindingNode, path.join(genericPrebuilt, 'better_sqlite3.node'))
  console.log(`[postinstall] better-sqlite3 prebuilt already present (electron ${abi}).`)
  process.exit(0)
}

const tarball = `better-sqlite3-v${bsq3Version}-electron-${abi}-win32-x64.tar.gz`
const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${bsq3Version}/${tarball}`
const tmp = path.join(require('os').tmpdir(), tarball)
// Two places bindings looks: prebuilds/ and lib/binding/
const prebuildsDir = path.join(ROOT, 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64')

console.log(`[postinstall] Downloading better-sqlite3 prebuilt (electron ${abi})...`)
console.log(`[postinstall] ${url}`)

fs.mkdirSync(prebuildsDir, { recursive: true })
fs.mkdirSync(bindingDir, { recursive: true })

downloadFile(url, tmp, (err) => {
  if (err) {
    console.error('[postinstall] Download failed:', err.message)
    process.exit(1)
  }
  console.log('[postinstall] Extracting...')
  const result = spawnSync('tar', ['-xzf', tmp, '-C', prebuildsDir], { stdio: 'inherit' })
  if (result.status !== 0) {
    console.error('[postinstall] Extraction failed')
    process.exit(1)
  }
  fs.unlinkSync(tmp)
  const src = path.join(prebuildsDir, 'build', 'Release', 'better_sqlite3.node')
  // Copy to lib/binding/ path that bindings.js resolves at runtime
  const dst = path.join(bindingDir, 'better_sqlite3.node')
  fs.copyFileSync(src, dst)
  // Overwrite build/Release/ so the Electron prebuilt wins over any
  // node-gyp artefact compiled against the host Node.js version
  const buildReleaseDir = path.join(ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release')
  fs.mkdirSync(buildReleaseDir, { recursive: true })
  fs.copyFileSync(src, path.join(buildReleaseDir, 'better_sqlite3.node'))
  console.log('[postinstall] better-sqlite3 prebuilt installed.')
})

function downloadFile(url, dest, cb) {
  const follow = (u, redirects) => {
    if (redirects > 5) return cb(new Error('Too many redirects'))
    const mod = u.startsWith('https') ? https : require('http')
    mod.get(u, { headers: { 'User-Agent': 'node' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return follow(res.headers.location, redirects + 1)
      }
      if (res.statusCode !== 200) return cb(new Error(`HTTP ${res.statusCode}`))
      const out = fs.createWriteStream(dest)
      res.pipe(out)
      out.on('finish', () => out.close(cb))
      out.on('error', cb)
    }).on('error', cb)
  }
  follow(url, 0)
}
