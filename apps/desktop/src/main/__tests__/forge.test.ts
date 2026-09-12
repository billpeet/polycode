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
      enrichPullRequests: vi.fn(async (_repoPath, prs) => prs),
      getCurrentBranchPullRequest: vi.fn(async () => pullRequest),
      createPullRequest: vi.fn(async () => pullRequest),
      checkoutPullRequest: vi.fn(async () => ({ branch: 'feature/ship-it' })),
      getPullRequestsWebUrl: vi.fn(async () => 'https://example.test/pulls'),
      getRepoWebUrl: vi.fn(async () => 'https://example.test/repo'),
    },
    github: {
      listPullRequests: vi.fn(async () => [pullRequest]),
      enrichPullRequests: vi.fn(async (_repoPath, prs) => prs),
      getCurrentBranchPullRequest: vi.fn(async () => pullRequest),
      createPullRequest: vi.fn(async () => pullRequest),
      checkoutPullRequest: vi.fn(async () => ({ branch: 'feature/ship-it' })),
      getPullRequestsWebUrl: vi.fn(async () => 'https://example.test/pulls'),
      getRepoWebUrl: vi.fn(async () => 'https://example.test/repo'),
    },
  }
}

describe('createForge', () => {
  it('shares matching enrichment requests but preserves different input snapshots', async () => {
    const deps = dependencies('azure')
    const first = await createForge('/repo', null, null, deps)
    const second = await createForge('/repo', null, null, deps)
    const updated = { ...pullRequest, title: 'Updated' }
    const results = await Promise.all([
      first.enrichPullRequests([pullRequest]), second.enrichPullRequests([{ ...pullRequest }]),
      first.enrichPullRequests([updated]),
    ])
    expect(deps.azure.enrichPullRequests).toHaveBeenCalledTimes(2)
    expect(results[2]).toEqual([updated])
    await first.enrichPullRequests([pullRequest])
    expect(deps.azure.enrichPullRequests).toHaveBeenCalledTimes(3)
  })

  it('invalidates PR reads after creation and checkout without coalescing mutations', async () => {
    const deps = dependencies('github')
    const forge = await createForge('/repo', null, null, deps)
    await forge.listPullRequests()
    await forge.getCurrentBranchPullRequest('feature')
    await Promise.all([1, 2].map(() => forge.createPullRequest({ target: 'main', title: 'New' })))
    expect(deps.github.createPullRequest).toHaveBeenCalledTimes(2)
    await forge.listPullRequests()
    await forge.getCurrentBranchPullRequest('feature')
    expect(deps.github.listPullRequests).toHaveBeenCalledTimes(2)
    expect(deps.github.getCurrentBranchPullRequest).toHaveBeenCalledTimes(2)
    await forge.checkoutPullRequest(42)
    await forge.listPullRequests()
    expect(deps.github.listPullRequests).toHaveBeenCalledTimes(3)
  })

  it('binds one GitHub repository and exposes every operation', async () => {
    const deps = dependencies('github')
    const forge = await createForge('C:/repo', undefined, undefined, deps)
    const payload = { target: 'main', title: 'Ship it' }

    await expect(forge.listPullRequests()).resolves.toEqual([pullRequest])
    await expect(forge.enrichPullRequests([pullRequest])).resolves.toEqual([pullRequest])
    await expect(forge.getCurrentBranchPullRequest('feature/ship-it')).resolves.toEqual(pullRequest)
    await expect(forge.createPullRequest(payload)).resolves.toEqual(pullRequest)
    await expect(forge.checkoutPullRequest(42)).resolves.toEqual({ branch: 'feature/ship-it' })
    await expect(forge.getPullRequestsWebUrl()).resolves.toBe('https://example.test/pulls')
    await expect(forge.getRepoWebUrl()).resolves.toBe('https://example.test/repo')

    expect(deps.detectProvider).toHaveBeenCalledOnce()
    expect(deps.detectProvider).toHaveBeenCalledWith('C:/repo', undefined, undefined)
    expect(deps.github.listPullRequests).toHaveBeenCalledWith('C:/repo', undefined, undefined)
    expect(deps.github.enrichPullRequests).toHaveBeenCalledWith('C:/repo', [pullRequest], undefined, undefined)
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
