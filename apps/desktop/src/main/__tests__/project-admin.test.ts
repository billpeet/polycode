import { describe, expect, it } from 'vitest'
import { isWorktreeDirectoryCleanupError } from '../project-admin'

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
