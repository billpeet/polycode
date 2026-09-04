import { randomUUID } from 'crypto'
import { BrowserWindow, powerMonitor } from 'electron'
import { isRemoteChannel, RemoteEventStream } from '@polycode/shared'
import { getSetting, setSetting } from '../db/queries'
import { emitAppEvent, sendToRenderer } from '../app-events'
import { count, recordDuration } from '../observability'
import {
  RemoteConnectionState,
  RemoteConnectionStatus,
  RemoteHost,
  RemoteHostInput,
} from '../../shared/types'

const REMOTE_HOSTS_KEY = 'remote:hosts'
const REMOTE_ACTIVE_HOST_KEY = 'remote:activeHostId'

interface RpcResponse {
  ok?: boolean
  value?: unknown
  error?: string
}

interface ProxyResult {
  handled: boolean
  value?: unknown
}

const RPC_TIMEOUT_MS = 10_000
// Text generation runs an LLM subprocess on the host. Match system-text's own two-minute
// command budget so the remote transport does not give up while that subprocess is healthy.
const TEXT_GENERATION_RPC_TIMEOUT_MS = 120_000
const TEXT_GENERATION_RPC_CHANNELS: ReadonlySet<string> = new Set([
  'git:generateCommitMessage',
  'git:generateCommitMessageWithContext',
  'git:generateBranchName',
  'git:generatePullRequestText',
])
// Channels whose host-side handler does the filesystem work inline (worktree removal is a
// `git worktree remove --force` plus a recursive delete of a directory that routinely holds
// `node_modules`). A 10s budget guarantees these fail on the client while the host happily
// finishes the job minutes later.
const SLOW_RPC_TIMEOUT_MS = 300_000
const SLOW_RPC_CHANNELS: ReadonlySet<string> = new Set([
  'locations:createWorktree',
  'locations:removeWorktree',
  'locations:clone',
  'projects:createFull',
])
const RESPONSE_DIAGNOSTIC_LIMIT = 240
// Reconnect backoff and the stall watchdog live in @polycode/shared's RemoteEventStream,
// which this client and the mobile app both consume.
// Lightweight GET /api/remote/health round trip, published as `latencyMs` on the
// connection state so the UI can show how far away the host actually is.
const LATENCY_PROBE_INTERVAL_MS = 30_000
const LATENCY_PROBE_TIMEOUT_MS = 5_000
// Ignore sub-jitter changes so the probe doesn't emit a connection-changed every 30s.
const LATENCY_EMIT_DELTA_MS = 15

export class RemoteUnavailableError extends Error {
  readonly code = 'REMOTE_UNAVAILABLE'

  constructor(
    readonly hostId: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'RemoteUnavailableError'
  }
}

/**
 * The request outlived its timeout budget, but the host is demonstrably reachable (the event
 * stream is up). Unlike `RemoteUnavailableError` this does NOT open the circuit: the host may
 * still be executing the very operation the client gave up waiting for.
 */
export class RemoteRequestTimeoutError extends Error {
  readonly code = 'REMOTE_REQUEST_TIMEOUT'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RemoteRequestTimeoutError'
  }
}

class RemoteProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RemoteProtocolError'
  }
}

let activeClient: RemoteControlClient | null = null

function readHosts(): RemoteHost[] {
  const raw = getSetting(REMOTE_HOSTS_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isRemoteHost)
  } catch {
    return []
  }
}

function writeHosts(hosts: RemoteHost[]): void {
  setSetting(REMOTE_HOSTS_KEY, JSON.stringify(hosts))
}

function isRemoteHost(value: unknown): value is RemoteHost {
  const host = value as RemoteHost
  return Boolean(
    host
      && typeof host.id === 'string'
      && typeof host.label === 'string'
      && typeof host.baseUrl === 'string'
      && typeof host.token === 'string'
      && typeof host.createdAt === 'string'
      && typeof host.updatedAt === 'string',
  )
}

function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('Remote URL is required')
  const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  const url = new URL(withProtocol)
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/+$/, '')
}

