import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createOutputBatcher } from '../outputBatcher'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('delivers a burst as one call after the interval, in order', () => {
  const apply = vi.fn()
  const batcher = createOutputBatcher<number>(apply, { intervalMs: 50 })
  batcher.push(1)
  batcher.push(2)
  vi.advanceTimersByTime(49)
  batcher.push(3)
  expect(apply).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(apply).toHaveBeenCalledTimes(1)
  expect(apply).toHaveBeenCalledWith([1, 2, 3])
})

it('flushes on demand and does not deliver the same items twice', () => {
  const apply = vi.fn()
  const batcher = createOutputBatcher<number>(apply, { intervalMs: 50 })
  batcher.push(1)
  batcher.flush()
  expect(apply).toHaveBeenCalledWith([1])
  vi.advanceTimersByTime(100)
  expect(apply).toHaveBeenCalledTimes(1)
  batcher.flush()
  expect(apply).toHaveBeenCalledTimes(1)
})

it('drops pending items once disposed', () => {
  const apply = vi.fn()
  const batcher = createOutputBatcher<number>(apply, { intervalMs: 50 })
  batcher.push(1)
  batcher.dispose()
  batcher.push(2)
  vi.advanceTimersByTime(100)
  expect(apply).not.toHaveBeenCalled()
})
