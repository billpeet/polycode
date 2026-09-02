import { randomUUID } from 'crypto'
import { BrowserWindow, powerMonitor } from 'electron'
import { isRemoteChannel } from '@polycode/shared'
import { getSetting, setSetting } from '../db/queries'
import { emitAppEvent, sendToRenderer } from '../app-events'
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
const RECONNECT_BASE_DELAY_MS = 2_000
const RECONNECT_MAX_DELAY_MS = 30_000
// The host writes a `: keepalive` comment every 25s (server.ts), so a healthy stream is
// never silent for long. Two missed keepalives plus slack means the TCP connection is
// half-open (laptop sleep, Wi-Fi drop) even though `reader.read()` is still pending —
// without this watchdog `streamConnected` would stay true forever and no reconnect fires.
const STREAM_STALL_TIMEOUT_MS = 60_000
const STREAM_STALL_CHECK_INTERVAL_MS = 15_000

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
  private eventAbort: AbortController | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private streamGeneration = 0
  private unavailable: { hostId: string; error: RemoteUnavailableError } | null = null
  private reconnectAttempt = 0
  /** True while an SSE event stream has an open, reading response to the active host. */
  private streamConnected = false
  private connectionState: RemoteConnectionState = {
    hostId: null,
    phase: 'local',
    reconnectAttempt: 0,
    error: null,
    changedAt: new Date().toISOString(),
  }
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
    this.streamGeneration += 1
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.eventAbort?.abort()
    this.eventAbort = null
    this.streamConnected = false
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
    next: Omit<RemoteConnectionState, 'changedAt' | 'hostId'> & { hostId?: string | null },
  ): void {
    const hostId = next.hostId !== undefined ? next.hostId : this.getActiveHost()?.id ?? null
    const current = this.connectionState
    if (
      current.hostId === hostId
      && current.phase === next.phase
      && current.reconnectAttempt === next.reconnectAttempt
      && current.error === next.error
    ) return
    this.connectionState = {
      hostId,
      phase: next.phase,
      reconnectAttempt: next.reconnectAttempt,
      error: next.error,
      changedAt: new Date().toISOString(),
    }
    emitAppEvent(this.window, 'remote:connection-changed', this.connectionState)
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
    const timeoutMs = SLOW_RPC_CHANNELS.has(channel) ? SLOW_RPC_TIMEOUT_MS : RPC_TIMEOUT_MS
    const timer = setTimeout(() => controller.abort(), timeoutMs)
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
      if (!isTransportError(error)) throw error
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
    }
  }

  private restartEventStream(): void {
    this.streamGeneration += 1
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.eventAbort?.abort()
    this.eventAbort = null
    this.unavailable = null
    this.reconnectAttempt = 0

    const host = this.getActiveHost()
    if (!host) {
      this.setConnectionState({ hostId: null, phase: 'local', reconnectAttempt: 0, error: null })
      return
    }

    this.streamConnected = false
    this.setConnectionState({ hostId: host.id, phase: 'connecting', reconnectAttempt: 0, error: null })
    const generation = this.streamGeneration
    this.connectEventStream(host, generation, 0)
  }

  private connectEventStream(host: RemoteHost, generation: number, delayMs: number): void {
    if (delayMs > 0) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        void this.runEventStream(host, generation)
      }, delayMs)
      return
    }
    void this.runEventStream(host, generation)
  }

  private async runEventStream(host: RemoteHost, generation: number): Promise<void> {
    if (generation !== this.streamGeneration) return
    const controller = new AbortController()
    this.eventAbort = controller

    // Stall watchdog. Armed before the fetch so a connect that hangs forever is also
    // bounded. `stalled` distinguishes a watchdog abort (reconnect) from an intentional
    // one (stop / restart), which the finally block must not resurrect.
    let lastActivityAt = Date.now()
    let stalled = false
    let streamError: string | null = null
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivityAt <= STREAM_STALL_TIMEOUT_MS) return
      stalled = true
      streamError = `No data from remote host for ${Math.round(STREAM_STALL_TIMEOUT_MS / 1000)}s`
      console.warn(`[remote-control] Event stream stalled (${streamError}); forcing reconnect`)
      controller.abort()
    }, STREAM_STALL_CHECK_INTERVAL_MS)

    try {
      const response = await fetch(endpoint(host.baseUrl, '/api/remote/events'), {
        method: 'GET',
        headers: { Authorization: `Bearer ${host.token}` },
        signal: controller.signal,
      })
      if (!response.ok || !response.body) {
        throw new Error(`Remote event stream failed with HTTP ${response.status}`)
      }

      this.markAvailable(host.id)
      this.streamConnected = true
      this.setConnectionState({ hostId: host.id, phase: 'connected', reconnectAttempt: 0, error: null })

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (generation === this.streamGeneration) {
        const { done, value } = await reader.read()
        if (done) break
        // Any bytes count as liveness — including the `: keepalive` comments the frame
        // parser below deliberately discards.
        lastActivityAt = Date.now()
        buffer += decoder.decode(value, { stream: true })
        let separator = buffer.indexOf('\n\n')
        while (separator !== -1) {
          const frame = buffer.slice(0, separator)
          buffer = buffer.slice(separator + 2)
          this.handleSseFrame(frame)
          separator = buffer.indexOf('\n\n')
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        streamError = errorMessage(error)
        if (isTransportError(error)) this.markUnavailable(host, streamError, error)
        console.warn('[remote-control] Event stream disconnected:', streamError)
      }
    } finally {
      clearInterval(watchdog)
      if (this.eventAbort === controller) {
        this.eventAbort = null
        this.streamConnected = false
      }
      // A stalled abort is the watchdog's, not stop()/restart's, so it must reconnect.
      if (generation === this.streamGeneration && (!controller.signal.aborted || stalled)) {
        const delay = Math.min(
          RECONNECT_BASE_DELAY_MS * (2 ** this.reconnectAttempt),
          RECONNECT_MAX_DELAY_MS,
        )
        this.reconnectAttempt += 1
        this.setConnectionState({
          hostId: host.id,
          phase: this.unavailable?.hostId === host.id ? 'unavailable' : 'reconnecting',
          reconnectAttempt: this.reconnectAttempt,
          error: this.unavailable?.hostId === host.id
            ? this.unavailable.error.message
            : streamError,
        })
        this.connectEventStream(host, generation, delay)
      }
    }
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

  private handleSseFrame(frame: string): void {
    const lines = frame.split(/\r?\n/)
    let eventName = 'message'
    const dataLines: string[] = []

    for (const line of lines) {
      if (!line || line.startsWith(':')) continue
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart())
      }
    }

    if (eventName !== 'app' || dataLines.length === 0) return

    try {
      const event = JSON.parse(dataLines.join('\n')) as { channel?: unknown; args?: unknown }
      if (typeof event.channel !== 'string' || !Array.isArray(event.args)) return
      sendToRenderer(this.window, event.channel, ...event.args)
    } catch {
      // Ignore malformed frames from a stale or incompatible host.
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
