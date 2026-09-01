import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const H = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  fetch: vi.fn<typeof fetch>(),
}))

vi.mock('electron', () => ({
  BrowserWindow: class {},
}))
vi.mock('../db/queries', () => ({
  getSetting: (key: string) => H.settings.get(key) ?? null,
  setSetting: (key: string, value: string) => H.settings.set(key, value),
}))
vi.mock('../app-events', () => ({ emitAppEvent: () => {}, sendToRenderer: () => {} }))

const { RemoteControlClient, RemoteUnavailableError } = await import('../remote/client')
const { RemoteRequestTimeoutError } = await import('../remote/client')

const host = {
  id: 'host-1',
  label: 'Studio',
  baseUrl: 'http://polycode.local:3285',
  token: 'secret',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}
const window = { webContents: { isDestroyed: () => false, send: () => {} } }

function activeClient(): InstanceType<typeof RemoteControlClient> {
  const client = new RemoteControlClient(window as unknown as import('electron').BrowserWindow)
  H.settings.set('remote:hosts', JSON.stringify([host]))
  H.settings.set('remote:activeHostId', host.id)
  return client
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('RemoteControlClient connectivity failures', () => {
  beforeEach(() => {
    H.settings.clear()
    H.fetch.mockReset()
    vi.stubGlobal('fetch', H.fetch)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('opens a circuit after transport loss and stops subsequent RPC fan-out', async () => {
    H.fetch.mockRejectedValue(new TypeError('fetch failed'))
    const client = activeClient()

    await expect(client.invokeIfActive('projects:list', [])).rejects.toMatchObject({
      name: 'RemoteUnavailableError',
      code: 'REMOTE_UNAVAILABLE',
      hostId: host.id,
    })
    await expect(client.invokeIfActive('threads:list', [])).rejects.toBeInstanceOf(RemoteUnavailableError)

    expect(H.fetch).toHaveBeenCalledTimes(1)
    client.stop()
  })

  it('turns a 421 health response into an actionable hostname mismatch', async () => {
    H.fetch.mockResolvedValue(jsonResponse(421, { error: 'Misdirected request' }))
    const client = new RemoteControlClient(window as unknown as import('electron').BrowserWindow)

    await expect(client.testHost({ label: host.label, baseUrl: host.baseUrl, token: host.token }))
      .resolves.toEqual({
        ok: false,
        error: 'The remote host rejected hostname "polycode.local". Use a URL whose hostname matches the remote server bind host.',
      })
    client.stop()
  })

  it('distinguishes an HTML 200 proxy response from a failed RPC', async () => {
    H.fetch.mockResolvedValue(new Response('<html><title>Sign in</title></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }))
    const client = activeClient()

    await expect(client.invokeIfActive('projects:list', [])).rejects.toThrow(
      'Remote host returned text/html instead of JSON (HTTP 200): <html><title>Sign in</title></html>',
    )
    client.stop()
  })

  it('times out a hung RPC and opens the unavailable circuit', async () => {
    vi.useFakeTimers()
    H.fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const client = activeClient()
    const request = client.invokeIfActive('projects:list', [])
    const verdict = expect(request).rejects.toMatchObject({ code: 'REMOTE_UNAVAILABLE' })

    await vi.advanceTimersByTimeAsync(10_000)
    await verdict
    await expect(client.invokeIfActive('threads:list', [])).rejects.toMatchObject({ code: 'REMOTE_UNAVAILABLE' })
    expect(H.fetch).toHaveBeenCalledTimes(1)
    client.stop()
  })

  /** A never-ending SSE event-stream response, so the client considers the host reachable. */
  function openEventStream(): Response {
    const body = new ReadableStream({ start: () => {} }) // never closes
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  function mockHealthyHostWithHungRpc(): void {
    H.fetch.mockImplementation((url, init) => {
      if (String(url).endsWith('/api/remote/events')) return Promise.resolve(openEventStream())
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    })
  }

  /** Like activeClient(), but the settings exist before construction, so the SSE stream starts. */
  function healthyClient(): InstanceType<typeof RemoteControlClient> {
    H.settings.set('remote:hosts', JSON.stringify([host]))
    H.settings.set('remote:activeHostId', host.id)
    return new RemoteControlClient(window as unknown as import('electron').BrowserWindow)
  }

  it('gives slow channels (worktree removal) a long budget while the host stays healthy', async () => {
    vi.useFakeTimers()
    mockHealthyHostWithHungRpc()
    const client = healthyClient()
    // Give the event stream a moment to connect.
    await vi.advanceTimersByTimeAsync(0)

    let outcome: unknown
    const request = client.invokeIfActive('locations:removeWorktree', ['loc1']).then(
      () => (outcome = 'resolved'),
      (error: unknown) => (outcome = error),
    )

    // The 10s default budget must not fire for a slow channel.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(outcome).toBeUndefined()
    await vi.advanceTimersByTimeAsync(289_000)
    expect(outcome).toBeUndefined()

    await vi.advanceTimersByTimeAsync(1_000)
    await request
    expect(outcome).toMatchObject({ code: 'REMOTE_REQUEST_TIMEOUT' })
    client.stop()
  })

  it('does not poison the circuit when a healthy host answers too slowly', async () => {
    vi.useFakeTimers()
    mockHealthyHostWithHungRpc()
    const client = healthyClient()
    await vi.advanceTimersByTimeAsync(0)

    const first = client.invokeIfActive('projects:list', []).then(
      () => 'resolved',
      (error: { code?: string }) => `rejected:${error.code}`,
    )
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await first).toBe('rejected:REMOTE_REQUEST_TIMEOUT')

    // The second call must hit fetch again rather than the cached circuit error.
    const second = client.invokeIfActive('projects:list', []).then(
      () => 'resolved',
      (error: unknown) => error,
    )
    await vi.advanceTimersByTimeAsync(10_000)
    const secondError = await second
    expect(secondError).toBeInstanceOf(RemoteRequestTimeoutError)
    expect(H.fetch.mock.calls.filter(([url]) => String(url).endsWith('/api/remote/rpc')).length).toBe(2)
    client.stop()
  })
})
