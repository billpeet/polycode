import { invalidateForgeRemotes } from '../forge-cache'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ request: vi.fn(), git: vi.fn(), runner: vi.fn() }))
vi.mock('../azure-devops-client', async (importOriginal) => ({ ...await importOriginal<typeof import('../azure-devops-client')>(), azureRequest: mocks.request }))
vi.mock('../git-runner', () => ({ runGit: mocks.git }))
vi.mock('../driver/runner', () => ({ createRunner: mocks.runner }))
import { createPullRequest, getCurrentBranchPullRequest, listOpenPullRequests, enrichOpenPullRequests, checkoutPullRequestBranch } from '../azure-devops'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.request.mockResolvedValue({ value: [] })
  invalidateForgeRemotes()
  mocks.git.mockImplementation(async (_runner, _path, args: string[]) => {
    if (args[0] === 'remote' && args.length === 1) return 'origin'
    if (args[0] === 'remote') return 'git@ssh.dev.azure.com:v3/org/project/repo'
    if (args[0] === 'rev-parse') return 'feature'
    return ''
  })
})

const buildPolicy = (status: string, buildId?: number) => ({
  status,
  configuration: { type: { id: '0609b952-1397-4640-95ec-e00a01b2c241' }, settings: { displayName: 'CI', buildDefinitionId: 7 } },
  context: { buildId },
})

it.each([
  ['queued', 'processing'], ['running', 'processing'], ['approved', 'passed'],
  ['rejected', 'failed'], ['broken', 'failed'], ['notApplicable', 'none'],
])('maps Azure build policy %s to %s', async (status, expected) => {
  mocks.request.mockImplementation(async (_ctx, resource) => {
    if (resource === 'pullrequests') return { value: [{ pullRequestId: 1 }] }
    if (resource === '') return { project: { id: 'project-id' } }
    if (resource === 'policy/evaluations') return { value: [buildPolicy(status, 123)] }
    throw new Error('Comments unavailable')
  })
  const prs = await listOpenPullRequests('/repo')
  const [pr] = await enrichOpenPullRequests('/repo', prs)
  expect(pr.checkStatus).toBe(expected)
  expect(mocks.request).toHaveBeenCalledWith(expect.anything(), 'policy/evaluations', {
    artifactId: 'vstfs:///CodeReview/CodeReviewId/project-id/1', 'api-version': '7.1-preview.1',
  }, undefined, 'project-id')
  expect(pr.checks).toEqual(status === 'notApplicable' ? [] : [{ name: 'CI', status: expected, url: 'https://dev.azure.com/org/project-id/_build/results?buildId=123' }])
})

it('keeps running checks visible alongside failed checks and ignores non-build policies', async () => {
  mocks.request.mockImplementation(async (_ctx, resource) => {
    if (resource === 'pullrequests') return { value: [{ pullRequestId: 1 }] }
    if (resource === '') return { project: { id: 'project-id' } }
    if (resource === 'policy/evaluations') return { value: [
      buildPolicy('rejected', 123), buildPolicy('queued'),
      { status: 'rejected', configuration: { type: { id: 'reviewers' } } },
      { ...buildPolicy('running'), configuration: { ...buildPolicy('running').configuration, isEnabled: false } },
    ] }
    return { value: [] }
  })
  const [pr] = await enrichOpenPullRequests('/repo', await listOpenPullRequests('/repo'))
  expect(pr.checkStatus).toBe('processing')
  expect(pr.checks).toHaveLength(2)
  expect(pr.checks?.[1].url).toBeUndefined()
  expect(pr.unresolvedCommentCount).toBe(0)
})

it('preserves comments when policy evaluation fails', async () => {
  mocks.request.mockImplementation(async (_ctx, resource) => {
    if (resource === 'pullrequests') return { value: [{ pullRequestId: 1 }] }
    if (resource === '') return { project: { id: 'project-id' } }
    if (resource === 'policy/evaluations') throw new Error('Forbidden')
    return { value: [{ status: 'active' }] }
  })
  const [pr] = await enrichOpenPullRequests('/repo', await listOpenPullRequests('/repo'))
  expect(pr.unresolvedCommentCount).toBe(1)
  expect(pr.checkStatus).toBeUndefined()
})

it('lists PRs directly while resolving an SSH repository through its runner', async () => {
  mocks.request.mockResolvedValue({ value: [{ pullRequestId: 1, sourceRefName: 'refs/heads/feature' }] })
  const ssh = { host: 'host' } as Parameters<typeof listOpenPullRequests>[1]
  await expect(listOpenPullRequests('/repo', ssh)).resolves.toMatchObject([{ id: 1, sourceBranch: 'feature' }])
  expect(mocks.runner).toHaveBeenCalledWith({ ssh, wsl: undefined })
  expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ repo: 'repo', project: 'project' }), 'pullrequests', { 'searchCriteria.status': 'active', '$top': '50' })
})

it('creates a PR with normalized refs and description', async () => {
  mocks.request.mockResolvedValue({ pullRequestId: 42 })
  await expect(createPullRequest('/repo', { target: 'origin/main', title: 'Title', description: 'a\r\nb' })).resolves.toMatchObject({ id: 42 })
  expect(mocks.request).toHaveBeenCalledWith(expect.anything(), 'pullrequests', {}, {
    sourceRefName: 'refs/heads/feature', targetRefName: 'refs/heads/main', title: 'Title', description: 'a\nb',
  })
})

it('filters current branch queries on the server and checks completed PRs', async () => {
  mocks.request.mockResolvedValueOnce({ value: [] }).mockResolvedValueOnce({ value: [{ pullRequestId: 42, sourceRefName: 'refs/heads/feature' }] }).mockResolvedValueOnce({ value: [] })
  await expect(getCurrentBranchPullRequest('/repo', 'feature')).resolves.toMatchObject({ id: 42 })
  expect(mocks.request).toHaveBeenNthCalledWith(2, expect.anything(), 'pullrequests', { 'searchCriteria.status': 'completed', 'searchCriteria.sourceRefName': 'refs/heads/feature', '$top': '50' })
})

it('counts only active, non-deleted comment threads', async () => {
  mocks.request.mockResolvedValueOnce({ value: [{ pullRequestId: 1 }] })
  const prs = await listOpenPullRequests('/repo')
  mocks.request.mockResolvedValueOnce({ project: { id: 'project-id' } }).mockResolvedValueOnce({ value: [{ status: 1 }, { status: 'active' }, { status: 2 }, { status: 1, isDeleted: true }] })
  await expect(enrichOpenPullRequests('/repo', prs)).resolves.toMatchObject([{ unresolvedCommentCount: 2 }])
})

it('checks out the source ref obtained from the API', async () => {
  mocks.request.mockResolvedValue({ sourceRefName: 'refs/heads/feature' })
  await expect(checkoutPullRequestBranch('/repo', 42)).resolves.toEqual({ branch: 'feature' })
  expect(mocks.request).toHaveBeenCalledWith(expect.anything(), 'pullrequests/42')
  expect(mocks.git).toHaveBeenCalledWith(undefined, '/repo', ['fetch', 'origin', 'refs/heads/feature'])
})
