import { spawn, execFileSync } from 'child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { WslConfig, FileEntry, SearchableFile } from '../shared/types'
import { cdTarget } from './driver/runner'

// Cache resolved WSL home directories per distro
const wslHomeCache = new Map<string, string>()

/**
 * Resolve the home directory for a WSL distribution.
 * Queries the passwd database inside WSL and caches the result.
 */
function getWslHome(wsl: WslConfig): string {
  const cached = wslHomeCache.get(wsl.distro)
  if (cached) return cached

  try {
    // Use getent to read the passwd database directly — avoids the Windows HOME
    // env var that WSL inherits, which would resolve ~ to the wrong directory.
    const home = execFileSync('wsl', ['-d', wsl.distro, '-e', 'bash', '-c',
      'getent passwd $(whoami) | cut -d: -f6'], {
      encoding: 'utf8', timeout: 5000,
    }).trim()
    if (home) {
      wslHomeCache.set(wsl.distro, home)
      return home
    }
  } catch { /* fall through */ }

  // Fallback: can't resolve ~, return /root as best guess
  const fallback = '/root'
  wslHomeCache.set(wsl.distro, fallback)
  return fallback
}

/**
 * Convert a WSL Linux path to a Windows UNC path via \\wsl.localhost.
 * Handles tilde (~) expansion by resolving the WSL user's home directory.
 * Uses forward slashes which Node.js on Windows handles correctly for UNC paths.
 * e.g. /home/user/project → //wsl.localhost/Ubuntu/home/user/project
 */
function wslToUncPath(wsl: WslConfig, linuxPath: string): string {
  let resolved = linuxPath
  if (resolved.startsWith('~/') || resolved === '~') {
    const home = getWslHome(wsl)
    resolved = resolved === '~' ? home : home + resolved.slice(1)
  }
  return `//wsl.localhost/${wsl.distro}${resolved}`
}

/**
 * Execute a command inside a WSL distribution.
 * Returns stdout on success, throws on non-zero exit.
 *
 * Uses bash -ilc (interactive + login) so .bashrc runs in full, giving the
 * user's real PATH. Without -i, bash skips .bashrc and Windows tools on
 * /mnt/c/ shadow Linux ones.
 */
export function wslExec(wsl: WslConfig, cwd: string, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const innerCmd = `cd ${cdTarget(cwd)} && ${cmd}`

    const proc = spawn('wsl', ['-d', wsl.distro, '--', 'bash', '-ilc', innerCmd], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    proc.on('close', (code) => {
      if (code === 0) {
        // Preserve leading whitespace (needed by parsers like git porcelain),
        // while removing trailing newlines from command output.
        resolve(stdout.trimEnd())
      } else {
        reject(new Error(stderr.trim() || `WSL command exited with code ${code}`))
      }
    })

    proc.on('error', (err) => {
      reject(err)
    })
  })
}

// ── Ignored directories (mirrors src/main/files.ts) ─────────────────────────

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.next', '.vite', '__pycache__', '.cache',
  'dist', 'build', 'out', '.vscode', '.idea', 'coverage', '.nyc_output',
])

/**
 * List directory entries inside a WSL distribution.
 * Accesses the WSL filesystem via \\wsl.localhost UNC path.
 * Returns the same shape as the local `listDirectory`.
 */
export function wslListDirectory(wsl: WslConfig, dirPath: string): FileEntry[] {
  const uncPath = wslToUncPath(wsl, dirPath)
  try {
    const entries = fs.readdirSync(uncPath, { withFileTypes: true })
    const result: FileEntry[] = []

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env') continue
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue

      const entryPath = dirPath.endsWith('/') ? dirPath + entry.name : dirPath + '/' + entry.name
      result.push({ name: entry.name, path: entryPath, isDirectory: entry.isDirectory() })
    }

    return result.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
  } catch {
    return []
  }
}

/**
 * Read file content from inside a WSL distribution.
 * Accesses the WSL filesystem via \\wsl.localhost UNC path.
 * Returns null if the file can't be read.
 */
export function wslReadFileContent(
  wsl: WslConfig,
  filePath: string
): { content: string; truncated: boolean } | null {
  const MAX_FILE_SIZE = 1048576 // 1MB
  const uncPath = wslToUncPath(wsl, filePath)

  try {
    const stats = fs.statSync(uncPath)
    if (stats.size > MAX_FILE_SIZE) {
      const fd = fs.openSync(uncPath, 'r')
      const buffer = Buffer.alloc(MAX_FILE_SIZE)
      fs.readSync(fd, buffer, 0, MAX_FILE_SIZE, 0)
      fs.closeSync(fd)
      return { content: buffer.toString('utf8'), truncated: true }
    }
    return { content: fs.readFileSync(uncPath, 'utf8'), truncated: false }
  } catch {
    return null
  }
}

/**
 * List all files recursively inside a WSL distribution for fuzzy search.
 * Accesses the WSL filesystem via \\wsl.localhost UNC path.
 */
export function wslListAllFiles(wsl: WslConfig, rootPath: string): SearchableFile[] {
  const MAX_SEARCH_FILES = 5000
  const uncRoot = wslToUncPath(wsl, rootPath)
  const results: SearchableFile[] = []

  function walk(uncDir: string, linuxDir: string): void {
    if (results.length >= MAX_SEARCH_FILES) return

    try {
      const entries = fs.readdirSync(uncDir, { withFileTypes: true })

      for (const entry of entries) {
        if (results.length >= MAX_SEARCH_FILES) break
        if (entry.name.startsWith('.') && !entry.name.startsWith('.env')) continue

        const entryLinuxPath = linuxDir.endsWith('/') ? linuxDir + entry.name : linuxDir + '/' + entry.name
        const entryUncPath = path.join(uncDir, entry.name)

        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue
          const relativePath = entryLinuxPath.startsWith(rootPath + '/')
            ? entryLinuxPath.slice(rootPath.length + 1)
            : entryLinuxPath.startsWith(rootPath)
              ? entryLinuxPath.slice(rootPath.length)
              : entryLinuxPath
          results.push({ path: entryLinuxPath, relativePath, name: entry.name, isDirectory: true })
          walk(entryUncPath, entryLinuxPath)
        } else {
          const relativePath = entryLinuxPath.startsWith(rootPath + '/')
            ? entryLinuxPath.slice(rootPath.length + 1)
            : entryLinuxPath.startsWith(rootPath)
              ? entryLinuxPath.slice(rootPath.length)
              : entryLinuxPath
          results.push({ path: entryLinuxPath, relativePath, name: entry.name })
        }
      }
    } catch {
      // Permission denied or other error - skip this directory
    }
  }

  walk(uncRoot, rootPath)
  return results
}
