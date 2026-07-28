import type { Runner } from './driver/runner'

const GIT_LOCK_MAX_ATTEMPTS = 10
const GIT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

export class GitLockedError extends Error {
  readonly code = 'GIT_LOCKED' as const
  readonly lockPath: string | null

  constructor(message: string, lockPath: string | null) {
    super(message)
    this.name = 'GitLockedError'
    this.lockPath = lockPath
  }
}

export class GitCommandError extends Error {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null

  constructor(message: string, stdout: string, stderr: string, exitCode: number | null) {
    super(message)
    this.name = 'GitCommandError'
    this.stdout = stdout
    this.stderr = stderr
    this.exitCode = exitCode
  }
}

export function extractLockPathFromStderr(stderr: string): string | null {
  if (!stderr) return null
  if (!/index\.lock|Another git process seems to be running|cannot lock ref|Unable to create .*\.lock/i.test(stderr)) {
    return null
  }
  const quoted = stderr.match(/Unable to create\s+'([^']+\.lock)'/i) || stderr.match(/'([^']+\.lock)'/i)
  if (quoted) return quoted[1]
  if (/Another git process seems to be running/i.test(stderr)) return 'index.lock'
  const bare = stderr.match(/([^\s'"`]+\.lock)\b/i)
  return bare ? bare[1] : null
}

export interface RunGitOptions {
  maxAttempts?: number
  delay?: (milliseconds: number) => Promise<void>
}

export async function runGit(
  runner: Runner,
  workDir: string,
  args: string[],
  options: RunGitOptions = {},
): Promise<string> {
  const maxAttempts = options.maxAttempts ?? GIT_LOCK_MAX_ATTEMPTS
  const delay = options.delay ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  let lastLockPath: string | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await runner.run({
      binary: 'git',
      args,
      workDir,
      maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
    })
    if (result.exitCode === 0) return result.stdout.trimEnd()

    const lockPath = extractLockPathFromStderr(result.stderr)
      ?? extractLockPathFromStderr(result.stdout)
    if (lockPath === null) {
      throw new GitCommandError(
        result.stderr.trim() || `git exited with code ${result.exitCode}`,
        result.stdout,
        result.stderr,
        result.exitCode,
      )
    }

    lastLockPath = lockPath
    if (attempt < maxAttempts) await delay(Math.pow(attempt, 2) * 50)
  }

  throw new GitLockedError(
    `Git repository is locked${lastLockPath ? ` (${lastLockPath})` : ''}. Another git process may be running, or a previous one crashed and left a stale lock.`,
    lastLockPath,
  )
}
