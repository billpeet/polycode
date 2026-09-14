import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { shutdownApp, resetAppLifecycleForTest, waitForAppOperations } from '../app-lifecycle'

const mocks = vi.hoisted(() => ({ callbacks: [] as Array<(...args: string[]) => void>, emit: vi.fn() }))
vi.mock('electron', () => ({}))
vi.mock('node:fs', async (original) => ({
  ...await original<typeof import('node:fs')>(),
  existsSync: () => true,
  readFileSync: () => 'plan',
  statSync: () => ({ mtimeMs: 1 }),
  watch: (...args: unknown[]) => {
    mocks.callbacks.push(args.at(-1) as (...args: string[]) => void)
    return Object.assign(new EventEmitter(), { close: vi.fn() })
  },
}))
vi.mock('../app-events', () => ({ emitAppEvent: (...args: unknown[]) => mocks.emit(...args) }))

import { startFileWatch, startRepoGitWatch, stopAllFileWatches } from '../file-watch'
import { startPlanWatcher, stopPlanWatcher } from '../plans'

afterEach(() => {
  stopAllFileWatches()
  stopPlanWatcher()
  vi.useRealTimers()
  mocks.callbacks.length = 0
  mocks.emit.mockReset()
  resetAppLifecycleForTest()
})

it('cancels file, repo and plan callbacks before storage closes, including queued watcher events', async () => {
  vi.useFakeTimers()
  const win = { isDestroyed: () => false } as BrowserWindow
  startFileWatch(win, '/repo/file.ts')
  startRepoGitWatch(win, '/repo')
  startPlanWatcher(win)
  const notify = () => {
    mocks.callbacks[0]('change', 'file.ts')
    mocks.callbacks[1]('change', 'file.ts')
    mocks.callbacks[2]('change', 'plan.md')
  }
  notify()
  expect(vi.getTimerCount()).toBe(3)
  await shutdownApp({
    stopProducers: () => { stopAllFileWatches(); stopPlanWatcher() },
    awaitProducers: waitForAppOperations,
    closeDatabase: () => {
      mocks.emit.mockImplementation(() => { throw new Error('Producer ran after database closure') })
    },
    finish: () => {},
  })
  notify()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.emit).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
