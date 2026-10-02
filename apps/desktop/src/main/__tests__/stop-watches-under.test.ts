import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ watched: [] as string[], closed: 0 }))
vi.mock('electron', () => ({}))
vi.mock('node:fs', async (original) => ({
  ...await original<typeof import('node:fs')>(),
  existsSync: () => true,
  watch: (path: string) => {
    mocks.watched.push(path)
    return Object.assign(new EventEmitter(), { close: () => { mocks.closed += 1 } })
  },
}))
vi.mock('../app-events', () => ({ emitAppEvent: vi.fn() }))

import { startFileWatch, startRepoGitWatch, stopAllFileWatches, stopFileWatch, stopRepoGitWatch, stopWatchesUnder } from '../file-watch'

afterEach(() => {
  stopAllFileWatches()
  mocks.watched.length = 0
  mocks.closed = 0
})

it('closes only watchers under the directory, and the restore brings them back with their reference counts', () => {
  const win = { isDestroyed: () => false } as BrowserWindow
  startRepoGitWatch(win, '/repos/app-worktrees/abc')
  startRepoGitWatch(win, '/repos/app-worktrees/abc')
  startFileWatch(win, '/repos/app-worktrees/abc/src/index.ts')
  startRepoGitWatch(win, '/repos/app-worktrees/abcdef')
  startFileWatch(win, '/repos/app/README.md')
  expect(mocks.watched).toHaveLength(4)

  const restore = stopWatchesUnder('/repos/app-worktrees/abc')
  expect(mocks.closed).toBe(2)

  restore()
  expect(mocks.watched).toHaveLength(6)
  // Two references were held on the repo watcher: one stop must not close it.
  stopRepoGitWatch('/repos/app-worktrees/abc')
  expect(mocks.closed).toBe(2)
  stopRepoGitWatch('/repos/app-worktrees/abc')
  stopFileWatch('/repos/app-worktrees/abc/src/index.ts')
  expect(mocks.closed).toBe(4)
})
