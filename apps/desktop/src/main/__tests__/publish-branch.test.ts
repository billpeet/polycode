import { describe, expect, it, vi } from 'vitest'
import {
  PublishBranchError,
  publishBranch,
  type PublishBranchDependencies,
} from '../publish-branch'

function dependencies(): PublishBranchDependencies {
  return {
    inspect: async () => ({
      branch: 'main',
      dirty: true,
      ahead: 0,
      hasUpstream: true,
    }),
    createBranch: async () => undefined,
    stageAll: async () => undefined,
    commit: async () => 'commit-abc',
    push: async () => {
      throw new Error('remote rejected the push')
    },
    createPullRequest: async () => {
      throw new Error('must not create a pull request after a failed push')
    },
  }
}

describe('publishBranch', () => {
  it('reports durable effects without rolling back when push fails after committing', async () => {
    const deps = dependencies()

    await expect(publishBranch({
      repoPath: 'C:/repo',
      targetBranch: 'main',
      title: 'Ship it',
      newBranchName: 'feature/ship-it',
      commitMessage: 'Ship it',
    }, deps)).rejects.toEqual(new PublishBranchError(
      'push',
      {
        branchCreated: 'feature/ship-it',
        commitCreated: 'commit-abc',
        pushed: false,
      },
      'remote rejected the push',
    ))
  })

  it('re-inspects durable state so retry creates only the pull request', async () => {
    const deps = dependencies()
    deps.inspect = async () => ({
      branch: 'feature/ship-it',
      dirty: false,
      ahead: 0,
      hasUpstream: true,
    })
    deps.createBranch = vi.fn(async () => undefined)
    deps.stageAll = vi.fn(async () => undefined)
    deps.commit = vi.fn(async () => 'unexpected')
    deps.push = vi.fn(async () => undefined)
    deps.createPullRequest = async () => ({
      id: 42,
      title: 'Ship it',
      status: 'open',
      sourceBranch: 'feature/ship-it',
      targetBranch: 'main',
      authorName: 'Ada',
      url: 'https://example.test/pull/42',
      creationDate: '2026-07-29T00:00:00Z',
    })

    await expect(publishBranch({
      repoPath: 'C:/repo',
      targetBranch: 'main',
      title: 'Ship it',
      newBranchName: 'feature/ship-it',
      commitMessage: 'Ship it',
    }, deps)).resolves.toMatchObject({
      ok: true,
      pullRequest: { id: 42 },
      effects: { pushed: false },
    })
    expect(deps.createBranch).not.toHaveBeenCalled()
    expect(deps.stageAll).not.toHaveBeenCalled()
    expect(deps.commit).not.toHaveBeenCalled()
    expect(deps.push).not.toHaveBeenCalled()
  })

  it('rejects missing branch intent before mutating the default branch', async () => {
    const deps = dependencies()
    deps.createBranch = vi.fn(async () => undefined)
    deps.stageAll = vi.fn(async () => undefined)

    await expect(publishBranch({
      repoPath: 'C:/repo',
      targetBranch: 'main',
      title: 'Ship it',
      commitMessage: 'Ship it',
    }, deps)).rejects.toMatchObject({
      failedAt: 'inspect',
      message: 'A new branch name is required when publishing from the target branch',
    })
    expect(deps.createBranch).not.toHaveBeenCalled()
    expect(deps.stageAll).not.toHaveBeenCalled()
  })
})
