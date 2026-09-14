import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AppShuttingDownError, beginAppShutdown, registerAppShutdown, resetAppLifecycleForTest, runAppOperation, waitForAppOperations } from '../app-lifecycle'
import * as storage from '../db'
import { createProject, createLocation, createCommand, listProjects } from '../db/queries'
import { commandManager } from '../commands/manager'
import { startFileWatch, startRepoGitWatch, stopAllFileWatches } from '../file-watch'
import { startPlanWatcher, stopPlanWatcher } from '../plans'
import { settleBackgroundIpc } from '../../renderer/src/lib/backgroundIpc'

const h = vi.hoisted(() => ({
  // Available before plans.ts captures homedir() at module import.
  directory: `${process.env.TEMP ?? process.env.TMPDIR ?? '/tmp'}/polycode-shutdown-${crypto.randomUUID()}`,
  watchers: [] as Array<(...args: string[]) => void>,
  spawn: vi.fn(),
  probe: vi.fn(),
  emit: vi.fn(),
}))
vi.mock('electron', () => ({ app: { getPath: () => h.directory } }))
vi.mock('node:os', async (original) => ({
  ...await original<typeof import('node:os')>(),
  homedir: () => h.directory,
}))
vi.mock('node:fs', async (original) => ({
  ...await original<typeof import('node:fs')>(),
  watch: (...args: unknown[]) => {
    h.watchers.push(args.at(-1) as (...args: string[]) => void)
    return Object.assign(new EventEmitter(), { close: vi.fn() })
  },
}))
vi.mock('../db/telemetry', () => ({ instrumentDatabase: () => {} }))
vi.mock('../driver/runner', () => ({
  createRunner: () => ({ type: 'local', spawnScript: h.spawn }),
  augmentWindowsPath: () => ({}),
}))
vi.mock('../process-control', () => ({
  runExecFile: (...args: unknown[]) => h.probe(...args),
  getPowerShellExe: () => 'powershell',
  killWindowsProcessTree: () => {},
}))
vi.mock('../app-events', () => ({ emitAppEvent: (...args: unknown[]) => h.emit(...args) }))

beforeEach(() => {
  mkdirSync(h.directory, { recursive: true })
  storage.initDb()
})

afterEach(() => {
  stopAllFileWatches()
  stopPlanWatcher()
  storage.closeDb()
  resetAppLifecycleForTest()
  vi.useRealTimers()
  vi.restoreAllMocks()
  h.watchers.length = 0
  h.emit.mockReset()
  rmSync(h.directory, { recursive: true, force: true })
})

