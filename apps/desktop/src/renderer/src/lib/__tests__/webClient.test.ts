import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteConnectionState } from '../../types/ipc'
import { getWebClient, resetWebClientForTests, WEB_HOST_ID } from '../webClient'

/**
 * The browser client against a scripted `fetch`. Requests are same-origin and carry no
 * token; the cookie the host set is the credential, and `credentials: 'same-origin'` is
 * what sends it.
 */

type FetchCall = { url: string; init: RequestInit | undefined }

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
const calls = (): FetchCall[] => fetchMock.mock.calls.map(([url, init]) => ({ url, init }))

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

/** An SSE response whose body stays open; frames are pushed with the returned function. */
function sseResponse(): { response: Response; push: (frame: string) => void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start: (c) => { controller = c } })
  const encoder = new TextEncoder()
  return {
    response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    push: (frame) => controller.enqueue(encoder.encode(frame)),
  }
}

/** Route by path; anything unrouted rejects like a network failure would. */
function route(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>): void {
  fetchMock.mockImplementation(async (url, init) => {
    const path = url.startsWith('http') ? new URL(url).pathname : url
    const handler = routes[path]
    if (!handler) throw new TypeError(`fetch failed: ${path}`)
    return handler(init)
  })
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('window', { location: { origin: 'http://host.test' } })
})