function normalizeHostInput(input: RemoteHostInput): RemoteHostInput {
  const label = input.label.trim()
  if (!label) throw new Error('Host label is required')
  const token = input.token.trim()
  if (!token) throw new Error('Host token is required')
  return {
    label,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    token,
  }
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readJsonResponse(response: Response): Promise<RpcResponse> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  const raw = await response.text()
  const diagnostic = raw.replace(/\s+/g, ' ').trim().slice(0, RESPONSE_DIAGNOSTIC_LIMIT)

  if (!contentType.includes('application/json')) {
    const mediaType = contentType.split(';', 1)[0] || 'an unknown content type'
    throw new RemoteProtocolError(
      `Remote host returned ${mediaType} instead of JSON (HTTP ${response.status})${diagnostic ? `: ${diagnostic}` : ''}`,
    )
  }

  try {
    return JSON.parse(raw) as RpcResponse
  } catch (error) {
    throw new RemoteProtocolError(
      `Remote host returned invalid JSON (HTTP ${response.status})${diagnostic ? `: ${diagnostic}` : ''}`,
      { cause: error },
    )
  }
}

function hostnameMismatchMessage(baseUrl: string): string {
  const hostname = new URL(baseUrl).hostname
  return `The remote host rejected hostname "${hostname}". Use a URL whose hostname matches the remote server bind host.`
}

function isTransportError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof DOMException && error.name === 'AbortError')
}

export class RemoteControlClient {
  private unavailable: { hostId: string; error: RemoteUnavailableError } | null = null
  private reconnectAttempt = 0
  /** Host the event stream is currently pointed at — callback context for the shared stream. */
  private streamHost: RemoteHost | null = null
  /**
   * The shared SSE client (frame parsing, backoff, generation guard, stall watchdog).
   * The callbacks map its lifecycle onto this client's connection-state machine and
   * circuit breaker; `onConnecting` is deliberately not registered — this client emits
   * `connecting` once per restart and `reconnecting` for retries, not per dial.
   */
  private readonly eventStream = new RemoteEventStream({
    onEvent: (event) => sendToRenderer(this.window, event.channel, ...event.args),
    onConnected: () => {
      const host = this.streamHost
      if (!host) return
      this.markAvailable(host.id)
      this.setConnectionState({ hostId: host.id, phase: 'connected', reconnectAttempt: 0, error: null })
      this.startLatencyProbe(host)
    },
    onStreamError: (message, cause) => {
      const host = this.streamHost
      if (host && isTransportError(cause)) this.markUnavailable(host, message, cause)
      console.warn('[remote-control] Event stream disconnected:', message)
    },
    onDisconnected: (info) => {
      const host = this.streamHost
      if (!host) return
      if (info.stalled) {
        console.warn(`[remote-control] Event stream stalled (${info.error}); forcing reconnect`)
      }
      this.reconnectAttempt = info.attempt
      count('polycode.remote.stream.reconnect', { 'reconnect.reason': info.stalled ? 'stall' : 'drop' })
      const open = this.unavailable
      const circuitOpen = open?.hostId === host.id
      this.setConnectionState({
        hostId: host.id,
        phase: circuitOpen ? 'unavailable' : 'reconnecting',
        reconnectAttempt: info.attempt,
        error: circuitOpen && open ? open.error.message : info.error,
      })
    },
  })

  /** True while an SSE event stream has an open, reading response to the active host. */
  private get streamConnected(): boolean {
    return this.eventStream.connected
  }
  private connectionState: RemoteConnectionState = {
    hostId: null,
    phase: 'local',
    reconnectAttempt: 0,
    error: null,
    latencyMs: null,
    changedAt: new Date().toISOString(),
  }
  private latencyMs: number | null = null
  private latencyTimer: NodeJS.Timeout | null = null
  /**
   * OS sleep is the canonical way to half-open the SSE stream's TCP connection. The stall
   * watchdog would notice within a minute; restarting on resume closes the gap immediately.
   */
  private readonly handleResume = (): void => {
    if (this.getActiveHost()) this.restartEventStream()
  }

  constructor(private readonly window: BrowserWindow) {
    powerMonitor.on('resume', this.handleResume)
    this.restartEventStream()
  }

