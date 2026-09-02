import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const H = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  fetch: vi.fn<typeof fetch>(),
  appEvents: [] as Array<{ channel: string; args: unknown[] }>,
}))

vi.mock('electron', () => ({
  BrowserWindow: class {},
  powerMonitor: { on: () => {}, off: () => {} },
}))
vi.mock('../db/queries', () => ({
  getSetting: (key: string) => H.settings.get(key) ?? null,
  setSetting: (key: string, value: string) => H.settings.set(key, value),
}))
vi.mock('../app-events', () => ({
  emitAppEvent: (_window: unknown, channel: string, ...args: unknown[]) =>
    H.appEvents.push({ channel, args }),
  sendToRenderer: () => {},
}))

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
    H.appEvents.length = 0
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

  /**
   * A healthy SSE event-stream response: never closes, and — like the real host — writes a
   * keepalive comment every 25s so the client's stall watchdog sees activity. Driven by
   * fake timers in the tests that use it.
   */
  function openEventStream(): Response {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        setInterval(() => controller.enqueue(new TextEncoder().encode(`: ${Date.now()}\n\n`)), 25_000)
      },
    })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  /**
   * An SSE response that connects but then never sends a byte — a half-open connection.
   * Wired to the request's abort signal the way real fetch is: aborting rejects a pending
   * `reader.read()`.
   */
  function silentEventStream(signal: AbortSignal | null | undefined): Response {
    const body = new ReadableStream({
      start: (controller) => {
        signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
      },
    })
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

  function connectionPhases(): string[] {
    return H.appEvents
      .filter((event) => event.channel === 'remote:connection-changed')
      .map((event) => (event.args[0] as { phase: string }).phase)
  }

  function eventStreamConnects(): number {
    return H.fetch.mock.calls.filter(([url]) => String(url).endsWith('/api/remote/events')).length
  }

  it('emits connecting → connected transitions for the renderer', async () => {
    vi.useFakeTimers()
    H.fetch.mockImplementation(() => Promise.resolve(openEventStream()))
    const client = healthyClient()
    await vi.advanceTimersByTimeAsync(0)

    expect(connectionPhases()).toEqual(['connecting', 'connected'])
    client.stop()
  })

  it('keeps a keepalive-fed stream connected without spurious reconnects', async () => {
    vi.useFakeTimers()
    H.fetch.mockImplementation(() => Promise.resolve(openEventStream()))
    const client = healthyClient()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(eventStreamConnects()).toBe(1)
    expect(connectionPhases()).toEqual(['connecting', 'connected'])
    client.stop()
  })

  it('detects a half-open stream via the stall watchdog and reconnects', async () => {
    vi.useFakeTimers()
    H.fetch.mockImplementation((_url, init) => Promise.resolve(silentEventStream(init?.signal)))
    const client = healthyClient()
    await vi.advanceTimersByTimeAsync(0)
    expect(eventStreamConnects()).toBe(1)

    // No bytes ever arrive. The watchdog (15s checks, 60s budget) must abort and redial.
    await vi.advanceTimersByTimeAsync(80_000)
    expect(eventStreamConnects()).toBeGreaterThanOrEqual(2)
    expect(connectionPhases()).toContain('reconnecting')
    expect(connectionPhases().at(-1)).toBe('connected')
    client.stop()
  })

  it('probes host latency and publishes it on the connection state', async () => {
    vi.useFakeTimers()
    H.fetch.mockImplementation((url) => {
      if (String(url).endsWith('/api/remote/health')) {
        return Promise.resolve(jsonResponse(200, { ok: true, app: 'polycode', version: '1.0.0' }))
      }
      return Promise.resolve(openEventStream())
    })
    const client = healthyClient()
    await vi.advanceTimersByTimeAsync(0)

    const latencies = H.appEvents
      .filter((event) => event.channel === 'remote:connection-changed')
      .map((event) => (event.args[0] as { latencyMs: number | null }).latencyMs)
    // The immediate probe after connect publishes a reading (0ms under fake timers).
    expect(latencies.at(-1)).toBe(0)
    expect(client.getConnectionState().phase).toBe('connected')

    // Subsequent probes fire on the 30s interval without a phase transition.
    const healthCalls = () =>
      H.fetch.mock.calls.filter(([url]) => String(url).endsWith('/api/remote/health')).length
    const before = healthCalls()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(healthCalls()).toBe(before + 1)
    client.stop()
  })

  it('reports the open circuit as an unavailable connection state', async () => {
    H.fetch.mockRejectedValue(new TypeError('fetch failed'))
    const client = activeClient()

    await expect(client.invokeIfActive('projects:list', [])).rejects.toBeInstanceOf(RemoteUnavailableError)
    const last = H.appEvents
      .filter((event) => event.channel === 'remote:connection-changed')
      .at(-1)?.args[0] as { phase: string; hostId: string; error: string | null }
    expect(last.phase).toBe('unavailable')
    expect(last.hostId).toBe(host.id)
    expect(last.error).toContain('unavailable')
    client.stop()
  })
})
