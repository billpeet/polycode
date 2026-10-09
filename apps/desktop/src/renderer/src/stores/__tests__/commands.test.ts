import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCommandStore } from '../commands'

const invoke = vi.fn()
const key = 'cmd:loc'
const logs = [{ text: 'cached output', stream: 'stdout', timestamp: 'now' }] as never[]
beforeEach(() => {
  vi.stubGlobal('window', { api: { invoke } })
  invoke.mockReset()
  useCommandStore.setState({ statusMap: { [key]: 'running' }, logsByCommand: { [key]: logs }, portsMap: { [key]: [3000] } })
})
afterEach(() => vi.unstubAllGlobals())

describe('command disconnects', () => {
  it.each(['REMOTE_UNAVAILABLE', 'REMOTE_REQUEST_TIMEOUT'])('retains cached reads on %s', async (code) => {
    invoke.mockRejectedValue(new Error(`[${code}] offline`))
    await expect(Promise.all([
      useCommandStore.getState().fetchLogs('cmd', 'loc'),
      useCommandStore.getState().fetchPorts('cmd', 'loc'),
    ])).resolves.toEqual([undefined, undefined])
    expect(useCommandStore.getState().logsByCommand[key]).toBe(logs)
    expect(useCommandStore.getState().portsMap[key]).toEqual([3000])
  })

  it.each((['start', 'stop', 'restart'] as const).flatMap((action) =>
    ['REMOTE_UNAVAILABLE', 'REMOTE_REQUEST_TIMEOUT', 'unexpected'].map((code) => ({ action, code })),
  ))('rolls back $action without retrying $code', async ({ action, code }) => {
    const previous = action === 'start' ? 'idle' : 'running'
    useCommandStore.setState({ statusMap: { [key]: previous } })
    invoke.mockRejectedValue(new Error(`[${code}] May have executed`))
    await expect(useCommandStore.getState()[action]('cmd', 'loc')).rejects.toThrow('May have executed')
    expect(useCommandStore.getState().statusMap[key]).toBe(previous)
    expect(useCommandStore.getState().logsByCommand[key]).toBe(logs)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('does not overwrite an authoritative status event during rollback', async () => {
    let reject!: (error: Error) => void
    invoke.mockImplementation(() => new Promise((_, fail) => { reject = fail }))
    const operation = useCommandStore.getState().stop('cmd', 'loc')
    useCommandStore.getState().setStatus(key, 'stopped')
    reject(new Error('[REMOTE_UNAVAILABLE] offline'))
    await expect(operation).rejects.toThrow('offline')
    expect(useCommandStore.getState().statusMap[key]).toBe('stopped')
  })

  it('keeps unexpected read failures observable', async () => {
    invoke.mockRejectedValue(new Error('SQLITE_CORRUPT'))
    await expect(useCommandStore.getState().fetchLogs('cmd', 'loc')).rejects.toThrow('SQLITE_CORRUPT')
    await expect(useCommandStore.getState().fetchPorts('cmd', 'loc')).rejects.toThrow('SQLITE_CORRUPT')
  })
})

it('restores a missing status and preserves new output during a successful restart', async () => {
  useCommandStore.setState({ statusMap: {} })
  invoke.mockRejectedValue(new Error('[REMOTE_UNAVAILABLE] offline'))
  await expect(useCommandStore.getState().start('cmd', 'loc')).rejects.toThrow('offline')
  expect(useCommandStore.getState().statusMap).not.toHaveProperty(key)

  let finish!: () => void
  invoke.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
  const restart = useCommandStore.getState().restart('cmd', 'loc')
  const fresh = { text: 'new output', stream: 'stdout', timestamp: 'later' } as never
  useCommandStore.getState().appendLog(key, fresh)
  finish()
  await restart
  await new Promise((resolve) => setTimeout(resolve, 60))
  expect(useCommandStore.getState().logsByCommand[key]).toEqual([fresh])
})
