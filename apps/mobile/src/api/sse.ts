/**
 * SSE manager for GET /api/remote/events.
 *
 * The stream mechanics — frame parsing, read loop, exponential reconnect backoff,
 * generation guard and stall watchdog — live in @polycode/shared's RemoteEventStream,
 * shared with the desktop controller client. This wrapper adds what is mobile-specific:
 * expo/fetch (React Native's global fetch buffers the whole response; only expo/fetch
 * exposes a streaming body), the AppState foreground/background lifecycle, and the
 * three-state ConnectionState model the UI renders.
 *
 * There is no replay on reconnect, so consumers must refetch state when the stream
 * (re)connects — that's what the onConnect callback is for.
 */
import { fetch as expoFetch } from 'expo/fetch'
import { AppState, type AppStateStatus } from 'react-native'
import { RemoteEventStream, type EventStreamResponse } from '@polycode/shared'
import { type HostConnection } from './client'
import { dispatchEvent } from './events'

type ConnectionState = 'disconnected' | 'connecting' | 'connected'

type StateListener = (state: ConnectionState) => void
type ConnectListener = () => void

class SseManager {
  private host: HostConnection | null = null
  private appStateSub: { remove(): void } | null = null
  private stateListeners = new Set<StateListener>()
  private connectListeners = new Set<ConnectListener>()
  state: ConnectionState = 'disconnected'

  private readonly stream = new RemoteEventStream(
    {
      onEvent: (event) => dispatchEvent(event.channel, event.args),
      onConnecting: () => this.setState('connecting'),
      onConnected: () => {
        this.setState('connected')
        for (const listener of [...this.connectListeners]) listener()
      },
      onDisconnected: (info) => {
        this.setState('disconnected')
        if (info.error) console.warn('[sse] event stream disconnected:', info.error)
      },
    },
    {
      fetchFn: (url, init) => expoFetch(url, init) as unknown as Promise<EventStreamResponse>,
    },
  )

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
    this.stream.stop()
    this.setState('disconnected')
  }

  restart(): void {
    this.stop()
    if (!this.host) return
    this.stream.start({ baseUrl: this.host.baseUrl, token: this.host.token })
  }
}

export const sseManager = new SseManager()
export type { ConnectionState }
