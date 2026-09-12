import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('./observability', () => ({ recordDuration: vi.fn(), count: vi.fn(), withSpan: vi.fn((_name, _attrs, callback) => callback()) }))
vi.mock('./feature-usage', () => ({ recordFeatureUsage: vi.fn() }))
import { recordDuration } from './observability'
import { ipcMain } from 'electron'
import { installIpcProfiling, installMainThreadStallMonitor } from './perf'

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

it('redacts PAT arguments when a slow credential save is logged', async () => {
  vi.useFakeTimers()
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const originalHandle = vi.mocked(ipcMain.handle)
  installIpcProfiling()
  ipcMain.handle('azure:pat:set', async () => { now = 10_000 })
  const listener = originalHandle.mock.calls.at(-1)![1]
  await listener({} as Electron.IpcMainInvokeEvent, 'super-secret-pat')
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('args=[redacted]'))
  expect(JSON.stringify(warn.mock.calls)).not.toContain('super-secret-pat')
})
