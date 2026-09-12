import { invalidateForgeRemotes } from '../forge-cache'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ request: vi.fn(), git: vi.fn(), runner: vi.fn() }))
vi.mock('../azure-devops-client', () => ({ azureRequest: mocks.request }))
vi.mock('../git-runner', () => ({ runGit: mocks.git }))
vi.mock('../driver/runner', () => ({ createRunner: mocks.runner }))
import { createPullRequest, getCurrentBranchPullRequest, listOpenPullRequests, enrichOpenPullRequests, checkoutPullRequestBranch } from '../azure-devops'

beforeEach(() => {
  vi.clearAllMocks()
  invalidateForgeRemotes()
  mocks.git.mockImplementation(async (_runner, _path, args: string[]) => {
    if (args[0] === 'remote' && args.length === 1) return 'origin'
    if (args[0] === 'remote') return 'git@ssh.dev.azure.com:v3/org/project/repo'
    if (args[0] === 'rev-parse') return 'feature'
    return ''
  })
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
  mocks.request.mockResolvedValueOnce({ value: [{ status: 1 }, { status: 'active' }, { status: 2 }, { status: 1, isDeleted: true }] })
  await expect(enrichOpenPullRequests('/repo', prs)).resolves.toMatchObject([{ unresolvedCommentCount: 2 }])
})

it('checks out the source ref obtained from the API', async () => {
  mocks.request.mockResolvedValue({ sourceRefName: 'refs/heads/feature' })
  await expect(checkoutPullRequestBranch('/repo', 42)).resolves.toEqual({ branch: 'feature' })
  expect(mocks.request).toHaveBeenCalledWith(expect.anything(), 'pullrequests/42')
  expect(mocks.git).toHaveBeenCalledWith(undefined, '/repo', ['fetch', 'origin', 'refs/heads/feature'])
})