afterEach(() => {
  resetWebClientForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('invoke', () => {
  it('pauses clustered RPC timeouts while its event stream remains open', async () => {
    vi.useFakeTimers()
    route({
      '/api/remote/events': () => sseResponse().response,
      '/api/remote/rpc': (init) => new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }),
    })
    const web = getWebClient()
    web.connect()
    await vi.advanceTimersByTimeAsync(0)
    const requests = Promise.allSettled(Array.from({ length: 10 }, (_, i) => web.invoke('threads:list', `p${i}`)))
    await vi.advanceTimersByTimeAsync(20_000)
    expect((await requests).every((result) => result.status === 'rejected')).toBe(true)
    expect(await web.invoke('remote:getConnectionState')).toMatchObject({ phase: 'connected', rpcDegraded: true })
    const count = calls().length
    await expect(web.invoke('sessions:list', 't')).rejects.toThrow('REMOTE_REQUEST_TIMEOUT')
    expect(calls()).toHaveLength(count)
    await vi.advanceTimersByTimeAsync(30_000)
    route({ '/api/remote/rpc': () => json(200, { ok: true, value: [] }) })
    await expect(web.invoke('sessions:list', 't')).resolves.toEqual([])
    expect(await web.invoke('remote:getConnectionState')).toMatchObject({ phase: 'connected', rpcDegraded: false })
  })
  it('posts the channel and args to the RPC endpoint with the session cookie', async () => {
    route({ '/api/remote/rpc': () => json(200, { ok: true, value: [{ id: 'p1' }] }) })

    await expect(getWebClient().invoke('threads:list', 'p1')).resolves.toEqual([{ id: 'p1' }])

    const [call] = calls()
    expect(call.url).toBe('/api/remote/rpc')
    expect(call.init?.method).toBe('POST')
    expect(call.init?.credentials).toBe('same-origin')
    expect(JSON.parse(call.init?.body as string)).toEqual({ channel: 'threads:list', args: ['p1'] })
  })

  it('refuses a desktop-only channel before touching the network', async () => {
    await expect(getWebClient().invoke('shell:openExternal', 'https://x')).rejects.toThrow(/not available in the browser/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces the host error message from a failed RPC', async () => {
    route({ '/api/remote/rpc': () => json(500, { ok: false, error: 'git exploded' }) })
    await expect(getWebClient().invoke('projects:list')).rejects.toThrow('git exploded')
  })

  it('reports a 401 to unauthorized listeners and fails the call', async () => {
    route({ '/api/remote/rpc': () => json(401, { error: 'Unauthorized' }) })
    const web = getWebClient()
    const onUnauthorized = vi.fn()
    web.onUnauthorized(onUnauthorized)

    await expect(web.invoke('projects:list')).rejects.toThrow(/UNAUTHORIZED/)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('classifies a network failure the way the desktop classifies an unreachable host', async () => {
    route({})
    await expect(getWebClient().invoke('projects:list')).rejects.toThrow(/REMOTE_UNAVAILABLE/)
  })

  it('answers its own connection-state reads without a round trip', async () => {
    const web = getWebClient()
    const state = await web.invoke('remote:getConnectionState')
    expect(state.phase).toBe('local')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('serves app:getVersion from the health probe', async () => {
    route({ '/api/remote/health': () => json(200, { ok: true, app: 'PolyCode', version: '9.9.9' }) })
    await expect(getWebClient().invoke('app:getVersion')).resolves.toBe('9.9.9')
  })
})

describe('send', () => {
  it('forwards terminal input as a fire-and-forget RPC and drops desktop log writes', async () => {
    route({ '/api/remote/rpc': () => json(200, { ok: true }) })
    const web = getWebClient()

    web.send('terminal:write', 't1', 'ls\n')
    web.send('log:write', { level: 'info' })
    await flush()

    expect(calls()).toHaveLength(1)
    expect(JSON.parse(calls()[0].init?.body as string)).toEqual({ channel: 'terminal:write', args: ['t1', 'ls\n'] })
  })
})

describe('event stream', () => {
  it('demultiplexes host events to subscribers by channel and publishes connection state', async () => {
    const sse = sseResponse()
    route({ '/api/remote/events': () => sse.response })
    const web = getWebClient()
    const states: RemoteConnectionState[] = []
    const output = vi.fn()
    const other = vi.fn()
    web.on('remote:connection-changed', (s) => states.push(s as RemoteConnectionState))
    const off = web.on('thread:output:t1', output)
    web.on('thread:output:t2', other)

    web.connect()
    await flush()
    expect(states.map((s) => s.phase)).toEqual(['connecting', 'connected'])
    expect(states.at(-1)?.hostId).toBe(WEB_HOST_ID)

    sse.push('event: app\ndata: {"channel":"thread:output:t1","args":[{"type":"text","content":"hi"}]}\n\n')
    await flush()
    expect(output).toHaveBeenCalledWith({ type: 'text', content: 'hi' })
    expect(other).not.toHaveBeenCalled()

    off()
    sse.push('event: app\ndata: {"channel":"thread:output:t1","args":["again"]}\n\n')
    await flush()
    expect(output).toHaveBeenCalledTimes(1)

    const streamCall = calls().find((c) => c.url.endsWith('/api/remote/events'))
    expect(streamCall?.url).toBe('http://host.test/api/remote/events')
    expect(streamCall?.init?.credentials).toBe('same-origin')
  })

  it('drops back to sign-in when the stream itself is refused', async () => {
    route({ '/api/remote/events': () => json(401, { error: 'Unauthorized' }) })
    const web = getWebClient()
    const onUnauthorized = vi.fn()
    web.onUnauthorized(onUnauthorized)

    web.connect()
    await flush()

    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })
})

describe('session', () => {
  it('distinguishes signed-in, signed-out and unreachable hosts', async () => {
    const web = getWebClient()

    route({ '/api/remote/health': () => json(200, { ok: true, app: 'PolyCode', version: '1.0.0' }) })
    await expect(web.checkSession()).resolves.toBe('authenticated')

    route({ '/api/remote/health': () => json(401, { error: 'Unauthorized' }) })
    await expect(web.checkSession()).resolves.toBe('unauthenticated')

    route({})
    await expect(web.checkSession()).resolves.toBe('unreachable')
  })

  it('exchanges the token for a session and explains a refusal', async () => {
    const web = getWebClient()

    route({ '/api/remote/session': () => json(200, { ok: true }) })
    await expect(web.login('host-token')).resolves.toEqual({ ok: true })
    expect(JSON.parse(calls()[0].init?.body as string)).toEqual({ token: 'host-token' })
    expect(calls()[0].init?.credentials).toBe('same-origin')

    route({ '/api/remote/session': () => json(401, { error: 'Unauthorized' }) })
    await expect(web.login('nope')).resolves.toEqual({ ok: false, error: expect.stringMatching(/not accepted/) })

    route({ '/api/remote/session': () => json(429, { error: 'Too many attempts' }, { 'Retry-After': '42' }) })
    await expect(web.login('nope')).resolves.toEqual({ ok: false, error: expect.stringMatching(/42s/) })

    route({})
    await expect(web.login('x')).resolves.toEqual({ ok: false, error: expect.stringMatching(/Could not reach/) })
  })

  it('logs out by deleting the session', async () => {
    route({ '/api/remote/session': () => new Response(null, { status: 204 }) })
    await getWebClient().logout()
    expect(calls()[0].init?.method).toBe('DELETE')
  })
})
