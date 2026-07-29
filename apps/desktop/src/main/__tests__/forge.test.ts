import { describe, expect, it, vi } from 'vitest'
import { createForge, type ForgeDependencies } from '../forge'

const pullRequest = {
  id: 42,
  title: 'Ship it',
  status: 'open',
  sourceBranch: 'feature/ship-it',
  targetBranch: 'main',
  authorName: 'Ada',
  url: 'https://example.test/pull/42',
  creationDate: '2026-07-29T00:00:00Z',
}

function dependencies(provider: 'azure' | 'github' | null): ForgeDependencies {
  return {
    detectProvider: vi.fn(async () => provider),
    azure: {
      listPullRequests: vi.fn(async () => [pullRequest]),
      getCurrentBranchPullRequest: vi.fn(async () => pullRequest),
      createPullRequest: vi.fn(async () => pullRequest),
      checkoutPullRequest: vi.fn(async () => ({ branch: 'feature/ship-it' })),
      getPullRequestsWebUrl: vi.fn(async () => 'https://example.test/pulls'),
      getRepoWebUrl: vi.fn(async () => 'https://example.test/repo'),
    },
    github: {
      listPullRequests: vi.fn(async () => [pullRequest]),
      getCurrentBranchPullRequest: vi.fn(async () => pullRequest),
      createPullRequest: vi.fn(async () => pullRequest),
      checkoutPullRequest: vi.fn(async () => ({ branch: 'feature/ship-it' })),
      getPullRequestsWebUrl: vi.fn(async () => 'https://example.test/pulls'),
      getRepoWebUrl: vi.fn(async () => 'https://example.test/repo'),
    },
  }
}

describe('createForge', () => {
  it('binds one GitHub repository and exposes all six operations', async () => {
    const deps = dependencies('github')
    const forge = await createForge('C:/repo', undefined, undefined, deps)
    const payload = { target: 'main', title: 'Ship it' }

    await expect(forge.listPullRequests()).resolves.toEqual([pullRequest])
    await expect(forge.getCurrentBranchPullRequest('feature/ship-it')).resolves.toEqual(pullRequest)
    await expect(forge.createPullRequest(payload)).resolves.toEqual(pullRequest)
    await expect(forge.checkoutPullRequest(42)).resolves.toEqual({ branch: 'feature/ship-it' })
    await expect(forge.getPullRequestsWebUrl()).resolves.toBe('https://example.test/pulls')
    await expect(forge.getRepoWebUrl()).resolves.toBe('https://example.test/repo')

    expect(deps.detectProvider).toHaveBeenCalledOnce()
    expect(deps.detectProvider).toHaveBeenCalledWith('C:/repo', undefined, undefined)
    expect(deps.github.listPullRequests).toHaveBeenCalledWith('C:/repo', undefined, undefined)
    expect(deps.github.getCurrentBranchPullRequest).toHaveBeenCalledWith('C:/repo', 'feature/ship-it', undefined, undefined)
    expect(deps.github.createPullRequest).toHaveBeenCalledWith('C:/repo', payload, undefined, undefined)
    expect(deps.github.checkoutPullRequest).toHaveBeenCalledWith('C:/repo', 42, undefined, undefined)
    expect(deps.github.getPullRequestsWebUrl).toHaveBeenCalledWith('C:/repo', undefined, undefined)
    expect(deps.github.getRepoWebUrl).toHaveBeenCalledWith('C:/repo', undefined, undefined)
  })

  it('binds the Azure adapter selected for the repository', async () => {
    const deps = dependencies('azure')
    const forge = await createForge('C:/repo', undefined, undefined, deps)

    await forge.listPullRequests()

    expect(deps.azure.listPullRequests).toHaveBeenCalledWith('C:/repo', undefined, undefined)
    expect(deps.github.listPullRequests).not.toHaveBeenCalled()
  })

  it('rejects a repository whose hosting provider cannot be determined', async () => {
    const deps = dependencies(null)

    await expect(createForge('C:/repo', undefined, undefined, deps)).rejects.toThrow(
      'Could not determine Git hosting provider from the repository remotes',
    )
  })
})
