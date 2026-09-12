import {
  RemoteEventStream,
  createSlowInvokeTracker,
  isRemoteChannel,
  rpcTimeoutMs,
  type ChannelArgs,
  type ChannelResult,
  type LocalChannel,
  type RemoteConnectionState,
  type SseAppEvent,
} from '@polycode/shared'
import type { Client, ClientCapabilities } from './client'

/**
 * The renderer's client when it runs in a browser served by a Remote Host.
 *
 * Same interface as the preload bridge, different wire: `invoke` is `POST /api/remote/rpc`,
 * `on` is a demultiplexer over one `GET /api/remote/events` SSE stream, and `send` is an
 * `invoke` whose result nobody waits for. The page is served from the host itself, so every
 * request is same-origin and rides on the `HttpOnly` session cookie — no token ever reaches
 * this code (see main/remote/sessions.ts for why).
 *
 * Connection state is published on `remote:connection-changed` in exactly the shape the
 * desktop's RemoteControlClient uses, so the banner, the title-bar dot and the stores'
 * "refetch after a gap" logic work unchanged.
 */

/** A browser has none of the desktop-only surfaces. */
export const WEB_CAPABILITIES: ClientCapabilities = Object.freeze({
  windowControls: false,
  shell: false,
  nativeDialogs: false,
  browserPanel: false,
  updates: false,
  remoteHosts: false,
  routines: false,
  webhook: false,
})

/** The pseudo host id under which connection state is published. */
export const WEB_HOST_ID = 'web'

export type SessionCheck = 'authenticated' | 'unauthenticated' | 'unreachable'
export type LoginResult = { ok: true } | { ok: false; error: string }

export interface WebClient extends Client {
  kind: 'web'
  /** Dial the event stream. Call once the session is known to be valid. */
  connect(): void
  disconnect(): void
  /** Whether the browser currently holds a session the host accepts. */
  checkSession(): Promise<SessionCheck>
  /** Exchange the host token for a session cookie. */
  login(token: string): Promise<LoginResult>
  logout(): Promise<void>
  /** The host answered 401: the session expired or was revoked. */
  onUnauthorized(listener: () => void): () => void
}

interface RpcResponse {
  ok?: boolean
  value?: unknown
  error?: string
}

type Listener = (...args: unknown[]) => void

/** `remote:*` reads the renderer makes about its own connection, answered here. */
const LOCAL_CHANNELS = new Set<string>(['remote:getConnectionState', 'remote:reconnect', 'app:getVersion'])

function isTransportError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof DOMException && error.name === 'AbortError')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readJson(response: Response): Promise<RpcResponse> {
  try {
    return (await response.json()) as RpcResponse
  } catch {
    return {}
  }
}

class BrowserClient implements WebClient {
  readonly kind = 'web' as const
  readonly capabilities = WEB_CAPABILITIES
  readonly systemLocale = undefined

  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly unauthorizedListeners = new Set<() => void>()
  private readonly slowInvokes = createSlowInvokeTracker()
  private version: string | null = null
  /** Set by an RPC that could not reach the host; cleared by the next success. */
  private unavailable = false
  private state: RemoteConnectionState = {
    hostId: null,
    phase: 'local',
    reconnectAttempt: 0,
    error: null,
    latencyMs: null,
    changedAt: new Date(0).toISOString(),
  }

  private readonly stream = new RemoteEventStream(
    {
      onEvent: (event) => this.dispatch(event),
      onConnected: () => {
        this.unavailable = false
        this.setState({ phase: 'connected', reconnectAttempt: 0, error: null })
      },
      onStreamError: (message) => {
        if (/HTTP 401\b/.test(message)) {
          this.stream.stop()
          this.notifyUnauthorized()
        }
      },
      onDisconnected: (info) => {
        this.setState({
          phase: this.unavailable ? 'unavailable' : 'reconnecting',
          reconnectAttempt: info.attempt,
          error: info.error,
        })
      },
    },
    {
      // The cookie carries auth; the stream's bearer header would be empty and misleading.
      fetchFn: (url, init) => fetch(url, { method: 'GET', credentials: 'same-origin', signal: init.signal }),
    },
  )

  // ── Client ─────────────────────────────────────────────────────────────────

  invoke<C extends LocalChannel>(channel: C, ...args: ChannelArgs<C>): Promise<ChannelResult<C>> {
    return this.invokeUntyped(channel, args) as Promise<ChannelResult<C>>
  }

  private async invokeUntyped(channel: string, args: unknown[]): Promise<unknown> {
    if (LOCAL_CHANNELS.has(channel)) return this.answerLocally(channel)
    if (!isRemoteChannel(channel)) {
      throw new Error(`Channel "${channel}" is not available in the browser`)
    }
    const pending = this.rpc(channel, args)
    this.slowInvokes.track(pending)
    return pending
  }

  private async answerLocally(channel: string): Promise<unknown> {
    switch (channel) {
      case 'remote:getConnectionState':
        return this.state
      case 'remote:reconnect':
        this.connect()
        return this.state
      case 'app:getVersion':
        if (this.version === null) await this.checkSession()
        return this.version ?? ''
      default:
        throw new Error(`Unhandled local channel "${channel}"`)
    }
  }

  on(channel: string, callback: Listener): () => void {
    let set = this.listeners.get(channel)
    if (!set) {
      set = new Set()
      this.listeners.set(channel, set)
    }
    set.add(callback)
    return () => {
      set.delete(callback)
      if (set.size === 0) this.listeners.delete(channel)
    }
  }

