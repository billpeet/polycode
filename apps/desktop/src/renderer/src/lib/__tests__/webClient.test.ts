import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteConnectionState } from '../../types/ipc'
import { getWebClient, resetWebClientForTests, WEB_HOST_ID } from '../webClient'
import { useSessionStore } from '../../stores/sessions'
import { settleBackgroundIpc } from '../backgroundIpc'

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
  it('keeps non-proxy HTTP failures observable with safe diagnostics and no retry', async () => {
    route({ '/api/remote/rpc': () => new Response('secret-token', { status: 500 }) })
    await expect(getWebClient().invoke('sessions:list', 't')).rejects.toThrow(
      /Remote request failed for "sessions:list".*HTTP 500.*body omitted/,
    )
    expect(calls()).toHaveLength(1)
  })

  it.each([502, 504])('retries a read after an isolated HTTP %s between successful RPCs', async (status) => {
    vi.useFakeTimers()
    let requestCount = 0
    route({ '/api/remote/rpc': () => ++requestCount === 2
      ? new Response('Bad gateway', { status, headers: { 'Content-Type': 'text/plain' } })
      : json(200, { ok: true, value: [] }),
    })
    const web = getWebClient()
    await expect(web.invoke('sessions:list', 't')).resolves.toEqual([])
    const request = web.invoke('sessions:list', 't')
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(request).resolves.toEqual([])
    expect(requestCount).toBe(3)
  })

  it('stops a pending proxy retry when the connection is disconnected', async () => {
    vi.useFakeTimers()
    route({ '/api/remote/rpc': () => new Response('Bad gateway', { status: 502 }) })
    const web = getWebClient()
    const result = Promise.allSettled([web.invoke('sessions:list', 't')])
    await vi.advanceTimersByTimeAsync(0)
    web.disconnect()
    await vi.advanceTimersByTimeAsync(1_000)
    expect((await result)[0].status).toBe('rejected')
    expect(calls()).toHaveLength(1)
  })

  it.each(['<html>secret-token https://private.test</html>', 'null', '{"error":"secret-token"}'])(
    'omits arbitrary proxy bodies and content-type parameters from diagnostics: %s', async (body) => {
      route({ '/api/remote/rpc': () => new Response(body, {
        status: 502, headers: { 'Content-Type': 'text/html; secret-token=https://private.test' },
      }) })
      const results = await Promise.allSettled([getWebClient().invoke('threads:setUnread', 't', true)])
      const result = results[0]
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') {
        expect(result.reason.message).toContain('body omitted')
        expect(result.reason.message).not.toMatch(/secret-token|private\.test|<html>/)
      }
    },
  )

  it('settles a fire-and-forget background update on a proxy failure without retrying it', async () => {
    route({ '/api/remote/rpc': () => new Response('Bad gateway', { status: 502 }) })
    await expect(settleBackgroundIpc(getWebClient().invoke('threads:setUnread', 't', false))).resolves.toBeUndefined()
    expect(calls()).toHaveLength(1)
  })

  it('settles a background refresh after proxy failures, keeps its cache, and recovers', async () => {
    vi.useFakeTimers()
    let failing = false
    route({
      '/api/remote/events': () => sseResponse().response,
      '/api/remote/rpc': () => failing
        ? new Response('<html>Bad gateway secret-token</html>', { status: 502, headers: { 'Content-Type': 'text/html' } })
        : json(200, { ok: true, value: [{ id: 'cached' }] }),
    })
    const web = getWebClient()
    web.connect()
    await vi.advanceTimersByTimeAsync(0)
    await useSessionStore.getState().fetch('t')
    const cached = useSessionStore.getState().sessionsByThread.t
    failing = true
    const refresh = useSessionStore.getState().fetch('t')
    const settled = Promise.allSettled([refresh])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await settled).toEqual([{ status: 'fulfilled', value: undefined }])
    expect(useSessionStore.getState().sessionsByThread.t).toBe(cached)
    expect(calls().filter((call) => call.url === '/api/remote/rpc')).toHaveLength(4)
    expect(await web.invoke('remote:getConnectionState')).toMatchObject({ phase: 'unavailable' })
    failing = false
    await useSessionStore.getState().fetch('t')
    expect(await web.invoke('remote:getConnectionState')).toMatchObject({ phase: 'connected', error: null })
  })

  it.each([502, 504])('does not replay a mutation after HTTP %s and exposes safe diagnostics', async (status) => {
    route({ '/api/remote/rpc': () => new Response('<html>secret-token https://private.test</html>', {
      status, headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }) })
    await expect(getWebClient().invoke('threads:setUnread', 't', true)).rejects.toThrow(
      new RegExp(`REMOTE_UNAVAILABLE.*threads:setUnread.*HTTP ${status}.*text/html.*non-JSON.*may have.*Retry`),
    )
    expect(calls()).toHaveLength(1)
  })

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
  it('retries a request the busy host refused unstarted', async () => {
    vi.useFakeTimers()
    let refusals = 2
    route({
      '/api/remote/rpc': () => refusals-- > 0
        ? json(503, { ok: false, code: 'REMOTE_HOST_BUSY', error: '[REMOTE_REQUEST_TIMEOUT] Remote host is busy. This request was not started; retry shortly.' }, { 'Retry-After': '1' })
        : json(200, { ok: true, value: [{ id: 's1' }] }),
    })
    const request = getWebClient().invoke('skills:list', 'claude-code', null)
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(request).resolves.toEqual([{ id: 's1' }])
    expect(calls().filter((call) => call.url === '/api/remote/rpc')).toHaveLength(3)
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
