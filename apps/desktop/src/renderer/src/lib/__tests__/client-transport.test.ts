import { afterEach, describe, expect, it, vi } from 'vitest'
import { client } from '../client'
import { useCommandStore } from '../../stores/commands'
import { useLocationStore } from '../../stores/locations'
import { useSlashCommandStore } from '../../stores/slashCommands'
import { useYouTrackStore } from '../../stores/youtrack'
import { useProjectStore } from '../../stores/projects'
import { useCliHealthStore } from '../../stores/cliHealth'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('renderer transport policy (#115)', () => {
  it('settles fire-and-forget command refreshes during a stall', async () => {
    vi.stubGlobal('window', { api: { invoke: vi.fn().mockRejectedValue(new Error('[REMOTE_REQUEST_TIMEOUT] Work stalled')) } })
    await expect(useCommandStore.getState().fetchPorts('c', 'l')).resolves.toBeUndefined()
    await expect(useCommandStore.getState().fetchLogs('c', 'l')).resolves.toBeUndefined()
  })
  it.each(['REMOTE_UNAVAILABLE', 'REMOTE_REQUEST_TIMEOUT'])('settles concurrent background reads and cleanup on %s', async (code) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const invoke = vi.fn().mockRejectedValue(new Error(`[${code}] Work stalled`))
    vi.stubGlobal('window', { api: { invoke } })
    const ports = [3000]
    const logs = [{ text: 'cached' }] as never[]
    useCommandStore.setState({ portsMap: { 'c:l': ports }, logsByCommand: { 'c:l': logs } })
    await expect(Promise.all([
      client.refresh('locations:list', 'p'),
      client.refresh('slash-commands:list', 'p'),
      client.refresh('skills:list', 'claude-code', null),
      client.refresh('youtrack:servers:list'),
      client.invoke('git:watchStop', '/repo'),
      useCommandStore.getState().fetchPorts('c', 'l'),
      useCommandStore.getState().fetchLogs('c', 'l'),
    ])).resolves.toEqual(Array(7).fill(undefined))
    expect(useCommandStore.getState().portsMap['c:l']).toBe(ports)
    expect(useCommandStore.getState().logsByCommand['c:l']).toBe(logs)
    expect(invoke).toHaveBeenCalledTimes(7)
    expect(warn).toHaveBeenCalledWith('IPC cleanup failed', expect.objectContaining({ channel: 'git:watchStop', outcome: 'remote-transport' }))
  })

  it.each(['REMOTE_UNAVAILABLE', 'REMOTE_REQUEST_TIMEOUT'])('does not emit unhandled rejections from background callers on %s', async (code) => {
    vi.stubGlobal('window', { api: { invoke: vi.fn().mockRejectedValue(new Error(`[${code}] Work stalled`)) } })
    const cached = [{ id: 'cached' }] as never[]
    useLocationStore.setState({ byProject: { p: cached }, poolsByProject: { p: cached } })
    useSlashCommandStore.setState({ commandsByScope: { p: cached } })
    useYouTrackStore.setState({ servers: cached })
    useProjectStore.setState({ projects: cached, archivedProjects: cached })
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      // Effects and event handlers intentionally do not await these operations.
      void useLocationStore.getState().fetch('p')
      void useLocationStore.getState().fetchPools('p')
      void useSlashCommandStore.getState().fetch('p', 'claude-code', null)
      void useYouTrackStore.getState().fetch()
      void useProjectStore.getState().fetch()
      void useCommandStore.getState().fetchPorts('c', 'l')
      void useCommandStore.getState().fetchLogs('c', 'l')
      void useCliHealthStore.getState().check('t', 'claude-code', 'local', null, null)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).not.toHaveBeenCalled()
      expect(useLocationStore.getState().byProject.p).toBe(cached)
      expect(useLocationStore.getState().poolsByProject.p).toBe(cached)
      expect(useSlashCommandStore.getState().commandsByScope.p).toBe(cached)
      expect(useYouTrackStore.getState()).toMatchObject({ servers: cached, unavailable: true, loading: false })
      expect(useProjectStore.getState()).toMatchObject({ projects: cached, archivedProjects: cached, loading: false })
    } finally { process.off('unhandledRejection', unhandled) }
  })

  it.each([
    { code: 'REMOTE_UNAVAILABLE', message: 'Host disconnected' },
    Object.assign(new Error('Request expired'), { name: 'RemoteRequestTimeoutError' }),
  ])('recognizes structured transport errors', async (error) => {
    vi.stubGlobal('window', { api: { invoke: vi.fn().mockRejectedValue(error) } })
    await expect(client.refresh('locations:list', 'p')).resolves.toBeUndefined()
  })

  it('preserves actionable mutation errors and never retries ambiguous timeouts', async () => {
    const error = new Error('[REMOTE_REQUEST_TIMEOUT] May have completed remotely')
    const invoke = vi.fn().mockRejectedValue(error)
    vi.stubGlobal('window', { api: { invoke } })
    await expect(client.invoke('sessions:switch', 't', 's')).rejects.toBe(error)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('propagates unexpected read failures', async () => {
    vi.stubGlobal('window', { api: { invoke: vi.fn().mockRejectedValue(new Error('SQLITE_CORRUPT')) } })
    await expect(client.refresh('locations:list', 'p')).rejects.toThrow('SQLITE_CORRUPT')
  })
})
