import { spawn } from 'child_process'
import { SshConfig, FileEntry, SearchableFile } from '../shared/types'

/** Escape a string for use inside single quotes in a POSIX shell. */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/** Resolve a remote path, expanding ~ to $HOME. */
function remotePathExpr(p: string): string {
  if (p.startsWith('~')) {
    return '"$HOME"' + shellEscape(p.slice(1))
  }
  return shellEscape(p)
}

/**
 * Execute a command on a remote host via SSH.
 * Returns stdout on success, throws on non-zero exit.
 */
export function sshExec(ssh: SshConfig, cwd: string, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const cdTarget = remotePathExpr(cwd)
    const innerCmd = `cd ${cdTarget} && ${cmd}`
    const remoteCmd = `bash -lc ${shellEscape(innerCmd)}`

    const sshArgs = [
      '-T',
      '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'BatchMode=yes',
    ]
    if (process.platform !== 'win32') {
      sshArgs.push(
        '-o', 'ControlMaster=auto',
        '-o', 'ControlPath=/tmp/polycode-ssh-%r@%h:%p',
        '-o', 'ControlPersist=300',
      )
    }
    if (ssh.port) sshArgs.push('-p', String(ssh.port))
    if (ssh.keyPath) sshArgs.push('-i', ssh.keyPath)
    sshArgs.push(`${ssh.user}@${ssh.host}`, remoteCmd)

    const proc = spawn('ssh', sshArgs, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim())
      } else {
        reject(new Error(stderr.trim() || `SSH command exited with code ${code}`))
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
 * List directory entries on a remote host.
 * Returns the same shape as the local `listDirectory`.
 */
export async function sshListDirectory(ssh: SshConfig, dirPath: string): Promise<FileEntry[]> {
  // List entries with type prefix: "d\tname" or "f\tname"
  // Uses find at depth 1 to get type info, skipping hidden files
  const target = remotePathExpr(dirPath)
  const cmd = `find ${target} -maxdepth 1 -mindepth 1 \\( -name '.*' ! -name '.env' \\) -prune -o -print0 2>/dev/null` +
    ` | xargs -0 -I{} sh -c 'if [ -d "{}" ]; then echo "d\t$(basename "{}")"; else echo "f\t$(basename "{}")"; fi'`

  let output: string
  try {
    // Run the find command directly (not relative to cwd)
    output = await sshExec(ssh, dirPath, cmd)
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
    const name = line.slice(tab + 1)
    if (!name) continue

    const isDirectory = type === 'd'
    if (isDirectory && IGNORED_DIRS.has(name)) continue

    // Build remote path — handle trailing slash
    const entryPath = dirPath.endsWith('/') ? dirPath + name : dirPath + '/' + name

    entries.push({ name, path: entryPath, isDirectory })
  }

  // Sort: directories first, then alphabetically
  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

/**
 * Read file content from a remote host.
 * Returns null if the file can't be read.
 */
export async function sshReadFileContent(
  ssh: SshConfig,
  filePath: string
): Promise<{ content: string; truncated: boolean } | null> {
  const MAX_FILE_SIZE = 1048576 // 1MB
  const target = remotePathExpr(filePath)

  try {
    // Check file size first
    const sizeStr = await sshExec(ssh, '/', `wc -c < ${target}`)
    const size = parseInt(sizeStr.trim(), 10) || 0

    if (size > MAX_FILE_SIZE) {
      const content = await sshExec(ssh, '/', `head -c ${MAX_FILE_SIZE} ${target}`)
      return { content, truncated: true }
    }

    const content = await sshExec(ssh, '/', `cat ${target}`)
    return { content, truncated: false }
  } catch {
    return null
  }
}

/**
 * List all files recursively on a remote host for fuzzy search.
 */
export async function sshListAllFiles(ssh: SshConfig, rootPath: string): Promise<SearchableFile[]> {
  const MAX_SEARCH_FILES = 5000
  const target = remotePathExpr(rootPath)

  // Build find exclusions
  const excludes = Array.from(IGNORED_DIRS)
    .map(d => `-name ${shellEscape(d)} -prune`)
    .join(' -o ')

  // Find files and directories, excluding ignored dirs and hidden files, limit output
  // -printf '%y\t%p\n' outputs type char ('f' or 'd') then tab then full path
  const cmd = `find ${target} -mindepth 1 \\( ${excludes} \\) -prune -o \\( \\( -type f -o -type d \\) ! -name '.*' -printf '%y\\t%p\\n' \\) 2>/dev/null | head -n ${MAX_SEARCH_FILES}`

  let output: string
  try {
    output = await sshExec(ssh, '/', cmd)
  } catch {
    return []
  }

  if (!output) return []

  // Normalize root path for relative path computation
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
