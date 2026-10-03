import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('../db/queries', () => ({
  archivedThreadCount: () => 0,
  snoozedThreadCount: () => 0,
  listArchivedProjects: () => [],
  listLocationPools: () => [],
  listProjects: () => [],
  listThreads: () => [],
}))
vi.mock('../project-admin', () => ({ listSyncedLocations: async () => [] }))
vi.mock('../app-events', () => ({ onAppEvent: () => () => undefined, sendToRenderer: () => undefined }))

import { invokeOnSource } from '../remote/unified'
import type { RemoteHost } from '../../shared/types'

const HOST: RemoteHost = {
  id: 'host-1',
  label: 'Box',
  baseUrl: 'http://box:8787',
  token: 't',
  createdAt: '',
  updatedAt: '',
}

afterEach(() => vi.unstubAllGlobals())

describe('invokeOnSource', () => {
  test('refuses channels a Remote Host would not accept', async () => {
    const local = vi.fn()
    await expect(invokeOnSource([HOST], 'local', 'settings:set', ['k', 'v'], local)).rejects.toThrow(/cannot be run/)
    expect(local).not.toHaveBeenCalled()
  })

  test('runs the local source through the local dispatcher', async () => {
    const local = vi.fn(async () => 'done')
    await expect(invokeOnSource([HOST], 'local', 'threads:archive', ['t1'], local)).resolves.toBe('done')
    expect(local).toHaveBeenCalledWith('threads:archive', ['t1'])
  })

  test('sends a remote source the RPC directly, never through the active host', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, value: 3 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(invokeOnSource([HOST], 'host-1', 'threads:archivedCount', ['p1'], vi.fn())).resolves.toBe(3)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://box:8787/api/remote/rpc')
    expect(JSON.parse(init.body as string)).toEqual({ channel: 'threads:archivedCount', args: ['p1'] })
  })

  test('rejects an unknown host', async () => {
    await expect(invokeOnSource([HOST], 'gone', 'threads:list', ['p'], vi.fn())).rejects.toThrow(/not found/)
  })
})
