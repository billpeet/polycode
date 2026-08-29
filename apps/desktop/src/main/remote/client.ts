import { randomUUID } from 'crypto'
import { BrowserWindow } from 'electron'
import { isRemoteChannel } from '@polycode/shared'
import { getSetting, setSetting } from '../db/queries'
import { emitAppEvent, sendToRenderer } from '../app-events'
import {
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
const RESPONSE_DIAGNOSTIC_LIMIT = 240
const RECONNECT_BASE_DELAY_MS = 2_000
const RECONNECT_MAX_DELAY_MS = 30_000

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

  constructor(private readonly window: BrowserWindow) {
    this.restartEventStream()
  }

  stop(): void {
    this.streamGeneration += 1
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.eventAbort?.abort()
    this.eventAbort = null
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
    const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
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
    if (!host) return

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

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (generation === this.streamGeneration) {
        const { done, value } = await reader.read()
        if (done) break
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
        if (isTransportError(error)) this.markUnavailable(host, errorMessage(error), error)
        console.warn('[remote-control] Event stream disconnected:', errorMessage(error))
      }
    } finally {
      if (this.eventAbort === controller) this.eventAbort = null
      if (generation === this.streamGeneration && !controller.signal.aborted) {
        const delay = Math.min(
          RECONNECT_BASE_DELAY_MS * (2 ** this.reconnectAttempt),
          RECONNECT_MAX_DELAY_MS,
        )
        this.reconnectAttempt += 1
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
    return error
  }

  private markAvailable(hostId: string): void {
    if (this.unavailable?.hostId === hostId) this.unavailable = null
    this.reconnectAttempt = 0
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
