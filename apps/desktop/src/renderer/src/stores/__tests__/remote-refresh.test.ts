import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useThreadStore } from '../threads'
import { useSessionStore } from '../sessions'
import { useMessageStore } from '../messages'
import { useLocationStore } from '../locations'
import { useCommandStore } from '../commands'
import { useSlashCommandStore } from '../slashCommands'

describe('background refreshes during a remote stall', () => {
  const invoke = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('window', { api: { invoke } })
    invoke.mockReset()
    useThreadStore.setState({ byProject: { p: [] }, queueThreads: [], archivedCountByProject: { p: 7 } })
    useSessionStore.setState({ sessionsByThread: { t: [] }, activeSessionByThread: { t: 's' } })
  })
  afterEach(() => vi.unstubAllGlobals())

  it.each(['REMOTE_REQUEST_TIMEOUT', 'REMOTE_UNAVAILABLE'])('settles concurrent refresh callers and retains cached data on %s', async (code) => {
    invoke.mockRejectedValue(new Error(`[${code}] Host is slow`))
    const beforeThreads = useThreadStore.getState()
    const beforeSessions = useSessionStore.getState()
    await expect(Promise.all([
      useThreadStore.getState().fetch('p'),
      useSessionStore.getState().fetch('t'),
      useMessageStore.getState().fetchBySession('s'),
    ])).resolves.toEqual([undefined, undefined, undefined])
    expect(useThreadStore.getState()).toBe(beforeThreads)
    expect(useSessionStore.getState()).toBe(beforeSessions)
  })

  it('does not log queue transport failures', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      invoke.mockRejectedValue(new Error('[REMOTE_REQUEST_TIMEOUT] Host is slow'))
      await useThreadStore.getState().fetchQueue()
      expect(log).not.toHaveBeenCalled()
    } finally { log.mockRestore() }
  })

  describe('hydration reads (#94)', () => {
    const cached = [{ id: 'cached' }] as never[]
    beforeEach(() => {
      useLocationStore.setState({ byProject: { p: cached } })
      useCommandStore.setState({ byProject: { p: cached } })
      useSlashCommandStore.setState({ commandsByScope: { p: cached } })
    })
    const hydrate = () => Promise.all([
      useLocationStore.getState().fetch('p'),
      useCommandStore.getState().fetch('p'),
      useSlashCommandStore.getState().fetch('p', 'claude-code', null),
    ])

    it('keeps cached data when a busy host refuses the burst', async () => {
      invoke.mockRejectedValue(new Error(
        "Error invoking remote method 'locations:list': RemoteHostBusyError: [REMOTE_REQUEST_TIMEOUT] Remote host is busy. This request was not started; retry shortly.",
      ))
      await expect(hydrate()).resolves.toEqual([undefined, undefined, undefined])
      expect(useLocationStore.getState().byProject.p).toBe(cached)
      expect(useCommandStore.getState().byProject.p).toBe(cached)
      expect(useSlashCommandStore.getState().commandsByScope.p).toBe(cached)
    })

    it('updates the palette only when both slash commands and skills arrive', async () => {
      invoke.mockImplementation(async (channel: string) => {
        if (channel === 'skills:list') throw new Error('[REMOTE_REQUEST_TIMEOUT] Host is slow')
        return [{ id: 'fresh' }]
      })
      await useSlashCommandStore.getState().fetch('p', 'claude-code', null)
      expect(useSlashCommandStore.getState().commandsByScope.p).toBe(cached)

      invoke.mockImplementation(async (channel: string) => [{ id: channel }])
      await useSlashCommandStore.getState().fetch('p', 'claude-code', null)
      expect(useSlashCommandStore.getState().commandsByScope.p).toEqual([{ id: 'skills:list' }, { id: 'slash-commands:list' }])
    })

    it('still propagates unexpected failures', async () => {
      invoke.mockRejectedValue(new Error('SQLITE_CORRUPT'))
      for (const fetch of [
        () => useLocationStore.getState().fetch('p'),
        () => useCommandStore.getState().fetch('p'),
        () => useSlashCommandStore.getState().fetch('p', 'claude-code', null),
      ]) await expect(fetch()).rejects.toThrow('SQLITE_CORRUPT')
    })
  })

  it('propagates unexpected failures and mutation timeouts', async () => {
    invoke.mockRejectedValue(new Error('SQLITE_CORRUPT'))
    await expect(useThreadStore.getState().fetch('p')).rejects.toThrow('SQLITE_CORRUPT')
    await expect(useSessionStore.getState().fetch('t')).rejects.toThrow('SQLITE_CORRUPT')
    invoke.mockRejectedValue(new Error('[REMOTE_REQUEST_TIMEOUT] May have completed remotely'))
    await expect(useSessionStore.getState().switchSession('t', 'other')).rejects.toThrow('May have completed remotely')
  })
})
