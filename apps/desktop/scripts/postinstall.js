#!/usr/bin/env node
/**
 * postinstall.js
 *
 * Runs under pnpm's project-managed Node 22 after `pnpm install` to ensure the
 * Electron binary is present. Since Electron 42 the `electron` package no longer
 * downloads itself in a postinstall script, so this runs its install.js
 * explicitly.
 *
 * better-sqlite3 needs nothing here: from v13 it ships N-API prebuilds that load
 * under both the host Node (tests) and Electron, independent of Electron's ABI.
 *
 * The managed runtime matters: newer host Node versions can exit during Electron
 * extraction without an error and leave the package without path.txt.
 */

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

// Resolve package directories via require.resolve rather than assuming a
// node_modules layout — the pnpm workspace uses a hoisted linker so dependencies
// live in the repo-root node_modules, not this app's own directory.
function resolvePackageDir(name) {
  try {
    return path.dirname(require.resolve(`${name}/package.json`, { paths: [__dirname] }))
  } catch {
    return null
  }
}

const electronDir = resolvePackageDir('electron')
if (!electronDir) {
  console.error('[postinstall] electron package not found — run pnpm install first.')
  process.exit(1)
}

// install.js exits immediately when dist/ already holds this exact version, and
// re-downloads when it holds a different one, so it is always safe to run.
const result = spawnSync(process.execPath, [
  path.join(electronDir, 'install.js')
], { stdio: 'inherit', cwd: electronDir })
if (result.status !== 0 || !fs.existsSync(path.join(electronDir, 'path.txt'))) {
  console.error('[postinstall] Electron install failed')
  process.exit(1)
}
console.log('[postinstall] Electron binary ready.')