it('drains SQL and command probes, then rejects renderer refreshes without touching closed SQLite', async () => {
  vi.useFakeTimers()
  const win = { isDestroyed: () => false } as BrowserWindow
  const proc = Object.assign(new EventEmitter(), {
    pid: 123, exitCode: null as number | null, signalCode: null,
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
  })
  h.spawn.mockReturnValue(proc)
  let releaseProbe!: (value: string) => void
  h.probe.mockImplementationOnce(() => new Promise<string>((resolve) => { releaseProbe = resolve }))
    .mockResolvedValue('')
  const project = createProject('Shutdown test')
  const location = createLocation(project.id, 'Local', 'local', h.directory)
  const command = createCommand(project.id, 'Dev', 'test-command')
  commandManager.init(win)
  await commandManager.start(command.id, location.id)
  proc.stdout.emit('data', Buffer.from('pending log\n'))

  const file = join(h.directory, 'file.ts')
  writeFileSync(file, '')
  startFileWatch(win, file)
  startRepoGitWatch(win, h.directory)
  startPlanWatcher(win)
  h.watchers[0]('change', 'file.ts')
  h.watchers[1]('change', 'file.ts')
  h.watchers[2]('change', 'plan.md')

  let releaseSql!: () => void
  const held = new Promise<void>((resolve) => { releaseSql = resolve })
  const operation = runAppOperation(async () => { await held; return listProjects() }, 'projects:list')
  const database = storage.getDb()
  const prepare = vi.spyOn(database, 'prepare')
  const getDb = vi.spyOn(storage, 'getDb')
  const close = vi.fn(() => storage.closeDb())
  const app = new EventEmitter()
  const preventDefault = vi.fn()
  let finish!: () => void
  const shutdown = new Promise<void>((resolve) => { finish = resolve })
  registerAppShutdown(app, {
    stopProducers: () => { stopAllFileWatches(); stopPlanWatcher() },
    awaitProducers: () => Promise.allSettled([commandManager.stopAll(), waitForAppOperations()]),
    closeDatabase: close,
    finish,
  })
  app.emit('before-quit', { preventDefault })
  expect(preventDefault).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1)
  expect(close).not.toHaveBeenCalled()
  releaseSql()
  expect(await operation).toHaveLength(1)
  proc.exitCode = 0
  proc.emit('close', 0)
  await vi.advanceTimersByTimeAsync(1)
  expect(close).not.toHaveBeenCalled() // The port probe still owns asynchronous work.
  releaseProbe('')
  await shutdown
  expect(database.open).toBe(false)
  expect(close).toHaveBeenCalledOnce()
  preventDefault.mockClear()
  app.emit('before-quit', { preventDefault })
  expect(preventDefault).not.toHaveBeenCalled()
  prepare.mockClear()
  getDb.mockClear()
  h.emit.mockClear()

  // Renderer command polling and database sync may still tick while Electron quits.
  const refresh = vi.fn(() => listProjects())
  const refreshes: Promise<unknown>[] = []
  const timer = setInterval(() => {
    for (const channel of ['commands:getPid', 'commands:getPorts', 'threads:list']) {
      refreshes.push(settleBackgroundIpc(runAppOperation(refresh, channel)))
    }
  }, 2_000)
  await vi.advanceTimersByTimeAsync(60_000)
  clearInterval(timer)
  await Promise.all(refreshes)
  expect(refreshes).toHaveLength(90)
  expect(refresh).not.toHaveBeenCalled()
  expect(getDb).not.toHaveBeenCalled()
  expect(prepare).not.toHaveBeenCalled()
  expect(h.emit).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('identifies late untracked queries without including their arguments', () => {
  beginAppShutdown()
  storage.closeDb()
  expect(() => listProjects()).toThrow('operation=untracked, query=listProjects')
  expect(() => storage.getDb('/private/path?token=secret')).toThrow('query=unknown')
})

it('rejects a queued command start before it can create another producer during shutdown', async () => {
  const project = createProject('Queued command test')
  const location = createLocation(project.id, 'Local', 'local', h.directory)
  const command = createCommand(project.id, 'Dev', 'test-command')
  const getDb = vi.spyOn(storage, 'getDb')
  h.spawn.mockClear()
  const operation = runAppOperation(() => commandManager.start(command.id, location.id), 'commands:start')
  const rejection = expect(operation).rejects.toMatchObject({ code: 'APP_SHUTTING_DOWN' })
  beginAppShutdown()
  await Promise.allSettled([commandManager.stopAll(), waitForAppOperations()])
  await rejection
  expect(h.spawn).not.toHaveBeenCalled()
  expect(getDb).not.toHaveBeenCalled()
})

it('preserves operation context across await and keeps invariant failures observable', async () => {
  const failure = runAppOperation(async () => {
    await Promise.resolve()
    beginAppShutdown()
    storage.closeDb()
    return listProjects()
  }, 'projects:list')
  await expect(failure).rejects.toThrow('operation=projects:list, query=listProjects')
  await expect(failure).rejects.not.toBeInstanceOf(AppShuttingDownError)
  resetAppLifecycleForTest()
  expect(() => storage.getDb()).toThrow('Database not initialized')
})
