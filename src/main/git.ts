import { execFile } from 'child_process'
import { promisify } from 'util'
import { simpleQuery } from './claude-sdk'
import { SshConfig, WslConfig, GitBranches } from '../shared/types'
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

async function git(cwd: string, args: string[], ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<string> {
  const gitCmd = `git ${args.map(a => "'" + a.replace(/'/g, "'\\''") + "'").join(' ')}`
  if (ssh) {
    return sshExec(ssh, cwd, gitCmd)
  }
  if (wsl) {
    return wslExec(wsl, cwd, gitCmd)
  }
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 })
  return stdout.trimEnd()
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
    try {
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

    return { branch, ahead, behind, additions, deletions, files }
  } catch (err) {
    console.error(`[git:status] failed (${via}) for ${repoPath}:`, err)
    return null
  }
}

export async function commitChanges(repoPath: string, message: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<void> {
  await git(repoPath, ['commit', '-m', message], ssh, wsl)
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
  await git(repoPath, ['push'], ssh, wsl)
  return { pushed: true }
}

export async function gitPull(repoPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<{ pulled: true }> {
  await git(repoPath, ['pull'], ssh, wsl)
  return { pulled: true }
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
