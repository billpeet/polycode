import { describe, expect, it } from 'vitest'
import {
  createWorktreeBranchName,
  isWorktreeDirectoryCleanupError,
  parseGitWorktreeList,
} from '../project-admin'

describe('createWorktreeBranchName', () => {
  it('uses only the opaque worktree id under the polycode namespace', () => {
    expect(createWorktreeBranchName(1_234_567_890)).toBe('polycode/kf12oi')
  })
})

describe('parseGitWorktreeList', () => {
  it('parses normal and prunable records from nul-delimited porcelain output', () => {
    const output = [
      'worktree C:/repo', 'HEAD abc', 'branch refs/heads/main', '',
      'worktree C:/repo-worktrees/feature', 'HEAD def', 'branch refs/heads/feature', '',
      'worktree C:/repo-worktrees/stale', 'HEAD 000', 'prunable gitdir file points to non-existent location', '',
    ].join('\0')

    expect(parseGitWorktreeList(output)).toEqual([
      { path: 'C:/repo', prunable: false },
      { path: 'C:/repo-worktrees/feature', prunable: false },
      { path: 'C:/repo-worktrees/stale', prunable: true },
    ])
  })
})

describe('isWorktreeDirectoryCleanupError', () => {
  it('recognizes Windows filename-too-long failures from git worktree removal', () => {
    expect(isWorktreeDirectoryCleanupError(
      new Error("error: failed to delete 'C:/repo-worktrees/main': Filename too long"),
    )).toBe(true)
  })

  it('does not hide unrelated git worktree removal failures', () => {
    expect(isWorktreeDirectoryCleanupError(
      new Error("error: failed to delete 'C:/repo-worktrees/main': Input/output error"),
    )).toBe(false)
  })
})
