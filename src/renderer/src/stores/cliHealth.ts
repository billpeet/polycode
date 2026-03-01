import { create } from 'zustand'
import { CliHealthResult, Provider, ConnectionType, SshConfig, WslConfig } from '../types/ipc'

export type CliHealthStatus = 'idle' | 'checking' | 'ok' | 'unavailable' | 'error'

export interface ThreadCliHealth {
  status: CliHealthStatus
  result: CliHealthResult | null
  error: string | null
}

interface CliHealthStore {
  healthByThread: Record<string, ThreadCliHealth>
  check: (
    threadId: string,
    provider: Provider,
    connectionType: ConnectionType,
    ssh: SshConfig | null,
    wsl: WslConfig | null,
  ) => Promise<void>
  clear: (threadId: string) => void
}

const IDLE: ThreadCliHealth = { status: 'idle', result: null, error: null }

export const useCliHealthStore = create<CliHealthStore>((set) => ({
  healthByThread: {},

  check: async (threadId, provider, connectionType, ssh, wsl) => {
    set((s) => ({
      healthByThread: {
        ...s.healthByThread,
        [threadId]: { status: 'checking', result: null, error: null },
      },
    }))
    try {
      const result = await window.api.invoke('cli:health', provider, connectionType, ssh, wsl)
      set((s) => ({
        healthByThread: {
          ...s.healthByThread,
          [threadId]: {
            status: result.installed ? 'ok' : 'unavailable',
            result,
            error: null,
          },
        },
      }))
    } catch (err) {
      set((s) => ({
        healthByThread: {
          ...s.healthByThread,
          [threadId]: { status: 'error', result: null, error: String(err) },
        },
      }))
    }
  },

  clear: (threadId) =>
    set((s) => {
      const next = { ...s.healthByThread }
      delete next[threadId]
      return { healthByThread: next }
    }),
}))

export { IDLE as CLI_HEALTH_IDLE }
