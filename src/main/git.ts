import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fsPromises } from 'fs'
import * as path from 'path'
import { simpleQuery } from './claude-sdk'
import { SshConfig, WslConfig, GitBranches, LastCommitInfo, StashEntry, PullResult, CommitLogEntry } from '../shared/types'
import { sshExec } from './ssh'
import { wslExec } from './wsl'

const execFileAsync = promisify(execFile)

export interface GitFileChange {
  status: 'M' | 'A' | 'D' | 'R' | 'U' | '?'
  path: string
  oldPath?: string // for renames
  staged: boolean
}

export interface GitStatus {
  branch: string
  ahead: number
  behind: number
  additions: number
  deletions: number
  files: GitFileChange[]
}

export type GitHostingProvider = 'azure' | 'github'

function parseNameStatus(output: string): GitFileChange[] {
  if (!output) return []
  const files: GitFileChange[] = []
  const lines = output.split(/\r?\n/).filter(Boolean)
  for (const line of lines) {
    const parts = line.split('\t')
    const rawStatus = parts[0] ?? ''
    const status = rawStatus[0]
    if (!status || !['M', 'A', 'D', 'R', 'U', '?'].includes(status)) continue
    if (status === 'R') {
      const oldPath = parts[1]
      const newPath = parts[2]
      if (!newPath) continue
      files.push({ status: 'R', path: newPath, oldPath, staged: false })
      continue
    }
    const path = parts[1]
    if (!path) continue
    files.push({ status, path, staged: false })
  }
  return files
}

/**
 * Error thrown when git repeatedly fails because another process holds the repo lock.
 * The `lockPath` (when known) points at the offending `.git/*.lock` file so the UI can
 * offer a "Force Unlock" action. Inspired by VS Code's `RepositoryIsLocked` error code.
 */
export class GitLockedError extends Error {
  code = 'GIT_LOCKED' as const
  lockPath: string | null
  constructor(message: string, lockPath: string | null = null) {
    super(message)
    this.name = 'GitLockedError'
    this.lockPath = lockPath
  }
}

/**
 * Pattern-match git stderr for lock-contention errors. Covers the three common flavours:
 *  - `fatal: Unable to create '<repo>/.git/index.lock': File exists.`
 *  - `Another git process seems to be running in this repository, e.g. an editor …`
 *  - `fatal: cannot lock ref 'refs/heads/foo': Unable to create '<…>/foo.lock': File exists.`
 */
