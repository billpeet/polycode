import { describe, expect, it } from 'vitest'
import {
  buildAzurePullRequestUrl,
  buildAzurePullRequestsUrl,
  buildAzureRepoUrl,
  mapAzurePr,
  mapGitHubPr,
  normalizeAzureBranchName,
  parseAzureRemote,
  parseGitHubRemote,
} from '../forge-parsers'

describe('GitHub parsers', () => {
  it.each([
    ['https://github.com/acme/repo.git', { owner: 'acme', repo: 'repo' }],
    ['git@github.com:acme/repo.git', { owner: 'acme', repo: 'repo' }],
    ['ssh://git@github.com/acme/my%20repo.git', { owner: 'acme', repo: 'my repo' }],
    ['https://example.com/acme/repo', null],
  ])('parses %s', (url, expected) => {
    expect(parseGitHubRemote(url)).toEqual(expected)
  })

  it('maps defaults and normalizes status', () => {
    expect(mapGitHubPr({ number: 7, state: 'OPEN', author: { login: 'ada' } })).toMatchObject({
      id: 7,
      title: '(untitled)',
      status: 'open',
      authorName: 'ada',
    })
  })
})

describe('Azure DevOps parsers', () => {
  it.each([
    ['https://dev.azure.com/org/project/_git/repo', 'project', 'repo'],
    ['git@ssh.dev.azure.com:v3/org/project/repo', 'project', 'repo'],
    ['ssh://git@vs-ssh.visualstudio.com:22/DefaultCollection/project/_ssh/repo', 'project', 'repo'],
    ['https://dev.azure.com/org/_git/repo', null, 'repo'],
  ])('parses %s', (url, project, repo) => {
    expect(parseAzureRemote(url)).toMatchObject({ project, repo })
  })

  it('builds browser URLs from SSH remotes', () => {
    const remote = 'git@ssh.dev.azure.com:v3/org/project/repo.git'
    expect(buildAzureRepoUrl(remote)).toBe('https://dev.azure.com/org/project/_git/repo')
    expect(buildAzurePullRequestsUrl(remote)).toBe('https://dev.azure.com/org/project/_git/repo/pullrequests')
    expect(buildAzurePullRequestUrl(remote, 42)).toBe('https://dev.azure.com/org/project/_git/repo/pullrequest/42')
  })

  it('normalizes branches and maps pull requests', () => {
    expect(normalizeAzureBranchName(' refs/remotes/origin/feature/x ', 'origin')).toBe('feature/x')
    expect(mapAzurePr({
      pullRequestId: 42,
      sourceRefName: 'refs/heads/feature/x',
      targetRefName: 'refs/heads/main',
      createdBy: { displayName: 'Ada' },
    }, 'git@ssh.dev.azure.com:v3/org/project/repo')).toMatchObject({
      id: 42,
      sourceBranch: 'feature/x',
      targetBranch: 'main',
      authorName: 'Ada',
      url: 'https://dev.azure.com/org/project/_git/repo/pullrequest/42',
    })
  })
})
