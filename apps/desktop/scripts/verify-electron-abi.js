#!/usr/bin/env node

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
const binding = path.join(betterSqliteDir, 'build', 'Release', 'better_sqlite3.node')
if (!fs.existsSync(binding)) {
  console.error(`[verify-electron-abi] Packaged binding is missing: ${binding}`)
  process.exit(1)
}

const probe = [
  "const binding = process.argv[1]",
  "require(binding)",
  "process.stdout.write(JSON.stringify({ abi: process.versions.modules, binding }))"
].join(';')
const result = spawnSync(electronExe, ['-e', probe, binding], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8'
})

if (result.status !== 0) {
  console.error('[verify-electron-abi] Packaged better-sqlite3 binding failed to load in Electron.')
  if (result.stderr) {
    const lines = result.stderr.trim().split(/\r?\n/)
    const mismatch = lines.findIndex((line) => line.includes('was compiled against a different'))
    console.error(lines.slice(mismatch >= 0 ? mismatch : -12).join('\n'))
  }
  process.exit(1)
}

let output
try {
  output = JSON.parse(result.stdout)
} catch {
  console.error('[verify-electron-abi] Electron ABI probe returned invalid output.')
  process.exit(1)
}

const expectedAbiFile = path.join(electronDir, 'abi_version')
const expectedAbi = fs.existsSync(expectedAbiFile)
  ? fs.readFileSync(expectedAbiFile, 'utf8').trim()
  : output.abi
if (output.abi !== expectedAbi) {
  console.error(
    `[verify-electron-abi] Electron reported ABI ${output.abi}; expected ${expectedAbi}.`
  )
  process.exit(1)
}

console.log(
  `[verify-electron-abi] Packaged better-sqlite3 binding loads successfully under Electron ABI ${output.abi}.`
)
