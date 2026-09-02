/**
 * Shared SSE event-stream client for GET /api/remote/events.
 *
 * One implementation of the frame parser, read loop, exponential reconnect backoff,
 * generation guard and stall watchdog, consumed by both the desktop controller
 * (apps/desktop/src/main/remote/client.ts) and the mobile app (apps/mobile/src/api/sse.ts).
 * The two previously carried hand-copied variants that had already drifted: mobile had a
 * flat 2s retry and no stall detection, desktop had no per-attempt connecting signal.
 *
 * Environment differences are injected rather than branched on: the fetch implementation
 * (Electron main's global fetch vs expo/fetch — React Native's global fetch buffers the
 * whole response) and the callbacks that map stream lifecycle onto each app's
 * connection-state model. This module stays dependency-free and side-effect-free: no
 * logging, no timers beyond its own reconnect/watchdog, nothing Electron- or RN-specific.
 */

export interface EventStreamTarget {
  baseUrl: string
  token: string
}

export interface SseAppEvent {
  channel: string
  args: unknown[]
}

/** Minimal structural view of a fetch Response, satisfied by both undici and expo/fetch. */
export interface EventStreamResponse {
  ok: boolean
  status: number
  body: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>
    }
  } | null
}

export type EventStreamFetch = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal },
) => Promise<EventStreamResponse>

export interface EventStreamDisconnect {
  /** Human-readable reason, when one is known. */
  error: string | null
  /** Consecutive failed or dropped dials against this target, including this one. */
  attempt: number
  /** Delay before the next dial. */
  delayMs: number
  /** True when the stall watchdog killed a silent connection, false on an outright drop. */
  stalled: boolean
}

export interface EventStreamCallbacks {
  /** A well-formed `event: app` frame arrived. */
  onEvent: (event: SseAppEvent) => void
  /** A dial is starting — fires for the initial connect and for every retry. */
  onConnecting?: () => void
  /**
   * The stream is open and reading. There is no replay: anything emitted while the
   * stream was down is gone, so refetch pushed state here.
   */
  onConnected?: () => void
  /** The stream dropped or stalled; a reconnect is already scheduled per the info. */
  onDisconnected?: (info: EventStreamDisconnect) => void
  /** A non-abort error terminated the connect or read. Fires before onDisconnected. */
  onStreamError?: (message: string, cause: unknown) => void
}

export interface EventStreamOptions {
  /** Defaults to the global fetch. */
  fetchFn?: EventStreamFetch
  reconnectBaseDelayMs?: number
  reconnectMaxDelayMs?: number
  stallTimeoutMs?: number
  stallCheckIntervalMs?: number
}

const RECONNECT_BASE_DELAY_MS = 2_000
const RECONNECT_MAX_DELAY_MS = 30_000
// The host writes a `: keepalive` comment every 25s (remote/server.ts), so a healthy
// stream is never silent for long. Two missed keepalives plus slack means the TCP
// connection is half-open (laptop sleep, Wi-Fi drop, phone lock) even though the pending
// read never rejects — without the watchdog `connected` would stay true forever.
const STREAM_STALL_TIMEOUT_MS = 60_000
const STREAM_STALL_CHECK_INTERVAL_MS = 15_000

