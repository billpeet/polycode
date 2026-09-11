import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ ipcMain: {} }))
vi.mock('./observability', () => ({ recordDuration: vi.fn(), count: vi.fn(), withSpan: vi.fn() }))
vi.mock('./feature-usage', () => ({ recordFeatureUsage: vi.fn() }))
import { recordDuration } from './observability'
import { installMainThreadStallMonitor } from './perf'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

it('drops sleep drift and resets the baseline for subsequent real stalls', () => {
  vi.useFakeTimers()
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  installMainThreadStallMonitor()
  now = 70_000_000
  vi.advanceTimersByTime(1000)
  expect(recordDuration).not.toHaveBeenCalled()
  now += 1500
  vi.advanceTimersByTime(1000)
  expect(recordDuration).toHaveBeenCalledWith('polycode.event_loop.stall', 500, { process: 'main' })
})
