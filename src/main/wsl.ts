import { spawn } from 'child_process'
import { WslConfig, FileEntry, SearchableFile } from '../shared/types'
import { shellEscape, cdTarget } from './driver/runner'

/**
 * Execute a command inside a WSL distribution.
 * Returns stdout on success, throws on non-zero exit.
 */
export function wslExec(wsl: WslConfig, cwd: string, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const innerCmd = `cd ${cdTarget(cwd)} && ${cmd}`

    const proc = spawn('wsl', ['-d', wsl.distro, '--', 'bash', '-lc', innerCmd], {
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
 * Returns the same shape as the local `listDirectory`.
 */
export async function wslListDirectory(wsl: WslConfig, dirPath: string): Promise<FileEntry[]> {
  const target = cdTarget(dirPath)
  const cmd = `find ${target} -maxdepth 1 -mindepth 1 \\( -name '.*' ! -name '.env' \\) -prune -o -printf '%y\\t%f\\n' 2>/dev/null`

  let output: string
  try {
    output = await wslExec(wsl, dirPath, cmd)
  } catch {
    return []
  }

  if (!output) return []

  const entries: FileEntry[] = []
  for (const line of output.split('\n')) {
    if (!line) continue
    const tab = line.indexOf('\t')
    if (tab === -1) continue
    const type = line.slice(0, tab)
    const name = line.slice(tab + 1).replace(/\r$/, '')
    if (!name) continue

    const isDirectory = type === 'd'
    if (isDirectory && IGNORED_DIRS.has(name)) continue

    const entryPath = dirPath.endsWith('/') ? dirPath + name : dirPath + '/' + name

    entries.push({ name, path: entryPath, isDirectory })
  }

  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

/**
 * Read file content from inside a WSL distribution.
 * Returns null if the file can't be read.
 */
export async function wslReadFileContent(
  wsl: WslConfig,
  filePath: string
): Promise<{ content: string; truncated: boolean } | null> {
  const MAX_FILE_SIZE = 1048576 // 1MB
  const target = cdTarget(filePath)

  try {
    const sizeStr = await wslExec(wsl, '/', `wc -c < ${target}`)
    const size = parseInt(sizeStr.trim(), 10) || 0

    if (size > MAX_FILE_SIZE) {
      const content = await wslExec(wsl, '/', `head -c ${MAX_FILE_SIZE} ${target}`)
      return { content, truncated: true }
    }

    const content = await wslExec(wsl, '/', `cat ${target}`)
    return { content, truncated: false }
  } catch {
    return null
  }
}

/**
 * List all files recursively inside a WSL distribution for fuzzy search.
 */
export async function wslListAllFiles(wsl: WslConfig, rootPath: string): Promise<SearchableFile[]> {
  const MAX_SEARCH_FILES = 5000
  const target = cdTarget(rootPath)

  const excludes = Array.from(IGNORED_DIRS)
    .map(d => `-name ${shellEscape(d)} -prune`)
    .join(' -o ')

  // -printf '%y\t%p\n' outputs type char ('f' or 'd') then tab then full path
  const cmd = `find ${target} -mindepth 1 \\( ${excludes} \\) -prune -o \\( \\( -type f -o -type d \\) ! -name '.*' -printf '%y\\t%p\\n' \\) 2>/dev/null | head -n ${MAX_SEARCH_FILES}`

  let output: string
  try {
    output = await wslExec(wsl, '/', cmd)
  } catch {
    return []
  }

  if (!output) return []

  const normalizedRoot = rootPath.endsWith('/') ? rootPath : rootPath + '/'

  const results: SearchableFile[] = []
  for (const line of output.split('\n')) {
    if (!line) continue
    const tabIdx = line.indexOf('\t')
    if (tabIdx === -1) continue
    const type = line[0]
    const fullPath = line.slice(tabIdx + 1)
    const relativePath = fullPath.startsWith(normalizedRoot)
      ? fullPath.slice(normalizedRoot.length)
      : fullPath
    const name = relativePath.split('/').pop() ?? relativePath
    results.push({ path: fullPath, relativePath, name, isDirectory: type === 'd' })
  }

  return results
}