/** Parse one SSE frame; returns the app event it carries, or null for anything else. */
export function parseSseFrame(frame: string): SseAppEvent | null {
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

  if (eventName !== 'app' || dataLines.length === 0) return null

  try {
    const event = JSON.parse(dataLines.join('\n')) as { channel?: unknown; args?: unknown }
    if (typeof event.channel !== 'string' || !Array.isArray(event.args)) return null
    return { channel: event.channel, args: event.args }
  } catch {
    // Malformed frame from a stale or incompatible host.
    return null
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class RemoteEventStream {
  private generation = 0
  private abort: AbortController | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private streaming = false
  private readonly fetchFn: EventStreamFetch
  private readonly reconnectBaseDelayMs: number
  private readonly reconnectMaxDelayMs: number
  private readonly stallTimeoutMs: number
  private readonly stallCheckIntervalMs: number

  constructor(
    private readonly callbacks: EventStreamCallbacks,
    options: EventStreamOptions = {},
  ) {
    // Bound at call time, not construction, so a test-stubbed global fetch is honoured.
    this.fetchFn = options.fetchFn
      ?? ((url, init) => fetch(url, init) as unknown as Promise<EventStreamResponse>)
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? RECONNECT_BASE_DELAY_MS
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? RECONNECT_MAX_DELAY_MS
    this.stallTimeoutMs = options.stallTimeoutMs ?? STREAM_STALL_TIMEOUT_MS
    this.stallCheckIntervalMs = options.stallCheckIntervalMs ?? STREAM_STALL_CHECK_INTERVAL_MS
  }

  /** True while a response is open and being read. */
  get connected(): boolean {
    return this.streaming
  }

  /** Dial `target`, tearing down any previous stream first. */
  start(target: EventStreamTarget): void {
    this.stop()
    this.attempt = 0
    void this.run(target, this.generation)
  }

  /** Tear down the stream and cancel any pending reconnect. Safe to call repeatedly. */
  stop(): void {
    this.generation += 1
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.abort?.abort()
    this.abort = null
    this.streaming = false
  }

  private async run(target: EventStreamTarget, generation: number): Promise<void> {
    if (generation !== this.generation) return
    const controller = new AbortController()
    this.abort = controller
    this.callbacks.onConnecting?.()

    // Stall watchdog. Armed before the fetch so a connect that hangs forever is also
    // bounded. `stalled` distinguishes a watchdog abort (must reconnect) from an
    // intentional one via stop() (must not).
    let lastActivityAt = Date.now()
    let stalled = false
    let streamError: string | null = null
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivityAt <= this.stallTimeoutMs) return
      stalled = true
      streamError = `No data from remote host for ${Math.round(this.stallTimeoutMs / 1000)}s`
      controller.abort()
    }, this.stallCheckIntervalMs)

    try {
      const response = await this.fetchFn(
        `${target.baseUrl.replace(/\/+$/, '')}/api/remote/events`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${target.token}` },
          signal: controller.signal,
        },
      )
      if (!response.ok || !response.body) {
        throw new Error(`Remote event stream failed with HTTP ${response.status}`)
      }

      this.streaming = true
      this.attempt = 0
      this.callbacks.onConnected?.()

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (generation === this.generation) {
        const { done, value } = await reader.read()
        if (done) break
        // Any bytes count as liveness — including the keepalive comments the frame
        // parser deliberately discards.
        lastActivityAt = Date.now()
        buffer += decoder.decode(value, { stream: true })
        let separator = buffer.indexOf('\n\n')
        while (separator !== -1) {
          const frame = buffer.slice(0, separator)
          buffer = buffer.slice(separator + 2)
          const event = parseSseFrame(frame)
          if (event) this.callbacks.onEvent(event)
          separator = buffer.indexOf('\n\n')
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        streamError = describeError(error)
        this.callbacks.onStreamError?.(streamError, error)
      }
    } finally {
      clearInterval(watchdog)
      if (this.abort === controller) {
        this.abort = null
        this.streaming = false
      }
      // A stalled abort is the watchdog's, not stop()'s, so it must reconnect.
      if (generation === this.generation && (!controller.signal.aborted || stalled)) {
        const delayMs = Math.min(
          this.reconnectBaseDelayMs * (2 ** this.attempt),
          this.reconnectMaxDelayMs,
        )
        this.attempt += 1
        this.callbacks.onDisconnected?.({
          error: streamError,
          attempt: this.attempt,
          delayMs,
          stalled,
        })
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null
          void this.run(target, generation)
        }, delayMs)
      }
    }
  }
}
