import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertAppRunning,
  getAppLifecycleState,
  resetAppLifecycleForTest,
  runAppOperation,
  shutdownApp,
  waitForAppOperations,
} from './app-lifecycle'

describe('application shutdown lifecycle', () => {
  afterEach(() => resetAppLifecycleForTest())

  it('rejects new IPC and keeps the database open until asynchronous producers stop', async () => {
    const events: string[] = []
    let releaseProducers!: () => void
    const producersStopped = new Promise<void>((resolve) => { releaseProducers = resolve })

    const shutdown = shutdownApp({
      stopProducers: () => events.push('watchers-and-timers-stopped'),
      awaitProducers: async () => {
        events.push('commands-stopping')
        await producersStopped
        events.push('commands-stopped')
      },
      closeDatabase: () => events.push('database-closed'),
      finish: () => events.push('shutdown-finished'),
    })

    expect(getAppLifecycleState()).toBe('closing')
    expect(() => assertAppRunning()).toThrow('PolyCode is shutting down')
    expect(events).toEqual(['watchers-and-timers-stopped', 'commands-stopping'])

    releaseProducers()
    await shutdown

    expect(events).toEqual([
      'watchers-and-timers-stopped',
      'commands-stopping',
      'commands-stopped',
      'database-closed',
      'shutdown-finished',
    ])
    expect(getAppLifecycleState()).toBe('closed')
  })

  it('waits for IPC that was already in flight when shutdown began', async () => {
    const events: string[] = []
    let releaseIpc!: () => void
    const ipcReleased = new Promise<void>((resolve) => { releaseIpc = resolve })
    const ipc = runAppOperation(async () => {
      events.push('ipc-started')
      await ipcReleased
      events.push('ipc-finished')
    })

    const shutdown = shutdownApp({
      stopProducers: vi.fn(),
      awaitProducers: () => waitForAppOperations(),
      closeDatabase: () => events.push('database-closed'),
      finish: vi.fn(),
    })

    await Promise.resolve()
    expect(events).toEqual(['ipc-started'])
    releaseIpc()
    await Promise.all([ipc, shutdown])
    expect(events).toEqual(['ipc-started', 'ipc-finished', 'database-closed'])
  })

  it('runs shutdown only once when Electron emits before-quit again', async () => {
    const steps = {
      stopProducers: vi.fn(),
      awaitProducers: vi.fn(async () => undefined),
      closeDatabase: vi.fn(),
      finish: vi.fn(),
    }

    await Promise.all([shutdownApp(steps), shutdownApp(steps)])

    expect(steps.stopProducers).toHaveBeenCalledTimes(1)
    expect(steps.awaitProducers).toHaveBeenCalledTimes(1)
    expect(steps.closeDatabase).toHaveBeenCalledTimes(1)
    expect(steps.finish).toHaveBeenCalledTimes(1)
  })
})