  send(channel: string, ...args: unknown[]): void {
    // Terminal input is the one fire-and-forget path with a host-side effect. Log and
    // telemetry writes are for the desktop's log file, which a browser has no claim on.
    if (channel === 'terminal:write' || channel === 'terminal:resize') {
      void this.rpc(channel, args).catch(() => undefined)
    }
  }

  onSlowInvoke(callback: (pendingSlowCalls: number) => void): () => void {
    return this.slowInvokes.subscribe(callback)
  }

  // ── WebClient ──────────────────────────────────────────────────────────────

  connect(): void {
    this.unavailable = false
    this.setState({ phase: 'connecting', reconnectAttempt: 0, error: null })
    this.stream.start({ baseUrl: window.location.origin, token: '' })
  }

  disconnect(): void {
    this.stream.stop()
    this.setState({ phase: 'local', reconnectAttempt: 0, error: null, hostId: null })
  }

  async checkSession(): Promise<SessionCheck> {
    try {
      const response = await fetch('/api/remote/health', { credentials: 'same-origin' })
      if (response.status === 401) return 'unauthenticated'
      if (!response.ok) return 'unreachable'
      const body = (await readJson(response)) as { version?: unknown }
      if (typeof body.version === 'string') this.version = body.version
      return 'authenticated'
    } catch {
      return 'unreachable'
    }
  }

  async login(token: string): Promise<LoginResult> {
    try {
      const response = await fetch('/api/remote/session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (response.ok) return { ok: true }
      if (response.status === 401) return { ok: false, error: 'That token was not accepted.' }
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after')) || 60
        return { ok: false, error: `Too many attempts — try again in ${retryAfter}s.` }
      }
      const body = await readJson(response)
      return { ok: false, error: body.error ?? `Sign-in failed with HTTP ${response.status}` }
    } catch (error) {
      return { ok: false, error: `Could not reach the host: ${errorMessage(error)}` }
    }
  }

  async logout(): Promise<void> {
    this.disconnect()
    try {
      await fetch('/api/remote/session', { method: 'DELETE', credentials: 'same-origin' })
    } catch {
      // The cookie is gone from our side regardless; the host forgets it on restart.
    }
  }

  onUnauthorized(listener: () => void): () => void {
    this.unauthorizedListeners.add(listener)
    return () => this.unauthorizedListeners.delete(listener)
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async rpc(channel: string, args: unknown[]): Promise<unknown> {
    const controller = new AbortController()
    const timeoutMs = rpcTimeoutMs(channel)
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      let response: Response
      try {
        response = await fetch('/api/remote/rpc', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel, args }),
          signal: controller.signal,
        })
      } catch (error) {
        if (!isTransportError(error)) throw error
        throw this.transportFailure(channel, error, controller.signal.aborted, timeoutMs)
      }
      if (response.status === 401) {
        this.notifyUnauthorized()
        throw new Error('[UNAUTHORIZED] The host no longer accepts this session')
      }
      const body = await readJson(response)
      if (!response.ok || !body.ok) {
        throw new Error(body.error ?? `Remote request failed with HTTP ${response.status}`)
      }
      this.unavailable = false
      return body.value
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * The error codes match what `lib/remoteErrors.ts` classifies for the desktop's proxied
   * calls, so stores treat a browser transport failure the same way: keep last-good data
   * and let the banner explain.
   */
  private transportFailure(channel: string, cause: unknown, timedOut: boolean, timeoutMs: number): Error {
    if (timedOut && this.stream.connected) {
      return new Error(
        `[REMOTE_REQUEST_TIMEOUT] The host did not answer "${channel}" within ${Math.round(timeoutMs / 1000)}s; the operation may still be running on the host.`,
        { cause },
      )
    }
    const detail = timedOut ? 'request timed out' : errorMessage(cause)
    this.unavailable = true
    if (this.state.phase === 'connected') {
      this.setState({ phase: 'unavailable', reconnectAttempt: this.state.reconnectAttempt, error: detail })
    }
    return new Error(`[REMOTE_UNAVAILABLE] The host is unreachable: ${detail}`, { cause })
  }

  private dispatch(event: SseAppEvent): void {
    const set = this.listeners.get(event.channel)
    if (!set) return
    for (const listener of [...set]) {
      try {
        listener(...event.args)
      } catch (error) {
        console.error(`[web-client] Listener for "${event.channel}" threw`, error)
      }
    }
  }

  private setState(
    next: Omit<RemoteConnectionState, 'changedAt' | 'hostId' | 'latencyMs'> & { hostId?: string | null },
  ): void {
    const hostId = next.hostId !== undefined ? next.hostId : WEB_HOST_ID
    const current = this.state
    if (
      current.hostId === hostId
      && current.phase === next.phase
      && current.reconnectAttempt === next.reconnectAttempt
      && current.error === next.error
    ) return
    this.state = {
      hostId,
      phase: next.phase,
      reconnectAttempt: next.reconnectAttempt,
      error: next.error,
      latencyMs: null,
      changedAt: new Date().toISOString(),
    }
    this.dispatch({ channel: 'remote:connection-changed', args: [this.state] })
  }

  private notifyUnauthorized(): void {
    for (const listener of [...this.unauthorizedListeners]) listener()
  }
}

let instance: WebClient | null = null

/** The browser client, created on first use. Only ever constructed when there is no preload. */
export function getWebClient(): WebClient {
  if (!instance) instance = new BrowserClient()
  return instance
}

/** Test seam: drop the singleton so each case starts from a fresh client. */
export function resetWebClientForTests(): void {
  instance?.disconnect()
  instance = null
}
