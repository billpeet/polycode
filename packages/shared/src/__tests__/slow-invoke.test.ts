import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSlowInvokeTracker } from '../slow-invoke'

describe('createSlowInvokeTracker', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('counts a call only once it outlives the threshold, and uncounts it when it settles', async () => {
    const tracker = createSlowInvokeTracker(100)
    const seen: number[] = []
    tracker.subscribe((n) => seen.push(n))

    let resolve!: () => void
    tracker.track(new Promise<void>((r) => { resolve = r }))

    await vi.advanceTimersByTimeAsync(99)
    expect(seen).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    expect(seen).toEqual([1])

    resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual([1, 0])
  })

  it('says nothing about a call that settles in time, however it settles', async () => {
    const tracker = createSlowInvokeTracker(100)
    const listener = vi.fn()
    tracker.subscribe(listener)

    tracker.track(Promise.resolve('fast'))
    tracker.track(Promise.reject(new Error('fast failure')))
    await vi.advanceTimersByTimeAsync(200)

    expect(listener).not.toHaveBeenCalled()
  })

  it('reports the number in flight and survives a throwing listener', async () => {
    const tracker = createSlowInvokeTracker(10)
    const seen: number[] = []
    tracker.subscribe(() => { throw new Error('bad listener') })
    const unsubscribe = tracker.subscribe((n) => seen.push(n))

    tracker.track(new Promise(() => {}))
    tracker.track(new Promise(() => {}))
    await vi.advanceTimersByTimeAsync(10)
    expect(seen).toEqual([1, 2])

    unsubscribe()
    tracker.track(new Promise(() => {}))
    await vi.advanceTimersByTimeAsync(10)
    expect(seen).toEqual([1, 2])
  })
})
