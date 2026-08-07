// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetch = vi.fn().mockResolvedValue(undefined)
const refreshRemote = vi.fn().mockResolvedValue(undefined)

vi.mock('../../stores/git', () => ({
  useGitStore: { getState: () => ({ fetch, refreshRemote }) },
}))

describe('git refresh coordinator', () => {
  let listeners: Record<string, (...args: unknown[]) => void>
  let invoke: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    fetch.mockClear()
    refreshRemote.mockClear()
    listeners = {}
    invoke = vi.fn().mockImplementation((channel: string) => Promise.resolve(channel === 'git:watchStart'))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        invoke,
        on: vi.fn((channel: string, callback: (...args: unknown[]) => void) => {
          listeners[channel] = callback
          return vi.fn()
        }),
      },
    })
  })

  afterEach(() => vi.useRealTimers())

  it('refreshes only the most recently selected repository', async () => {
    const { subscribeToGitRefresh } = await import('../gitRefreshCoordinator')
    const unsubscribeA = subscribeToGitRefresh('C:/repo/a')
    await Promise.resolve()
    const unsubscribeB = subscribeToGitRefresh('C:/repo/b')
    await Promise.resolve()

    expect(fetch).toHaveBeenCalledWith('C:/repo/a')
    expect(fetch).toHaveBeenLastCalledWith('C:/repo/b')
    expect(invoke).toHaveBeenCalledWith('git:watchStop', 'C:/repo/a')
    fetch.mockClear()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith('C:/repo/b')
    unsubscribeA()
    unsubscribeB()
  })

  it('debounces watcher events into one status invalidation', async () => {
    const { subscribeToGitRefresh } = await import('../gitRefreshCoordinator')
    const unsubscribe = subscribeToGitRefresh('C:/repo/a')
    fetch.mockClear()

    listeners['git:repoChanged']?.({ path: 'C:/repo/a' })
    listeners['git:repoChanged']?.({ path: 'C:/repo/a' })
    await vi.advanceTimersByTimeAsync(749)
    expect(fetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('staggers remote refresh away from initial status refresh', async () => {
    const { subscribeToGitRefresh } = await import('../gitRefreshCoordinator')
    const unsubscribe = subscribeToGitRefresh('C:/repo/a', { includeRemote: true })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(refreshRemote).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(29_999)
    expect(refreshRemote).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(refreshRemote).toHaveBeenCalledWith('C:/repo/a')
    unsubscribe()
  })
})
