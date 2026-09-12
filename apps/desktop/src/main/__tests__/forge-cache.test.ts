import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const run = vi.hoisted(() => vi.fn())
const exists = vi.hoisted(() => vi.fn(() => false))
vi.mock('../driver/runner', () => ({ createRunner: () => ({ run }) }))
vi.mock('fs', async importOriginal => ({ ...await importOriginal<typeof import('fs')>(), existsSync: exists }))

beforeEach(() => {
  vi.resetModules()
  exists.mockReset().mockReturnValue(false)
  run.mockReset().mockImplementation(async ({ binary, args }) => ({
    stdout: binary === 'git' ? (args.length === 1 ? 'origin' : 'https://github.com/acme/widgets.git') : '[]',
    stderr: '', exitCode: 0, timedOut: false,
  }))
})

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

it('shares remote discovery across detection, adapters and repeated refreshes', async () => {
  const { createForge } = await import('../forge')
  const forges = await Promise.all(Array.from({ length: 3 }, () => createForge('/repo')))
  await Promise.all(forges.flatMap(forge => [
    forge.listPullRequests(), forge.enrichPullRequests([]),
    forge.getCurrentBranchPullRequest('feature'), forge.getRepoWebUrl(),
  ]))
  await (await createForge('/repo')).listPullRequests()
  const commands = run.mock.calls.map(([command]) => command)
  expect(commands.filter(command => command.binary === 'git')).toHaveLength(2)
  // list, enrichment, current(open + merged): one trip each across subscribers.
  expect(commands.filter(command => command.binary === 'gh')).toHaveLength(4)
})

it('expires PR reads after 30 seconds without expiring remote discovery', async () => {
  vi.useFakeTimers()
  const { createForge } = await import('../forge')
  const forge = await createForge('/repo')
  await forge.listPullRequests()
  await forge.getCurrentBranchPullRequest('feature')
  await vi.advanceTimersByTimeAsync(29_999)
  await forge.listPullRequests()
  await forge.getCurrentBranchPullRequest('feature')
  expect(run).toHaveBeenCalledTimes(5)
  await vi.advanceTimersByTimeAsync(1)
  await forge.listPullRequests()
  await forge.getCurrentBranchPullRequest('feature')
  expect(run).toHaveBeenCalledTimes(8)
  await vi.advanceTimersByTimeAsync(3_600_000)
  await (await createForge('/repo')).getRepoWebUrl()
  expect(run).toHaveBeenCalledTimes(8)
})

it('isolates repositories, host configurations and current branches', async () => {
  const { createForge } = await import('../forge')
  const scopes = [
    await createForge('/repo'), await createForge('/other'),
    await createForge('/repo', { host: 'host', user: 'a' }),
    await createForge('/repo', { host: 'host', user: 'b' }),
    await createForge('/repo', { host: 'host', user: 'a', port: 23 }),
    await createForge('/repo', { host: 'host', user: 'a', keyPath: '/key' }),
    await createForge('/repo', null, { distro: 'Ubuntu' }),
    await createForge('/repo', null, { distro: 'Debian' }),
  ]
  await Promise.all(scopes.map(forge => forge.listPullRequests()))
  expect(run.mock.calls.filter(([command]) => command.binary === 'git')).toHaveLength(16)
  expect(run.mock.calls.filter(([command]) => command.binary === 'gh')).toHaveLength(8)
  await Promise.all(['one', 'two', 'one'].map(branch => scopes[0].getCurrentBranchPullRequest(branch)))
  expect(run.mock.calls.filter(([command]) => command.binary === 'gh')).toHaveLength(12)
})

it('retries failed discovery and failed PR reads', async () => {
  const { createForge } = await import('../forge')
  run.mockRejectedValueOnce(new Error('offline'))
  await expect(createForge('/repo')).rejects.toThrow('offline')
  const forge = await createForge('/repo')
  run.mockRejectedValueOnce(new Error('offline'))
  await expect(forge.listPullRequests()).rejects.toThrow('offline')
  await expect(forge.listPullRequests()).resolves.toEqual([])
  expect(run).toHaveBeenCalledTimes(5)
})

