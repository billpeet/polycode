import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useThreadStore } from '../threads'
import { useSessionStore } from '../sessions'
import { useMessageStore } from '../messages'

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

  it('propagates unexpected failures and mutation timeouts', async () => {
    invoke.mockRejectedValue(new Error('SQLITE_CORRUPT'))
    await expect(useThreadStore.getState().fetch('p')).rejects.toThrow('SQLITE_CORRUPT')
    await expect(useSessionStore.getState().fetch('t')).rejects.toThrow('SQLITE_CORRUPT')
    invoke.mockRejectedValue(new Error('[REMOTE_REQUEST_TIMEOUT] May have completed remotely'))
    await expect(useSessionStore.getState().switchSession('t', 'other')).rejects.toThrow('May have completed remotely')
  })
})
