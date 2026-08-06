// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('sidebar branch refresh coordinator', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('limits a sweep to two workers and does not overlap interval ticks', async () => {
    const resolvers: Array<(branch: string) => void> = []
    let active = 0
    let peak = 0
    const invoke = vi.fn(() => new Promise<string>((resolve) => {
      active += 1
      peak = Math.max(peak, active)
      resolvers.push((branch) => {
        active -= 1
        resolve(branch)
      })
    }))
    vi.stubGlobal('window', { ...window, api: { invoke } })
    const { subscribeToSidebarBranches } = await import('../sidebarBranchRefresh')

    const unsubscribe = subscribeToSidebarBranches([
      { id: '1', path: 'C:/repo/1' },
      { id: '2', path: 'C:/repo/2' },
      { id: '3', path: 'C:/repo/3' },
    ], vi.fn())
    await vi.advanceTimersByTimeAsync(240_000)

    expect(invoke).toHaveBeenCalledTimes(2)
    expect(peak).toBe(2)
    resolvers.shift()?.('main')
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledTimes(3)
    resolvers.splice(0).forEach((resolve) => resolve('main'))
    await Promise.resolve()
    await Promise.resolve()
    unsubscribe()
  })

  it('refreshes an invalidated visible path once the current sweep finishes', async () => {
    const resolvers: Array<(branch: string) => void> = []
    const invoke = vi.fn(() => new Promise<string>((resolve) => resolvers.push(resolve)))
    vi.stubGlobal('window', { ...window, api: { invoke } })
    const { invalidateSidebarBranch, subscribeToSidebarBranches } = await import('../sidebarBranchRefresh')

    const unsubscribe = subscribeToSidebarBranches([{ id: '1', path: 'C:/repo/1' }], vi.fn())
    invalidateSidebarBranch('C:/repo/1')
    expect(invoke).toHaveBeenCalledTimes(1)
    resolvers.shift()?.('main')
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
    expect(invoke).toHaveBeenCalledTimes(2)
    resolvers.shift()?.('feature')
    await Promise.resolve()
    unsubscribe()
  })

  it('does no work while hidden and refreshes on visibility return', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    const invoke = vi.fn().mockResolvedValue('main')
    vi.stubGlobal('window', { ...window, api: { invoke } })
    const { subscribeToSidebarBranches } = await import('../sidebarBranchRefresh')

    const unsubscribe = subscribeToSidebarBranches([{ id: '1', path: 'C:/repo/1' }], vi.fn())
    expect(invoke).not.toHaveBeenCalled()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledTimes(1)
    unsubscribe()
  })
})