it('invalidates remote context and PR reads on remote edits, including sibling worktrees', async () => {
  const { createForge } = await import('../forge')
  const { runGit } = await import('../git-runner')
  const { createRunner } = await import('../driver/runner')
  const forge = await createForge('/repo')
  await forge.listPullRequests()
  await runGit(createRunner({}), '/sibling', ['remote', 'set-url', 'origin', 'https://github.com/acme/new.git'])
  await forge.listPullRequests()
  expect(run).toHaveBeenCalledTimes(7)
})

it('keeps remote discovery cached across ordinary git invalidation', async () => {
  const { createForge } = await import('../forge')
  const { invalidateGitCache } = await import('../git')
  await createForge('/repo')
  invalidateGitCache('/repo')
  await createForge('/repo')
  expect(run).toHaveBeenCalledTimes(2)
})

it.each([false, true])('shares Azure discovery and memoizes Windows shim lookup (direct node: %s)', async direct => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  exists.mockReturnValue(direct)
  const original = run.getMockImplementation()!
  run.mockImplementation(async command => {
    const result = await original(command)
    if (command.binary === 'git' && command.args.length > 1) result.stdout = 'https://dev.azure.com/org/project/_git/repo'
    if (command.binary === 'where.exe') result.stdout = direct ? 'C:\\cli\\azdevops.cmd' : ''
    return result
  })
  const { createForge } = await import('../forge')
  const forges = await Promise.all([createForge('/repo'), createForge('/repo')])
  await Promise.all([
    ...forges.map(forge => forge.listPullRequests()),
    forges[0].getCurrentBranchPullRequest('feature'),
  ])
  expect(run.mock.calls.filter(([command]) => command.binary === 'git')).toHaveLength(2)
  expect(run.mock.calls.filter(([command]) => command.binary === 'where.exe')).toHaveLength(1)
  const commands = run.mock.calls.filter(([command]) => direct ? command.binary.endsWith('node.exe') : command.binary === 'azdevops')
  expect(commands).toHaveLength(3)
  expect(commands[2][0].args).toContain('completed')
  if (direct) expect(commands[2][0].args[0]).toContain('azdevops.js')
})

it('prefers origin, falls back to supported remotes and caches unsupported repositories', async () => {
  const original = run.getMockImplementation()!
  run.mockImplementation(async command => {
    const result = await original(command)
    if (command.args.length === 1) result.stdout = 'upstream\norigin\nadd'
    else if (command.args[2] === 'origin') result.stdout = 'https://example.org/repo.git'
    return result
  })
  const { resolveForgeRepoContext } = await import('../forge-context')
  expect(await resolveForgeRepoContext('/repo')).toMatchObject({ provider: 'github', remoteName: 'upstream' })
  expect(run.mock.calls[1][0].args).toEqual(['remote', 'get-url', 'origin'])
  run.mockImplementation(async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }))
  expect(await resolveForgeRepoContext('/empty')).toBeNull()
  expect(await resolveForgeRepoContext('/empty')).toBeNull()
  expect(run).toHaveBeenCalledTimes(4)
})

it('does not resurrect an invalidated read when its old request settles', async () => {
  const { ForgeCache } = await import('../forge-cache')
  const cache = new ForgeCache()
  let finish!: (value: string) => void
  const old = cache.read('key', 30_000, () => new Promise<string>(resolve => { finish = resolve }))
  await Promise.resolve()
  cache.clear()
  const fresh = vi.fn(async () => 'fresh')
  expect(await cache.read('key', 30_000, fresh)).toBe('fresh')
  finish('old')
  expect(await old).toBe('old')
  expect(await cache.read('key', 30_000, fresh)).toBe('fresh')
  expect(fresh).toHaveBeenCalledOnce()
})
