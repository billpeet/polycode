import { create } from 'zustand'
import type { RemoteConnectionState } from '../types/ipc'

interface RemoteConnectionStore {
  connection: RemoteConnectionState
  /** True while a user-initiated retry is in flight. */
  retrying: boolean
  retry: () => Promise<void>
}

const INITIAL: RemoteConnectionState = {
  hostId: null,
  phase: 'local',
  reconnectAttempt: 0,
  error: null,
  changedAt: new Date(0).toISOString(),
}

export const useRemoteConnectionStore = create<RemoteConnectionStore>((set) => ({
  connection: INITIAL,
  retrying: false,

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
    if (connection) useRemoteConnectionStore.setState({ connection })
  })
  void window.api.invoke('remote:getConnectionState')
    .then((connection) => useRemoteConnectionStore.setState({ connection }))
    .catch(() => undefined)
}
