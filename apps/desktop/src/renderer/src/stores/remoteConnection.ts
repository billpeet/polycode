import { create } from 'zustand'
import type { RemoteConnectionState } from '../types/ipc'

interface RemoteConnectionStore {
  connection: RemoteConnectionState
  /** True while a user-initiated retry is in flight. */
  retrying: boolean
  /**
   * Bumped when the event stream recovers after a gap (reconnecting/unavailable →
   * connected). SSE has no replay, so anything the host emitted during the gap is gone;
   * views that render pushed data re-key their fetch effects on this nonce to catch up.
   * The initial connect after activating a host does NOT bump it — `remote:active-changed`
   * already resets and refetches everything.
   */
  reconnectNonce: number
  /** Number of in-flight IPC calls past the preload's slow threshold. */
  slowCalls: number
  retry: () => Promise<void>
}

const INITIAL: RemoteConnectionState = {
  hostId: null,
  phase: 'local',
  reconnectAttempt: 0,
  error: null,
  latencyMs: null,
  changedAt: new Date(0).toISOString(),
}

/** Whether moving from `previous` to `next` is a stream recovery that may have lost events. */
export function isReconnectRecovery(
  previous: RemoteConnectionState,
  next: RemoteConnectionState,
): boolean {
  return next.phase === 'connected'
    && next.hostId !== null
    && next.hostId === previous.hostId
    && (previous.phase === 'reconnecting' || previous.phase === 'unavailable')
}

export const useRemoteConnectionStore = create<RemoteConnectionStore>((set) => ({
  connection: INITIAL,
  retrying: false,
  reconnectNonce: 0,
  slowCalls: 0,

  retry: async () => {
    set({ retrying: true })
    try {
      const connection = await window.api.invoke('remote:reconnect')
      set({ connection })
    } catch {
      // The reconnect attempt itself reports through remote:connection-changed.
    } finally {
      set({ retrying: false })
    }
  },
}))

let initialized = false

/**
 * Subscribe to live connection transitions and seed the initial snapshot. Idempotent, so
 * every component that renders connection state may call it without coordination.
 */
export function initRemoteConnectionStore(): void {
  if (initialized) return
  initialized = true

  window.api.on('remote:connection-changed', (...args) => {
    const connection = args[0] as RemoteConnectionState | undefined
    if (!connection) return
    useRemoteConnectionStore.setState((s) => ({
      connection,
      reconnectNonce: isReconnectRecovery(s.connection, connection)
        ? s.reconnectNonce + 1
        : s.reconnectNonce,
    }))
  })
  window.api.onSlowInvoke((pendingSlowCalls) => {
    useRemoteConnectionStore.setState({ slowCalls: pendingSlowCalls })
  })
  void window.api.invoke('remote:getConnectionState')
    .then((connection) => useRemoteConnectionStore.setState({ connection }))
    .catch(() => undefined)
}
