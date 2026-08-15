// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('forge refresh backoff', () => {
  let invoke: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    invoke = vi.fn(async (channel: string) => {
      if (channel === 'git:hostingProvider') return 'github'
      if (channel === 'git:defaultBranch') return 'main'
      if (channel === 'forge:pr:webUrl') return 'https://github.test/pulls'
      if (channel === 'forge:pr:list') return []
      if (channel === 'forge:pr:enrich') return []
      if (channel === 'forge:pr:current') return null
      return null
    })
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke } })
  })

  afterEach(() => vi.useRealTimers())

  it('caches stable provider and repository metadata', async () => {
    const { refreshForge } = await import('../forgeRefresh')
    await refreshForge('C:/repo', 'main')
    await refreshForge('C:/repo', 'feature')

    expect(invoke.mock.calls.filter(([channel]) => channel === 'git:hostingProvider')).toHaveLength(1)
    expect(invoke.mock.calls.filter(([channel]) => channel === 'git:defaultBranch')).toHaveLength(1)
    expect(invoke.mock.calls.filter(([channel]) => channel === 'forge:pr:webUrl')).toHaveLength(1)
  })

  it('publishes and caches the base list before enrichment completes', async () => {
    let finishEnrichment!: (value: Array<{ id: number; title: string }>) => void
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'git:hostingProvider') return 'github'
      if (channel === 'git:defaultBranch') return 'main'
      if (channel === 'forge:pr:webUrl') return 'https://github.test/pulls'
      if (channel === 'forge:pr:list') return [{ id: 1, title: 'Base' }]
      if (channel === 'forge:pr:enrich') return new Promise((resolve) => { finishEnrichment = resolve })
      if (channel === 'forge:pr:current') return null
      return null
    })
    const { getCachedForge, refreshForge } = await import('../forgeRefresh')
    const onList = vi.fn()
    const refreshing = refreshForge('C:/repo', 'main', { onList })
    await vi.waitFor(() => expect(onList).toHaveBeenCalledOnce())

    expect(getCachedForge('C:/repo', 'main')?.openPrs).toEqual([{ id: 1, title: 'Base' }])
    finishEnrichment([{ id: 1, title: 'Enriched' }])
    await expect(refreshing).resolves.toMatchObject({ openPrs: [{ id: 1, title: 'Enriched' }] })
  })

  it('suppresses automatic retries after deterministic failures but permits manual retry', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'git:hostingProvider') return 'github'
      if (channel === 'git:defaultBranch') return 'main'
      if (channel === 'forge:pr:webUrl') return 'https://github.test/pulls'
      if (channel === 'forge:pr:list') throw new Error('unknown JSON field: reviewThreads')
      return null
    })
    const { refreshForge } = await import('../forgeRefresh')

    await expect(refreshForge('C:/repo', 'main')).rejects.toThrow('reviewThreads')
    await expect(refreshForge('C:/repo', 'main')).rejects.toThrow('reviewThreads')
    expect(invoke.mock.calls.filter(([channel]) => channel === 'forge:pr:list')).toHaveLength(1)
    await expect(refreshForge('C:/repo', 'main', { force: true })).rejects.toThrow('reviewThreads')
    expect(invoke.mock.calls.filter(([channel]) => channel === 'forge:pr:list')).toHaveLength(2)
  })

  it('exponentially backs off transient failures', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'git:hostingProvider') return 'github'
      if (channel === 'git:defaultBranch') return 'main'
      if (channel === 'forge:pr:webUrl') return 'https://github.test/pulls'
      if (channel === 'forge:pr:list') throw new Error('network timed out')
      return null
    })
    const { getForgeRetryState, refreshForge } = await import('../forgeRefresh')

    await expect(refreshForge('C:/repo', 'main')).rejects.toThrow('timed out')
    expect(getForgeRetryState('C:/repo')?.retryAt).toBe(Date.now() + 30_000)
    await expect(refreshForge('C:/repo', 'main')).rejects.toThrow('timed out')
    expect(invoke.mock.calls.filter(([channel]) => channel === 'forge:pr:list')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(refreshForge('C:/repo', 'main')).rejects.toThrow('timed out')
    expect(getForgeRetryState('C:/repo')?.retryAt).toBe(Date.now() + 60_000)
  })
})
