#!/usr/bin/env node
// Proves the better-sqlite3 binary that electron-builder will package loads and
// runs under the installed Electron, resolving it exactly as the app does.

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

function resolvePackageDir(name) {
  try {
    return path.dirname(require.resolve(`${name}/package.json`, { paths: [__dirname] }))
  } catch {
    return null
  }
}

const electronDir = resolvePackageDir('electron')
const betterSqliteDir = resolvePackageDir('better-sqlite3')
if (!electronDir || !betterSqliteDir) {
  console.error('[verify-electron-abi] electron or better-sqlite3 is not installed.')
  process.exit(1)
}

const electronPathFile = path.join(electronDir, 'path.txt')
if (!fs.existsSync(electronPathFile)) {
  console.error('[verify-electron-abi] Electron binary is not installed.')
  process.exit(1)
}

const electronExe = path.join(
  electronDir,
  'dist',
  fs.readFileSync(electronPathFile, 'utf8').trim()
)

const probe = [
  "const dir = process.argv[1]",
  "const binary = require(require('path').join(dir, 'lib', 'binding.js')).getPrebuildPath()",
  "const Database = require(dir)",
  "const db = new Database(':memory:')",
  "const sqlite = db.prepare('select sqlite_version() as v').get().v",
  "db.close()",
  "process.stdout.write(JSON.stringify({ abi: process.versions.modules, electron: process.versions.electron, binary, sqlite }))"
].join(';')
const result = spawnSync(electronExe, ['-e', probe, betterSqliteDir], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8'
})

if (result.status !== 0) {
  console.error('[verify-electron-abi] better-sqlite3 failed to load in Electron.')
  if (result.stderr) console.error(result.stderr.trim().split(/\r?\n/).slice(-12).join('\n'))
  process.exit(1)
}

let output
try {
  output = JSON.parse(result.stdout)
} catch {
  console.error('[verify-electron-abi] Electron probe returned invalid output.')
  process.exit(1)
}

// Without a prebuild, better-sqlite3 falls back to a node-gyp build/ output,
// compiled for whatever runtime built it — not what we intend to ship.
if (!output.binary) {
  console.error('[verify-electron-abi] better-sqlite3 has no N-API prebuild for this platform.')
  process.exit(1)
}

console.log(
  `[verify-electron-abi] better-sqlite3 (SQLite ${output.sqlite}) loads under Electron ${output.electron} ` +
  `(ABI ${output.abi}) from ${path.relative(betterSqliteDir, output.binary)}.`
)
