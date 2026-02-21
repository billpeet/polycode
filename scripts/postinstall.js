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
const electronPkg = require(path.join(ROOT, 'node_modules', 'electron', 'package.json'))
const electronVersion = electronPkg.version

// Determine the Electron ABI from the dist/version file
const electronVersionFile = path.join(
  ROOT, 'node_modules', 'electron', 'dist', 'version'
)
let abiVersion = null
if (fs.existsSync(electronVersionFile)) {
  // Map electron version → ABI using process.versions equivalent lookup
  // We just use prebuild-install to query it
  try {
    const result = spawnSync(
      process.execPath,
      ['-e', `
        const { execSync } = require('child_process');
        // Get ABI from electron's node version
        const ver = require('${electronVersionFile.replace(/\\/g, '\\\\')}').trim ? require('fs').readFileSync('${electronVersionFile.replace(/\\/g, '\\\\')}', 'utf8').trim() : '33.4.11';
        console.log(ver);
      `],
      { encoding: 'utf8' }
    )
  } catch {}
}

// Electron 33.x → ABI v130, 34.x → v132, 35.x → v135
// Read from electron/dist/version
let electronVer = electronVersion
try {
  if (fs.existsSync(electronVersionFile)) {
    electronVer = fs.readFileSync(electronVersionFile, 'utf8').trim()
  }
} catch {}

const majorMinor = electronVer.split('.').map(Number)
const major = majorMinor[0]

// ABI map (from https://www.electronjs.org/docs/latest/tutorial/electron-versioning)
const abiMap = {
  29: 'v121', 30: 'v123', 31: 'v125', 32: 'v128',
  33: 'v130', 34: 'v132', 35: 'v135'
}
const abi = abiMap[major] ?? 'v130'

const prebuiltDir = path.join(
  ROOT, 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64', 'build', 'Release'
)
const prebuiltNode = path.join(prebuiltDir, 'better_sqlite3.node')

if (fs.existsSync(prebuiltNode)) {
  console.log(`[postinstall] better-sqlite3 prebuilt already present (electron ${abi}).`)
  process.exit(0)
}

const tarball = `better-sqlite3-v${bsq3Version}-electron-${abi}-win32-x64.tar.gz`
const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${bsq3Version}/${tarball}`
const tmp = path.join(require('os').tmpdir(), tarball)
// Two places bindings looks: prebuilds/ and lib/binding/
const prebuildsDir = path.join(ROOT, 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64')
const bindingDir = path.join(ROOT, 'node_modules', 'better-sqlite3', 'lib', 'binding', `node-${abi}-win32-x64`)

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
  // Also copy to lib/binding/ path that bindings.js resolves at runtime
  const src = path.join(prebuildsDir, 'build', 'Release', 'better_sqlite3.node')
  const dst = path.join(bindingDir, 'better_sqlite3.node')
  fs.copyFileSync(src, dst)
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