  stop(): void {
    powerMonitor.off('resume', this.handleResume)
    this.stopLatencyProbe()
    this.eventStream.stop()
    this.streamHost = null
  }

  getConnectionState(): RemoteConnectionState {
    return this.connectionState
  }

  /** User-initiated retry: drop the circuit and dial the active host again from scratch. */
  reconnect(): RemoteConnectionState {
    this.restartEventStream()
    return this.connectionState
  }

  private setConnectionState(
    next: Omit<RemoteConnectionState, 'changedAt' | 'hostId' | 'latencyMs'> & { hostId?: string | null },
  ): void {
    const hostId = next.hostId !== undefined ? next.hostId : this.getActiveHost()?.id ?? null
    const current = this.connectionState
    if (
      current.hostId === hostId
      && current.phase === next.phase
      && current.reconnectAttempt === next.reconnectAttempt
      && current.error === next.error
      && current.latencyMs === this.latencyMs
    ) return
    this.connectionState = {
      hostId,
      phase: next.phase,
      reconnectAttempt: next.reconnectAttempt,
      error: next.error,
      latencyMs: this.latencyMs,
      changedAt: new Date().toISOString(),
    }
    emitAppEvent(this.window, 'remote:connection-changed', this.connectionState)
  }

  /** Re-emit the current state with a fresh latency reading, without a phase transition. */
  private publishLatency(latencyMs: number): void {
    const previous = this.latencyMs
    this.latencyMs = latencyMs
    if (previous !== null && Math.abs(previous - latencyMs) < LATENCY_EMIT_DELTA_MS) return
    const { hostId, phase, reconnectAttempt, error } = this.connectionState
    this.setConnectionState({ hostId, phase, reconnectAttempt, error })
  }

  private startLatencyProbe(host: RemoteHost): void {
    this.stopLatencyProbe()
    const probe = (): void => void this.probeLatency(host)
    this.latencyTimer = setInterval(probe, LATENCY_PROBE_INTERVAL_MS)
    probe()
  }

  private stopLatencyProbe(): void {
    if (this.latencyTimer) {
      clearInterval(this.latencyTimer)
      this.latencyTimer = null
    }
  }

