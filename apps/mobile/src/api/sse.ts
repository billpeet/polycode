/**
 * SSE manager for GET /api/remote/events.
 *
 * Uses expo/fetch because React Native's global fetch buffers the whole
 * response — only expo/fetch exposes a streaming ReadableStream body.
 *
 * Frame parsing, the reconnect backoff, and the generation guard are ported
 * from the desktop reference client (apps/desktop/src/main/remote/client.ts).
 * The server keeps the stream alive with comment frames every 25s; there is
 * no replay on reconnect, so consumers must refetch state when the stream
 * (re)connects — that's what the onConnect callback is for.
 */
import { fetch as expoFetch } from 'expo/fetch'
import { AppState, type AppStateStatus } from 'react-native'
import { endpoint, errorMessage, type HostConnection } from './client'
import { dispatchEvent } from './events'

const RECONNECT_DELAY_MS = 2000

type ConnectionState = 'disconnected' | 'connecting' | 'connected'

type StateListener = (state: ConnectionState) => void
type ConnectListener = () => void

class SseManager {
  private host: HostConnection | null = null
  private abort: AbortController | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private generation = 0
  private appStateSub: { remove(): void } | null = null
  private stateListeners = new Set<StateListener>()
  private connectListeners = new Set<ConnectListener>()
  state: ConnectionState = 'disconnected'

  /** Point the manager at a host (or null to disconnect). Restarts the stream. */
  setHost(host: HostConnection | null): void {
    this.host = host
    this.restart()
    if (host && !this.appStateSub) {
      this.appStateSub = AppState.addEventListener('change', this.handleAppState)
    }
    if (!host && this.appStateSub) {
      this.appStateSub.remove()
      this.appStateSub = null
    }
  }

  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  /** Fired on every successful (re)connect — refetch missed state here. */
  onConnect(listener: ConnectListener): () => void {
    this.connectListeners.add(listener)
    return () => this.connectListeners.delete(listener)
  }

  private handleAppState = (status: AppStateStatus): void => {
    // Streams silently die when the app backgrounds or the phone locks;
    // force a fresh connection whenever we come back to the foreground.
    if (status === 'active' && this.host) this.restart()
    if (status !== 'active') this.stop()
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return
    this.state = state
    for (const listener of [...this.stateListeners]) listener(state)
  }

  private stop(): void {
    this.generation += 1
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.abort?.abort()
    this.abort = null
    this.setState('disconnected')
  }

  restart(): void {
    this.stop()
    if (!this.host) return
    const generation = this.generation
    void this.run(this.host, generation)
  }

  private scheduleReconnect(host: HostConnection, generation: number): void {
    if (generation !== this.generation) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.run(host, generation)
    }, RECONNECT_DELAY_MS)
  }

  private async run(host: HostConnection, generation: number): Promise<void> {
    if (generation !== this.generation) return
    const controller = new AbortController()
    this.abort = controller
    this.setState('connecting')

    try {
      const response = await expoFetch(endpoint(host.baseUrl, '/api/remote/events'), {
        method: 'GET',
        headers: { Authorization: `Bearer ${host.token}` },
        signal: controller.signal,
      })
      if (!response.ok || !response.body) {
        throw new Error(`Event stream failed with HTTP ${response.status}`)
      }

      this.setState('connected')
      for (const listener of [...this.connectListeners]) listener()

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (generation === this.generation) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let separator = buffer.indexOf('\n\n')
        while (separator !== -1) {
          const frame = buffer.slice(0, separator)
          buffer = buffer.slice(separator + 2)
          handleSseFrame(frame)
          separator = buffer.indexOf('\n\n')
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.warn('[sse] event stream disconnected:', errorMessage(error))
      }
    } finally {
      if (this.abort === controller) this.abort = null
      if (generation === this.generation && !controller.signal.aborted) {
        this.setState('disconnected')
        this.scheduleReconnect(host, generation)
      }
    }
  }
}

function handleSseFrame(frame: string): void {
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
    dispatchEvent(event.channel, event.args)
  } catch {
    // Ignore malformed frames from a stale or incompatible host.
  }
}

export const sseManager = new SseManager()
export type { ConnectionState }
