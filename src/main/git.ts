import { execFile } from 'child_process'
import { promisify } from 'util'
import { simpleQuery } from './claude-sdk'

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

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 })
  return stdout.trim()
}

export async function getGitStatus(repoPath: string): Promise<GitStatus | null> {
  try {
    // Branch name
    let branch = 'HEAD'
    try {
      branch = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    } catch {
      // detached HEAD or not a git repo
    }

    // Ahead/behind against upstream
    let ahead = 0
    let behind = 0
    try {
      const ab = await git(repoPath, ['rev-list', '--left-right', '--count', '@{u}...HEAD'])
      const parts = ab.split('\t')
      behind = parseInt(parts[0] ?? '0', 10) || 0
      ahead = parseInt(parts[1] ?? '0', 10) || 0
    } catch {
      // no upstream set
    }

    // File statuses (porcelain v1)
    const porcelain = await git(repoPath, ['status', '--porcelain', '-z'])

    const files: GitFileChange[] = []
    if (porcelain) {
      // -z uses NUL separators; entries are: "XY PATH\0" or "XY PATH\0ORIGPATH\0"
      const entries = porcelain.split('\0').filter(Boolean)
      let i = 0
      while (i < entries.length) {
        const entry = entries[i]
        if (!entry || entry.length < 4) { i++; continue }
        // Format: "XY PATH" where XY is 2 chars, then space, then path
        // Use regex to reliably extract parts
        const match = entry.match(/^(.)(.) (.+)$/)
        if (!match) { i++; continue }
        const [, stagedCode, unstagedCode, filePath] = match

        const isRename = stagedCode === 'R' || unstagedCode === 'R'

        if (isRename) {
          const oldPath = entries[i + 1] ?? ''
          files.push({ status: 'R', path: filePath, oldPath, staged: stagedCode === 'R' })
          i += 2
        } else {
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
          i++
        }
      }
    }

    // Diff stats (staged + unstaged combined)
    let additions = 0
    let deletions = 0
    try {
      const diffStat = await git(repoPath, ['diff', '--numstat', 'HEAD'])
      for (const line of diffStat.split('\n').filter(Boolean)) {
        const parts = line.split('\t')
        additions += parseInt(parts[0] ?? '0', 10) || 0
        deletions += parseInt(parts[1] ?? '0', 10) || 0
      }
    } catch {
      // no commits yet
    }

    return { branch, ahead, behind, additions, deletions, files }
  } catch {
    return null
  }
}

export async function commitChanges(repoPath: string, message: string): Promise<void> {
  await git(repoPath, ['commit', '-m', message])
}

export async function stageFile(repoPath: string, filePath: string): Promise<void> {
  await git(repoPath, ['add', '--', filePath])
}

export async function unstageFile(repoPath: string, filePath: string): Promise<void> {
  // Use restore --staged which works for both tracked and untracked files
  await git(repoPath, ['restore', '--staged', '--', filePath])
}

export async function stageAll(repoPath: string): Promise<void> {
  await git(repoPath, ['add', '-A'])
}

export async function unstageAll(repoPath: string): Promise<void> {
  await git(repoPath, ['restore', '--staged', '.'])
}

export async function generateCommitMessage(repoPath: string): Promise<string> {
  // Get the diff of staged changes
  let diff = ''
  try {
    diff = await git(repoPath, ['diff', '--cached'])
  } catch {
    // No staged changes
  }

  if (!diff.trim()) {
    // If no staged changes, get diff of all changes
    try {
      diff = await git(repoPath, ['diff'])
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