  private async probeLatency(host: RemoteHost): Promise<void> {
    // The probe only reports how far away a *reachable* host is. When the circuit is open
    // or the stream is down, the watchdog and RPC paths own the failure story.
    if (!this.streamConnected || this.unavailable?.hostId === host.id) return
    if (this.getActiveHost()?.id !== host.id) return
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), LATENCY_PROBE_TIMEOUT_MS)
    const startedAt = Date.now()
    try {
      const response = await fetch(endpoint(host.baseUrl, '/api/remote/health'), {
        method: 'GET',
        headers: { Authorization: `Bearer ${host.token}` },
        signal: controller.signal,
      })
      if (!response.ok) return
      await response.text()
      const latencyMs = Date.now() - startedAt
      recordDuration('polycode.remote.health.rtt', latencyMs, { 'remote.host': host.label })
      this.publishLatency(latencyMs)
    } catch {
      // A failed probe is not a connectivity verdict — the stall watchdog is.
    } finally {
      clearTimeout(timer)
    }
  }

  getHosts(): RemoteHost[] {
    return readHosts()
  }

  getActiveHost(): RemoteHost | null {
    const activeId = getSetting(REMOTE_ACTIVE_HOST_KEY)
    if (!activeId) return null
    return this.getHosts().find((host) => host.id === activeId) ?? null
  }

  addHost(input: RemoteHostInput): RemoteHost {
    const normalized = normalizeHostInput(input)
    const now = new Date().toISOString()
    const host: RemoteHost = {
      id: randomUUID(),
      ...normalized,
      createdAt: now,
      updatedAt: now,
    }
    writeHosts([...this.getHosts(), host])
    emitAppEvent(this.window, 'remote:hosts-changed', this.getHosts())
    return host
  }

  updateHost(id: string, input: RemoteHostInput): RemoteHost {
    const normalized = normalizeHostInput(input)
    let updated: RemoteHost | null = null
    const hosts = this.getHosts().map((host) => {
      if (host.id !== id) return host
      updated = { ...host, ...normalized, updatedAt: new Date().toISOString() }
      return updated
    })
    if (!updated) throw new Error('Remote host not found')
    writeHosts(hosts)
    emitAppEvent(this.window, 'remote:hosts-changed', hosts)
    if (getSetting(REMOTE_ACTIVE_HOST_KEY) === id) this.restartEventStream()
    return updated
  }

  removeHost(id: string): void {
    const hosts = this.getHosts().filter((host) => host.id !== id)
    writeHosts(hosts)
    emitAppEvent(this.window, 'remote:hosts-changed', hosts)
    if (getSetting(REMOTE_ACTIVE_HOST_KEY) === id) {
      setSetting(REMOTE_ACTIVE_HOST_KEY, '')
      this.restartEventStream()
      emitAppEvent(this.window, 'remote:active-changed', null)
    }
  }

  setActiveHost(id: string | null): RemoteHost | null {
    if (!id) {
      setSetting(REMOTE_ACTIVE_HOST_KEY, '')
      this.restartEventStream()
      emitAppEvent(this.window, 'remote:active-changed', null)
      return null
    }

    const host = this.getHosts().find((candidate) => candidate.id === id)
    if (!host) throw new Error('Remote host not found')
    setSetting(REMOTE_ACTIVE_HOST_KEY, host.id)
    this.restartEventStream()
    emitAppEvent(this.window, 'remote:active-changed', host)
    return host
  }

  /**
   * Whether a channel is one a remote host could serve, and so a candidate for forwarding.
   *
   * `isRemoteChannel` rather than `CONTROL_RPC_CHANNELS`: the two are the same set —
   * `CONTROL_RPC_CHANNELS = new Set(REMOTE_CHANNELS)` and `isRemoteChannel` is a lookup in
   * exactly that set — but the constant lives in `control/control-rpc.ts`, which imports the
   * handler map, which needs this module's `RemoteControlClient` type. Reading the registry
   * straight from `@polycode/shared` removes that edge outright instead of leaving it to
   * `import type` discipline.
   */
  shouldProxy(channel: string): boolean {
    return isRemoteChannel(channel)
  }

  async invokeIfActive(channel: string, args: unknown[]): Promise<ProxyResult> {
    const host = this.getActiveHost()
    if (!host || !this.shouldProxy(channel)) return { handled: false }
    if (this.unavailable?.hostId === host.id) throw this.unavailable.error
    return { handled: true, value: await this.invoke(host, channel, args) }
  }

  async testHost(input: RemoteHostInput): Promise<RemoteConnectionStatus> {
    try {
      const normalized = normalizeHostInput(input)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      try {
        const response = await fetch(endpoint(normalized.baseUrl, '/api/remote/health'), {
          method: 'GET',
          headers: { Authorization: `Bearer ${normalized.token}` },
          signal: controller.signal,
        })
        const body = await readJsonResponse(response)
        if (response.ok && body.ok) return { ok: true }
        if (response.status === 421) return { ok: false, error: hostnameMismatchMessage(normalized.baseUrl) }
        return { ok: false, error: body.error ?? `HTTP ${response.status}` }
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  }

  private async invoke(host: RemoteHost, channel: string, args: unknown[]): Promise<unknown> {
    const controller = new AbortController()
    const timeoutMs = SLOW_RPC_CHANNELS.has(channel)
      ? SLOW_RPC_TIMEOUT_MS
      : TEXT_GENERATION_RPC_CHANNELS.has(channel)
        ? TEXT_GENERATION_RPC_TIMEOUT_MS
        : RPC_TIMEOUT_MS
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const startedAt = Date.now()
    // Remote round trips were previously invisible in telemetry: perf.ts times the outer
    // ipcMain.handle span, where a proxied call just looks like a slow local one.
    let outcome = 'ok'
    try {
      const response = await fetch(endpoint(host.baseUrl, '/api/remote/rpc'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${host.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ channel, args }),
        signal: controller.signal,
      })
      const body = await readJsonResponse(response)
      if (response.status === 421) {
        throw this.markUnavailable(host, hostnameMismatchMessage(host.baseUrl))
      }
      if (!response.ok || !body.ok) {
        throw new Error(body.error ?? `Remote request failed with HTTP ${response.status}`)
      }
      this.markAvailable(host.id)
      return body.value
    } catch (error) {
      if (!isTransportError(error)) {
        outcome = 'error'
        throw error
      }
      outcome = controller.signal.aborted && this.streamConnected ? 'timeout' : 'unavailable'
      if (controller.signal.aborted && this.streamConnected) {
        // The event stream to the same host is open, so this is not transport loss — the
        // request simply outlived its budget and may still be running host-side. Throwing
        // RemoteUnavailableError here would poison every later call behind the cached
        // circuit, while the host completes the operation in the background.
        throw new RemoteRequestTimeoutError(
          `Remote host "${host.label}" did not answer "${channel}" within ${Math.round(timeoutMs / 1000)}s; the operation may still be running on the host.`,
          { cause: error },
        )
      }
      throw this.markUnavailable(host, controller.signal.aborted ? 'Remote host request timed out' : errorMessage(error), error)
    } finally {
      clearTimeout(timer)
      recordDuration('polycode.remote.rpc.duration', Date.now() - startedAt, {
        'rpc.channel': channel,
        'rpc.outcome': outcome,
      })
    }
  }

  private restartEventStream(): void {
    this.eventStream.stop()
    this.unavailable = null
    this.reconnectAttempt = 0

    this.stopLatencyProbe()
    this.latencyMs = null

    const host = this.getActiveHost()
    this.streamHost = host
    if (!host) {
      this.setConnectionState({ hostId: null, phase: 'local', reconnectAttempt: 0, error: null })
      return
    }

    this.setConnectionState({ hostId: host.id, phase: 'connecting', reconnectAttempt: 0, error: null })
    this.eventStream.start({ baseUrl: host.baseUrl, token: host.token })
  }

  private markUnavailable(host: RemoteHost, detail: string, cause?: unknown): RemoteUnavailableError {
    if (this.unavailable?.hostId === host.id) return this.unavailable.error
    const error = new RemoteUnavailableError(
      host.id,
      `Remote host "${host.label}" is unavailable: ${detail}`,
      cause === undefined ? undefined : { cause },
    )
    this.unavailable = { hostId: host.id, error }
    this.setConnectionState({
      hostId: host.id,
      phase: 'unavailable',
      reconnectAttempt: this.reconnectAttempt,
      error: error.message,
    })
    return error
  }

  private markAvailable(hostId: string): void {
    if (this.unavailable?.hostId === hostId) this.unavailable = null
    this.reconnectAttempt = 0
    if (this.streamConnected && this.getActiveHost()?.id === hostId) {
      this.setConnectionState({ hostId, phase: 'connected', reconnectAttempt: 0, error: null })
    }
  }

}

/**
 * Construct the remote-control client for `window` and hand it back.
 *
 * The name is now a slight misnomer: this function registers no IPC handlers. It used to
 * register eleven `remote:*` channels, all of which are folded into the typed handler map in
 * `ipc/channel-handlers.ts` — the seven that are methods on this class reach the instance
 * through `LocalHandlerContext.remoteClient`, which is the value returned here.
 *
 * It is still the constructor call the caller wants, and the returned instance is what
 * `ipc/handlers.ts` closes over for three separate jobs: `ctx.remoteClient` for those seven
 * channels, `invokeIfActive` for the remote-forwarding hop on every dual-path channel and on
 * the two `terminal:*` `ipcMain.on` listeners, and `getActiveHost`/`shouldProxy` for
 * `attachments:saveFromPath`'s upload hop. Constructing it starts the SSE stream to the
 * active host, so the call is not a no-op even before any of that.
 */
export function registerRemoteControlIpcHandlers(window: BrowserWindow): RemoteControlClient {
  const client = new RemoteControlClient(window)
  activeClient = client
  return client
}

export function stopRemoteControlClient(): void {
  activeClient?.stop()
  activeClient = null
}