function extractLockPathFromStderr(stderr: string): string | null {
  if (!stderr) return null
  if (!/index\.lock|Another git process seems to be running|cannot lock ref|Unable to create .*\.lock/i.test(stderr)) {
    return null
  }
  // Prefer the exact lock path when git names it (quoted form is most reliable).
  const quoted = stderr.match(/Unable to create\s+'([^']+\.lock)'/i) || stderr.match(/'([^']+\.lock)'/i)
  if (quoted) return quoted[1]
  if (/Another git process seems to be running/i.test(stderr)) return 'index.lock'
  const bare = stderr.match(/([^\s'"`]+\.lock)\b/i)
  return bare ? bare[1] : null
}

/** True if the error thrown by one of the transport-specific git execs looks like a lock-contention failure. */
function isLockError(err: unknown): { locked: true; lockPath: string | null } | null {
  const stderr = (err as { stderr?: string } | null)?.stderr ?? ''
  const message = (err instanceof Error ? err.message : String(err ?? '')) ?? ''
  const lockPath = extractLockPathFromStderr(stderr) ?? extractLockPathFromStderr(message)
  return lockPath !== null ? { locked: true, lockPath } : null
}

const GIT_LOCK_MAX_ATTEMPTS = 10

async function git(cwd: string, args: string[], ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<string> {
  const gitCmd = `git ${args.map(a => "'" + a.replace(/'/g, "'\\''") + "'").join(' ')}`

  // Retry on lock contention with VS Code-style quadratic backoff: 50ms, 200ms, 450ms, …, ~5s.
  // This transparently rides out races between concurrent Claude sessions, the user's editor,
  // and other tooling all touching the same repo at once.
  let lastLockPath: string | null = null
  for (let attempt = 1; attempt <= GIT_LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      if (ssh) return await sshExec(ssh, cwd, gitCmd)
      if (wsl) return await wslExec(wsl, cwd, gitCmd)
      const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 })
      return stdout.trimEnd()
    } catch (err) {
      const lock = isLockError(err)
      if (!lock) throw err
      lastLockPath = lock.lockPath
      if (attempt === GIT_LOCK_MAX_ATTEMPTS) break
      const delayMs = Math.pow(attempt, 2) * 50
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw new GitLockedError(
    `Git repository is locked${lastLockPath ? ` (${lastLockPath})` : ''}. Another git process may be running, or a previous one crashed and left a stale lock.`,
    lastLockPath,
  )
}

/**
 * Well-known lock files that sit directly in `.git/`. Loose-ref locks under `refs/` are handled separately.
 */
const TOP_LEVEL_LOCK_FILES = ['index.lock', 'HEAD.lock', 'config.lock', 'shallow.lock', 'packed-refs.lock'] as const

/**
 * Forcefully remove stale `.git/*.lock` files. Use ONLY in response to an explicit user action —
 * deleting these while another git process is actively running CAN corrupt the repository.
 *
 * Covers:
 *   - top-level locks in `.git/` (index, HEAD, config, shallow, packed-refs)
 *   - loose-ref locks (`.git/refs/heads/*.lock`, `.git/refs/tags/*.lock`, etc.)
 *
 * Returns the list of files that were removed (relative to `.git/`) so the UI can report outcome.
 */
export async function forceUnlockRepo(
  repoPath: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<{ removed: string[] }> {
  if (ssh || wsl) {
    // Remote: use a tiny shell script that lists each removed lock so we can report it.
    // `rev-parse --git-dir` succeeds even when the index is locked, since it doesn't touch the index.
    const script = [
      'GITDIR=$(git rev-parse --git-dir)',
      'cd "$GITDIR"',
      // Top-level locks
      'for f in index.lock HEAD.lock config.lock shallow.lock packed-refs.lock; do',
      '  if [ -f "$f" ]; then echo "$f"; rm -f "$f"; fi',
      'done',
      // Loose-ref locks under refs/
      'if [ -d refs ]; then find refs -type f -name "*.lock" -print -delete 2>/dev/null || true; fi',
    ].join(' && ')
    const out = ssh
      ? await sshExec(ssh, repoPath, script)
      : await wslExec(wsl!, repoPath, script)
    const removed = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    return { removed }
  }

  // Local: resolve `.git` via git itself (works with worktrees and submodules), then unlink files directly.
  const gitDirRel = (await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: repoPath, maxBuffer: 1024 * 1024 })).stdout.trim()
  const gitDir = path.isAbsolute(gitDirRel) ? gitDirRel : path.join(repoPath, gitDirRel)
  const removed: string[] = []

  for (const name of TOP_LEVEL_LOCK_FILES) {
    const full = path.join(gitDir, name)
    try {
      await fsPromises.unlink(full)
      removed.push(name)
    } catch (err) {
      // ENOENT is the normal case — the lock just isn't there.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  // Walk `.git/refs/` for any `*.lock` files left behind by a crashed `update-ref`.
  const refsDir = path.join(gitDir, 'refs')
  async function walkAndUnlock(dir: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof fsPromises.readdir>>
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walkAndUnlock(full)
      } else if (entry.isFile() && entry.name.endsWith('.lock')) {
        try {
          await fsPromises.unlink(full)
          removed.push(path.relative(gitDir, full).replace(/\\/g, '/'))
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        }
      }
    }
  }
  await walkAndUnlock(refsDir)

  return { removed }
}

function detectProviderFromRemoteUrl(remoteUrl: string): GitHostingProvider | null {
  const normalized = remoteUrl.trim().replace(/\.git$/i, '')
  if (!normalized) return null
  if (/github\.com[:/]/i.test(normalized)) return 'github'
  if (/dev\.azure\.com[:/]/i.test(normalized) || /visualstudio\.com[:/]/i.test(normalized)) return 'azure'
  return null
}

export async function detectGitHostingProvider(
  repoPath: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<GitHostingProvider | null> {
  const remoteNamesRaw = await git(repoPath, ['remote'], ssh, wsl)
  const remoteNames = remoteNamesRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (remoteNames.length === 0) return null

  const prioritized = remoteNames.includes('origin')
    ? ['origin', ...remoteNames.filter((name) => name !== 'origin')]
    : remoteNames

  for (const remoteName of prioritized) {
    let remoteUrl = ''
    try {
      remoteUrl = await git(repoPath, ['remote', 'get-url', remoteName], ssh, wsl)
    } catch {
      continue
    }
    const provider = detectProviderFromRemoteUrl(remoteUrl)
    if (provider) return provider
  }

  return null
}

export async function getGitBranch(repoPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<string | null> {
  try {
    return await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], ssh, wsl)
  } catch {
    return null
  }
}

export async function getGitStatus(repoPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<GitStatus | null> {
  const via = ssh ? 'ssh' : wsl ? `wsl:${wsl.distro}` : 'local'
  try {
    // Branch name
    let branch = 'HEAD'
    try {
      branch = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], ssh, wsl)
    } catch {
      // detached HEAD or not a git repo
    }

    // Ahead/behind against upstream
    let ahead = 0
    let behind = 0
    let hasUpstream = false
    try {
      const upstreamRef = (await git(repoPath, ['rev-parse', '--abbrev-ref', '@{u}'], ssh, wsl)).trim()
      // Only treat as "has upstream" when the remote branch name matches the local branch name,
      // i.e. origin/<branch>. A branch created from origin/master will have @{u}=origin/master
      // but we still need to publish it to origin/<branch>.
      hasUpstream = upstreamRef === `origin/${branch}`
      const ab = await git(repoPath, ['rev-list', '--left-right', '--count', '@{u}...HEAD'], ssh, wsl)
      const parts = ab.split('\t')
      behind = parseInt(parts[0] ?? '0', 10) || 0
      ahead = parseInt(parts[1] ?? '0', 10) || 0
    } catch {
      // no upstream set
    }

    // File statuses — use plain --porcelain (newline-separated) rather than -z
    // (NUL-terminated) to avoid a Windows/worktree bug where git produces zero
    // bytes of output to a pipe when the -z flag is used.
    // Format per line: "XY PATH" or "XY ORIG_PATH -> NEW_PATH" for renames.
    let porcelain = ''
    try {
      porcelain = await git(repoPath, ['status', '--porcelain'], ssh, wsl)
    } catch (err) {
      console.error(`[git:status] porcelain failed (${via}) for ${repoPath}:`, err)
    }

    const files: GitFileChange[] = []
    if (porcelain) {
      const lines = porcelain.split(/\r?\n/).filter(Boolean)
      for (const line of lines) {
        if (line.length < 4) continue
        const stagedCode = line[0]!
        const unstagedCode = line[1]!
        const rest = line.slice(3).trimEnd() // skip "XY ", strip Windows CR

        const isRename = stagedCode === 'R' || unstagedCode === 'R'

        if (isRename) {
          // Format: "R  ORIG_PATH -> NEW_PATH"
          const arrowIdx = rest.indexOf(' -> ')
          const newPath = arrowIdx !== -1 ? rest.slice(arrowIdx + 4) : rest
          const oldPath = arrowIdx !== -1 ? rest.slice(0, arrowIdx) : ''
          files.push({ status: 'R', path: newPath, oldPath, staged: stagedCode === 'R' })
        } else {
          const filePath = rest
          // Staged change
          if (stagedCode !== ' ' && stagedCode !== '?') {
            files.push({ status: stagedCode as GitFileChange['status'], path: filePath, staged: true })
          }
          // Unstaged change
          if (unstagedCode !== ' ' && unstagedCode !== '?') {
            files.push({ status: unstagedCode as GitFileChange['status'], path: filePath, staged: false })
          }
          // Untracked
          if (stagedCode === '?' && unstagedCode === '?') {
            files.push({ status: '?', path: filePath, staged: false })
          }
        }
      }
    }

    // Diff stats (staged + unstaged combined)
    let additions = 0
    let deletions = 0
    try {
      const diffStat = await git(repoPath, ['diff', '--numstat', 'HEAD'], ssh, wsl)
      for (const line of diffStat.split('\n').filter(Boolean)) {
        const parts = line.split('\t')
        additions += parseInt(parts[0] ?? '0', 10) || 0
        deletions += parseInt(parts[1] ?? '0', 10) || 0
      }
    } catch {
      // no commits yet
    }

    return { branch, ahead, behind, additions, deletions, files, hasUpstream }
  } catch (err) {
    console.error(`[git:status] failed (${via}) for ${repoPath}:`, err)
    return null
  }
}

export async function commitChanges(repoPath: string, message: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<void> {
  await git(repoPath, ['commit', '-m', message], ssh, wsl)
}

export async function getLastCommit(repoPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<LastCommitInfo | null> {
  try {
    const hash = (await git(repoPath, ['rev-parse', 'HEAD'], ssh, wsl)).trim()
    const subject = (await git(repoPath, ['log', '-1', '--format=%s'], ssh, wsl)).trim()
    const message = (await git(repoPath, ['log', '-1', '--format=%B'], ssh, wsl)).trimEnd()
    let hasParent = false
    try {
      await git(repoPath, ['rev-parse', '--verify', 'HEAD~1'], ssh, wsl)
      hasParent = true
    } catch { /* initial commit */ }
    return { hash, subject, message, hasParent }
  } catch {
    return null // no commits yet, or not a repo
  }
}

/**
 * Amend the last commit. Pass a new message to replace the existing one, or
 * `null`/`undefined` to keep the current message (equivalent to `--no-edit`).
 * Any staged changes at the time of call are folded into the amended commit.
 */
export async function amendCommit(repoPath: string, message: string | null | undefined, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<void> {
  if (message != null && message.length > 0) {
    await git(repoPath, ['commit', '--amend', '-m', message], ssh, wsl)
  } else {
    await git(repoPath, ['commit', '--amend', '--no-edit'], ssh, wsl)
  }
}

/**
 * Undo the last commit, keeping its changes staged in the index so the user
 * can re-commit them. Equivalent to `git reset --soft HEAD~1`.
 */
export async function undoLastCommit(repoPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<void> {
  await git(repoPath, ['reset', '--soft', 'HEAD~1'], ssh, wsl)
}

export async function stageFile(repoPath: string, filePath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<void> {
  await git(repoPath, ['add', '--', filePath], ssh, wsl)
}

export async function stageFiles(repoPath: string, filePaths: string[], ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<void> {
  if (filePaths.length === 0) return
  await git(repoPath, ['add', '--', ...filePaths], ssh, wsl)
}

export async function unstageFile(repoPath: string, filePath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<void> {
  // Use restore --staged which works for both tracked and untracked files
  await git(repoPath, ['restore', '--staged', '--', filePath], ssh, wsl)
}

export async function stageAll(repoPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<void> {
  await git(repoPath, ['add', '-A'], ssh, wsl)
}

export async function unstageAll(repoPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<void> {
  await git(repoPath, ['restore', '--staged', '.'], ssh, wsl)
}

export async function gitPush(repoPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<{ pushed: true }> {
  // Always push to origin/<local-branch-name> and set/update upstream tracking.
  // This handles: no upstream, upstream pointing to a differently-named branch (e.g. origin/master),
  // and normal repeat pushes.
  //
  // `--force-with-lease` makes amend/rebase workflows work without ever allowing a blind clobber:
  // if the remote ref has moved since our last fetch, the push is rejected rather than overwriting
  // someone else's commits. Fast-forward pushes behave identically to a plain push.
  await git(repoPath, ['push', '--force-with-lease', '--set-upstream', 'origin', 'HEAD'], ssh, wsl)
  return { pushed: true }
}

export async function gitPushSetUpstream(repoPath: string, branch: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<{ pushed: true }> {
  // See gitPush for rationale behind --force-with-lease.
  await git(repoPath, ['push', '--force-with-lease', '--set-upstream', 'origin', branch], ssh, wsl)
  return { pushed: true }
}

export async function gitPull(repoPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<{ pulled: true }> {
  await git(repoPath, ['pull'], ssh, wsl)
  return { pulled: true }
}

export async function gitPullOrigin(repoPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<{ pulled: true }> {
  await git(repoPath, ['pull', 'origin'], ssh, wsl)
  return { pulled: true }
}

/**
 * Returns true if the working tree has any uncommitted / untracked changes.
 * Uses `git status --porcelain` which outputs an empty string for a clean tree.
 */
async function hasDirtyWorkingTree(repoPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<boolean> {
  const output = await git(repoPath, ['status', '--porcelain'], ssh, wsl)
  return output.trim().length > 0
}

/**
 * Pull, optionally auto-stashing dirty changes first.
 * - If autoStash is false or the tree is clean, behaves like a plain pull.
 * - Otherwise: stash -u → pull → pop. If pop hits a conflict, the stash is left intact so the user can resolve.
 * - If the pull itself fails after stashing, we best-effort pop the stash to restore state before re-throwing.
 */
export async function gitPullWithAutoStash(repoPath: string, autoStash: boolean, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<PullResult> {
  if (!autoStash) {
    await git(repoPath, ['pull'], ssh, wsl)
    return { pulled: true, stashed: false }
  }

  const dirty = await hasDirtyWorkingTree(repoPath, ssh, wsl)
  if (!dirty) {
    await git(repoPath, ['pull'], ssh, wsl)
    return { pulled: true, stashed: false }
  }

  // Stash dirty changes (including untracked) with a recognisable label.
  const stamp = new Date().toISOString()
  const message = `polycode: auto-stash before pull @ ${stamp}`
  const stashOutput = await git(repoPath, ['stash', 'push', '-u', '-m', message], ssh, wsl)
  // Racey: another process may have staged something between the dirty-check and the stash.
  if (/No local changes to save/i.test(stashOutput)) {
    await git(repoPath, ['pull'], ssh, wsl)
    return { pulled: true, stashed: false }
  }

  try {
    await git(repoPath, ['pull'], ssh, wsl)
  } catch (err) {
    // Pull failed — restore working tree via pop so we don't leave the user stranded.
    try { await git(repoPath, ['stash', 'pop'], ssh, wsl) } catch { /* swallow; surface original error */ }
    throw err
  }

  // Pull succeeded — try to pop. If it conflicts, leave the stash for manual resolution.
  try {
    await git(repoPath, ['stash', 'pop'], ssh, wsl)
    return { pulled: true, stashed: true }
  } catch (err: unknown) {
    const output: string = (err as { stdout?: string; message?: string }).stdout ?? (err instanceof Error ? err.message : '') ?? ''
    if (/CONFLICT|conflict|could not restore untracked files/i.test(output)) {
      // Stash is still present at the top of the stack — report the ref so the UI can surface it.
      return { pulled: true, stashed: true, popConflict: true, stashRef: 'stash@{0}' }
    }
    throw err
  }
}

// ─────────── Stash ───────────

/**
 * List stash entries newest-first.
 * Format: reflog-selector TAB committer-timestamp TAB reflog-subject
 * e.g. `stash@{0}\t1700000000\tWIP on main: abc123 Subject`
 */
export async function listStashes(repoPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<StashEntry[]> {
  const output = await git(repoPath, ['stash', 'list', '--format=%gd%x09%ct%x09%gs'], ssh, wsl)
  const entries: StashEntry[] = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const [ref, tsRaw, ...subjectParts] = parts
    const subject = subjectParts.join('\t')
    const indexMatch = ref.match(/stash@\{(\d+)\}/)
    const index = indexMatch ? Number(indexMatch[1]) : -1
    const ts = Number(tsRaw)
    const createdAt = Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : new Date().toISOString()
    // Subjects take two shapes:
    //   "WIP on <branch>: <hash> <subject>"  (no -m supplied)
    //   "On <branch>: <custom message>"      (-m supplied)
    const subjectMatch = subject.match(/^(WIP )?[Oo]n ([^:]+): (.*)$/)
    const autoGenerated = !!subjectMatch?.[1]
    const branch = subjectMatch?.[2] ?? ''
    const message = subjectMatch?.[3] ?? subject
    entries.push({ ref, index, branch, message, createdAt, autoGenerated })
  }
  return entries
}

export async function createStash(repoPath: string, opts: { message?: string; includeUntracked?: boolean }, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<void> {
  const args = ['stash', 'push']
  if (opts.includeUntracked) args.push('-u')
  if (opts.message && opts.message.trim().length > 0) {
    args.push('-m', opts.message.trim())
  }
  const output = await git(repoPath, args, ssh, wsl)
  if (/No local changes to save/i.test(output)) {
    throw new Error('No local changes to stash.')
  }
}

export async function applyStash(repoPath: string, ref: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<void> {
  await git(repoPath, ['stash', 'apply', ref], ssh, wsl)
}

export async function popStash(repoPath: string, ref: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<void> {
  await git(repoPath, ['stash', 'pop', ref], ssh, wsl)
}

export async function dropStash(repoPath: string, ref: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<void> {
  await git(repoPath, ['stash', 'drop', ref], ssh, wsl)
}

export async function gitFetchRemote(repoPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<{ fetched: true }> {
  // Keep this non-interactive so periodic refreshes never block on credentials.
  await git(repoPath, ['-c', 'credential.interactive=never', 'fetch', '--all', '--prune', '--tags', '--quiet'], ssh, wsl)
  return { fetched: true }
}

export async function generateCommitMessage(repoPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<string> {
  // Get the diff of staged changes
  let diff = ''
  try {
    diff = await git(repoPath, ['diff', '--cached'], ssh, wsl)
  } catch {
    // No staged changes
  }

  if (!diff.trim()) {
    // If no staged changes, get diff of all changes
    try {
      diff = await git(repoPath, ['diff'], ssh, wsl)
    } catch {
      // No changes at all
    }
  }

  if (!diff.trim()) {
    return ''
  }

  // Truncate diff if too long (keep first ~4000 chars)
  const maxDiffLength = 4000
  const truncatedDiff = diff.length > maxDiffLength
    ? diff.slice(0, maxDiffLength) + '\n... (truncated)'
    : diff

  // Use Claude Agent SDK to generate commit message
  const prompt = `Generate a concise git commit message for the following diff. Follow conventional commit format (e.g., "feat:", "fix:", "refactor:", "docs:", "style:", "test:", "chore:"). Output ONLY the commit message, nothing else. No quotes, no explanation.

${truncatedDiff}`

  return simpleQuery(prompt)
}

export async function getFileDiff(repoPath: string, filePath: string, staged: boolean, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<string> {
  try {
    if (staged) {
      return await git(repoPath, ['diff', '--cached', '--', filePath], ssh, wsl)
    }
    // For untracked files, read the file and return as all-added pseudo-diff
    try {
      await git(repoPath, ['ls-files', '--error-unmatch', '--', filePath], ssh, wsl)
    } catch {
      // File is untracked — build a pseudo-diff
      const content = await git(repoPath, ['show', `:${filePath}`], ssh, wsl).catch(async () => {
        // Not in index either, read from working tree
        if (ssh) {
          return sshExec(ssh, repoPath, `cat '${filePath.replace(/'/g, "'\\''")}'`)
        }
        if (wsl) {
          return wslExec(wsl, repoPath, `cat '${filePath.replace(/'/g, "'\\''")}'`)
        }
        const fs = await import('fs/promises')
        const path = await import('path')
        return (await fs.readFile(path.join(repoPath, filePath), 'utf-8'))
      })
      const lines = content.split('\n')
      const header = `diff --git a/${filePath} b/${filePath}\nnew file\n--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n`
      return header + lines.map(l => `+${l}`).join('\n')
    }
    return await git(repoPath, ['diff', '--', filePath], ssh, wsl)
  } catch {
    return ''
  }
}

/**
 * Parse the output of `git log --format=<custom>` where each commit occupies a single line,
 * with fields separated by TAB. Subject (last field) is the only one that may contain spaces;
 * we deliberately omit body and anything that could contain literal TABs or newlines.
 *
 * Format string: `%H%x09%h%x09%an%x09%ae%x09%aI%x09%P%x09%s`
 *   %H  full sha         %h  short sha     %an author name
 *   %ae author email     %aI ISO date      %P  parents (space-separated)
 *   %s  subject (single line — git never emits newlines in %s)
 */
function parseCommitLog(output: string): CommitLogEntry[] {
  if (!output) return []
  const entries: CommitLogEntry[] = []
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue
    // Split with limit so any stray TABs in subject don't break the record (they shouldn't exist, but belt-and-braces).
    const parts = line.split('\t')
    if (parts.length < 7) continue
    const [sha, shortSha, authorName, authorEmail, authorDate, parentsRaw, ...subjectRest] = parts
    const subject = subjectRest.join('\t')
    const parents = parentsRaw ? parentsRaw.split(/\s+/).filter(Boolean) : []
    entries.push({ sha, shortSha, authorName, authorEmail, authorDate, parents, subject })
  }
  return entries
}

/**
 * List commits reachable from `opts.range` (default `HEAD`) in chronological (newest-first) order.
 * Pass a range like `"origin/main..HEAD"` to limit to commits on the current branch not yet on base.
 * Caps at `opts.limit` entries (default 100) to keep renderer work bounded.
 */
export async function listCommits(
  repoPath: string,
  opts: { range?: string; limit?: number } = {},
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<CommitLogEntry[]> {
  const range = opts.range ?? 'HEAD'
  const limit = opts.limit ?? 100
  // `--no-merges` was considered but VS Code's history view shows merges, so we include them too.
  // The `--` terminator prevents a range that happens to collide with a path from being parsed as one.
  const format = '%H%x09%h%x09%an%x09%ae%x09%aI%x09%P%x09%s'
  try {
    const out = await git(repoPath, ['log', `--max-count=${limit}`, `--format=${format}`, range, '--'], ssh, wsl)
    return parseCommitLog(out)
  } catch (err) {
    // A pathological range (e.g. base branch doesn't exist) should yield an empty list, not an error toast.
    const stderr = (err as { stderr?: string } | null)?.stderr ?? ''
    if (/unknown revision|not a valid object name|ambiguous argument/i.test(stderr)) return []
    throw err
  }
}

/**
 * List the files changed in a single commit, with the same status codes as our working-tree status parser.
 * For the root commit (no parent), git show emits every file as 'A'.
 */
export async function listCommitFiles(
  repoPath: string,
  sha: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<GitFileChange[]> {
  // `--format=` suppresses the commit header so only the name-status lines remain.
  const out = await git(repoPath, ['show', '--name-status', '--format=', sha], ssh, wsl)
  return parseNameStatus(out)
}

/**
 * Return the diff of a single file introduced by `sha` — i.e. the change relative to the commit's parent.
 * For root commits, git show produces an all-added diff.
 */
export async function getCommitFileDiff(
  repoPath: string,
  sha: string,
  filePath: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<string> {
  try {
    // `git show <sha> -- <path>` restricts the diff to one file; `--format=` suppresses the commit header.
    return await git(repoPath, ['show', '--format=', sha, '--', filePath], ssh, wsl)
  } catch {
    return ''
  }
}

async function resolveCompareMainRef(
  repoPath: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null
): Promise<string | null> {
  let localOut = ''
  let remoteOut = ''
  try {
    localOut = await git(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], ssh, wsl)
  } catch {
    // ignore
  }
  try {
    remoteOut = await git(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/'], ssh, wsl)
  } catch {
    // ignore
  }

  const local = new Set(localOut.split('\n').filter(Boolean))
  const remote = new Set(
    remoteOut
      .split('\n')
      .filter(Boolean)
      .map((b) => b.replace(/^origin\//, ''))
      .filter((b) => b !== 'HEAD')
  )

  const mainBranch =
    (remote.has('main') ? 'main' : null) ??
    (remote.has('master') ? 'master' : null) ??
    (local.has('main') ? 'main' : null) ??
    (local.has('master') ? 'master' : null)

  if (!mainBranch) return null

  try {
    await git(repoPath, ['fetch', 'origin', mainBranch], ssh, wsl)
  } catch {
    // continue with possibly stale refs
  }

  const baseRef = `origin/${mainBranch}`
  try {
    await git(repoPath, ['rev-parse', '--verify', baseRef], ssh, wsl)
    return baseRef
  } catch {
    return null
  }
}

export async function getCompareToMainChanges(
  repoPath: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null
): Promise<{ baseRef: string; files: GitFileChange[] }> {
  const baseRef = (await resolveCompareMainRef(repoPath, ssh, wsl)) ?? 'origin/main'
  try {
    const mergeBase = await git(repoPath, ['merge-base', baseRef, 'HEAD'], ssh, wsl)
    const out = await git(repoPath, ['diff', '--name-status', '--find-renames', mergeBase], ssh, wsl)
    return { baseRef, files: parseNameStatus(out) }
  } catch {
    return { baseRef, files: [] }
  }
}

export async function getCompareToMainFileDiff(
  repoPath: string,
  filePath: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null
): Promise<string> {
  const baseRef = (await resolveCompareMainRef(repoPath, ssh, wsl)) ?? 'origin/main'
  try {
    const mergeBase = await git(repoPath, ['merge-base', baseRef, 'HEAD'], ssh, wsl)
    return await git(repoPath, ['diff', mergeBase, '--', filePath], ssh, wsl)
  } catch {
    return ''
  }
}

/**
 * Generate a commit message using pre-built context (conversation messages + thread-modified files).
 * Gets the diff for specific files rather than relying on the agent to discover changes itself.
 */
export async function generateCommitMessageWithContext(
  repoPath: string,
  filePaths: string[],
  messagesContext: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null
): Promise<string> {
  // Get diff scoped to thread-modified files first, fall back to full diff
  let diff = ''
  try {
    if (filePaths.length > 0) {
      diff = await git(repoPath, ['diff', '--', ...filePaths], ssh, wsl)
      if (!diff.trim()) {
        diff = await git(repoPath, ['diff', '--cached', '--', ...filePaths], ssh, wsl)
      }
    }
    if (!diff.trim()) {
      diff = await git(repoPath, ['diff', '--cached'], ssh, wsl)
    }
    if (!diff.trim()) {
      diff = await git(repoPath, ['diff'], ssh, wsl)
    }
  } catch {
    // No git repo or no changes
  }

  if (!diff.trim() && !messagesContext.trim()) {
    return ''
  }

  const maxDiffLength = 4000
  const truncatedDiff = diff.length > maxDiffLength
    ? diff.slice(0, maxDiffLength) + '\n... (truncated)'
    : diff

  const contextParts: string[] = []
  if (messagesContext.trim()) {
    contextParts.push(messagesContext)
  }
  if (truncatedDiff.trim()) {
    contextParts.push(`## Git Changes\n\`\`\`diff\n${truncatedDiff}\n\`\`\``)
  }

  const prompt = `Generate a concise git commit message based on the context below. Follow conventional commit format (e.g., "feat:", "fix:", "refactor:", "docs:", "style:", "test:", "chore:"). Output ONLY the commit message, nothing else. No quotes, no explanation.

${contextParts.join('\n\n')}`

  return simpleQuery(prompt)
}

export async function listBranches(repoPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<GitBranches> {
  let current = 'HEAD'
  try {
    current = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], ssh, wsl)
  } catch {
    // detached HEAD or not a git repo
  }

  let localOut = ''
  try {
    localOut = await git(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], ssh, wsl)
  } catch {
    // no branches
  }

  let remoteOut = ''
  try {
    remoteOut = await git(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/'], ssh, wsl)
  } catch {
    // no remote refs
  }

  const local = localOut.split('\n').filter(Boolean)
  const remote = remoteOut.split('\n').filter(Boolean).filter((b) => !b.endsWith('/HEAD') && !b.includes('HEAD ->'))

  return { current, local, remote }
}

export async function checkoutBranch(repoPath: string, branch: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<void> {
  if (branch.startsWith('origin/')) {
    const localName = branch.slice('origin/'.length)
    try {
      // Try switching to an existing local branch first
      await git(repoPath, ['checkout', localName], ssh, wsl)
    } catch {
      // Create a new local tracking branch from the remote
      await git(repoPath, ['checkout', '-b', localName, '--track', branch], ssh, wsl)
    }
  } else {
    await git(repoPath, ['checkout', branch], ssh, wsl)
  }
}

export async function createBranch(repoPath: string, name: string, base: string, pullFirst: boolean, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<void> {
  if (pullFirst) {
    // Fetch the base ref from origin so we use the latest remote version
    const baseName = base.startsWith('origin/') ? base.slice('origin/'.length) : base
    const remoteName = base.startsWith('origin/') ? base : `origin/${base}`
    try {
      await git(repoPath, ['fetch', 'origin', baseName], ssh, wsl)
    } catch {
      // Ignore fetch errors — create from whatever is available
    }
    await git(repoPath, ['checkout', '-b', name, remoteName], ssh, wsl)
  } else {
    await git(repoPath, ['checkout', '-b', name, base], ssh, wsl)
  }
}

/**
 * Find local branches that have been squash-merged (or regular-merged) into the main branch.
 * Uses the git-delete-squashed technique: creates a virtual commit with the branch's tree
 * parented at the merge-base, then checks if that patch is already in origin/master|main.
 */
export async function findMergedBranches(repoPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<string[]> {
  let current = 'HEAD'
  try {
    current = (await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], ssh, wsl)).trim()
  } catch { /* ignore */ }

  let localOut = ''
  try {
    localOut = await git(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], ssh, wsl)
  } catch {
    return []
  }

  const local = localOut.split('\n').filter(Boolean)
  const mainBranch = local.find(b => b === 'master' || b === 'main') ?? 'master'
  const targetRef = `origin/${mainBranch}`

  // Fetch latest state of origin/<main> so comparisons are up-to-date
  try {
    await git(repoPath, ['fetch', 'origin', mainBranch], ssh, wsl)
  } catch { /* no remote or offline — continue with stale refs */ }

  // Verify target ref exists
  try {
    await git(repoPath, ['rev-parse', '--verify', targetRef], ssh, wsl)
  } catch {
    return []
  }

  const merged: string[] = []

  for (const branch of local) {
    if (branch === current || branch === mainBranch) continue

    try {
      // 1. Regular merge: branch tip is an ancestor of target
      try {
        await git(repoPath, ['merge-base', '--is-ancestor', branch, targetRef], ssh, wsl)
        merged.push(branch)
        continue
      } catch { /* not a regular merge */ }

      // 2. Squash merge detection (git-delete-squashed technique):
      //    Create a virtual commit whose tree is the branch's tree, parented at
      //    the merge-base. If git cherry says that patch is already in target, it
      //    was squash-merged.
      const mergeBase = (await git(repoPath, ['merge-base', targetRef, branch], ssh, wsl)).trim()
      const branchTree = (await git(repoPath, ['rev-parse', `${branch}^{tree}`], ssh, wsl)).trim()
      const tempCommit = (await git(repoPath, ['commit-tree', branchTree, '-p', mergeBase, '-m', 'temp'], ssh, wsl)).trim()
      const cherryResult = (await git(repoPath, ['cherry', targetRef, tempCommit], ssh, wsl)).trim()

      if (cherryResult.startsWith('-')) {
        merged.push(branch)
      }
    } catch { /* skip branch if any git command fails */ }
  }

  return merged
}

export async function deleteBranches(repoPath: string, branches: string[], ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<{ deleted: string[]; failed: Array<{ branch: string; error: string }> }> {
  const deleted: string[] = []
  const failed: Array<{ branch: string; error: string }> = []

  for (const branch of branches) {
    try {
      await git(repoPath, ['branch', '-D', branch], ssh, wsl)
      deleted.push(branch)
    } catch (err) {
      failed.push({ branch, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return { deleted, failed }
}

export async function gitInit(repoPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<void> {
  await git(repoPath, ['init'], ssh, wsl)
}

export async function isGitRepo(repoPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<boolean> {
  try {
    await git(repoPath, ['rev-parse', '--git-dir'], ssh, wsl)
    return true
  } catch {
    return false
  }
}

export async function getDefaultBranch(repoPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<string> {
  // Try symbolic-ref for origin/HEAD first (fast, no network)
  try {
    const ref = (await git(repoPath, ['symbolic-ref', 'refs/remotes/origin/HEAD'], ssh, wsl)).trim()
    const branch = ref.replace(/^refs\/remotes\/origin\//, '')
    if (branch && branch !== ref) return branch
  } catch {
    // not set
  }

  // Fall back to common names
  for (const candidate of ['main', 'master', 'develop', 'dev']) {
    try {
      await git(repoPath, ['rev-parse', '--verify', `origin/${candidate}`], ssh, wsl)
      return candidate
    } catch {
      // not found
    }
  }

  return 'main'
}

/**
 * Check whether the repo has any commits (i.e. HEAD is a valid ref).
 * A freshly-initialised repo has no HEAD until the first commit.
 */
async function hasHeadCommit(repoPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<boolean> {
  try {
    await git(repoPath, ['rev-parse', '--verify', 'HEAD'], ssh, wsl)
    return true
  } catch {
    return false
  }
}

async function fileExistsInHead(repoPath: string, filePath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<boolean> {
  try {
    await git(repoPath, ['cat-file', '-e', `HEAD:${filePath}`], ssh, wsl)
    return true
  } catch {
    return false
  }
}

/**
 * Discard local changes for a single file. Restores the file to HEAD state and
 * removes any staged modifications. Handles all status flavours:
 *   - Modified / Deleted / Unmerged (tracked): `git checkout HEAD -- <path>`
 *   - Newly added (staged A) or untracked (?): unstage + delete worktree copy
 *   - Rename (R): restore the old path from HEAD, delete the new path
 *
 * Irreversible — the caller is expected to confirm.
 */
export async function discardFileChanges(
  repoPath: string,
  filePath: string,
  oldPath?: string | null,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<void> {
  const headExists = await hasHeadCommit(repoPath, ssh, wsl)

  // Remove a path entirely (from index if staged, from worktree if present).
  const removePath = async (path: string): Promise<void> => {
    if (headExists) {
      // Unstage any staged changes (safe to ignore if nothing staged)
      try { await git(repoPath, ['reset', 'HEAD', '--', path], ssh, wsl) } catch { /* nothing to unstage */ }
    } else {
      // No HEAD yet — drop from index directly
      try { await git(repoPath, ['rm', '-f', '--cached', '--', path], ssh, wsl) } catch { /* not in index */ }
    }
    // Remove from working tree (respects .gitignore by default)
    try { await git(repoPath, ['clean', '-f', '--', path], ssh, wsl) } catch { /* nothing to clean */ }
  }

  // Rename: restore the old path and delete the new one.
  if (oldPath && oldPath !== filePath) {
    if (headExists && (await fileExistsInHead(repoPath, oldPath, ssh, wsl))) {
      // Unstage both sides of the rename so checkout isn't rejected
      try { await git(repoPath, ['reset', 'HEAD', '--', oldPath, filePath], ssh, wsl) } catch { /* best-effort */ }
      await git(repoPath, ['checkout', 'HEAD', '--', oldPath], ssh, wsl)
      await removePath(filePath)
      return
    }
    // Fallback — treat as an ordinary "new file" discard
    await removePath(filePath)
    return
  }

  // Tracked file (modified, deleted, unmerged): restore from HEAD.
  if (headExists && (await fileExistsInHead(repoPath, filePath, ssh, wsl))) {
    await git(repoPath, ['checkout', 'HEAD', '--', filePath], ssh, wsl)
    return
  }

  // New file (staged A) or untracked (?): unstage + delete.
  await removePath(filePath)
}

/**
 * Discard ALL local changes — equivalent to VS Code's "Discard All Changes".
 *   - `git reset --hard HEAD` wipes staged + unstaged changes on tracked files.
 *   - `git clean -fd` removes untracked files and directories (honours .gitignore).
 *
 * Irreversible — the caller is expected to confirm.
 */
export async function discardAllChanges(
  repoPath: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<void> {
  if (await hasHeadCommit(repoPath, ssh, wsl)) {
    await git(repoPath, ['reset', '--hard', 'HEAD'], ssh, wsl)
  } else {
    // No HEAD yet — empty the index so staged additions go away
    try { await git(repoPath, ['rm', '-rf', '--cached', '.'], ssh, wsl) } catch { /* index empty */ }
  }
  // Remove untracked files + directories (ignored files preserved)
  try { await git(repoPath, ['clean', '-fd'], ssh, wsl) } catch { /* nothing to clean */ }
}

export async function mergeBranch(repoPath: string, source: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<{ conflicts: string[] }> {
  try {
    await git(repoPath, ['merge', source], ssh, wsl)
    return { conflicts: [] }
  } catch (err: unknown) {
    // execFileAsync (local) attaches stdout to the error; SSH/WSL errors carry it in the message
    const output: string = (err as { stdout?: string; message?: string }).stdout ?? (err instanceof Error ? err.message : '') ?? ''
    if (output.includes('CONFLICT') || output.includes('Automatic merge failed')) {
      const conflicts: string[] = []
      for (const line of output.split('\n')) {
        const m = line.match(/CONFLICT.*?Merge conflict in (.+)/)
        if (m) conflicts.push(m[1].trim())
      }
      return { conflicts: conflicts.length > 0 ? conflicts : ['(see git status)'] }
    }
    throw err
  }
}
