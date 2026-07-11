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
  requestIdByThread: Record<string, number>
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

export const useCliHealthStore = create<CliHealthStore>((set, get) => ({
  healthByThread: {},
  requestIdByThread: {},

  check: async (threadId, provider, connectionType, ssh, wsl) => {
    const requestId = (get().requestIdByThread[threadId] ?? 0) + 1
    set((s) => ({
      requestIdByThread: {
        ...s.requestIdByThread,
        [threadId]: requestId,
      },
      healthByThread: {
        ...s.healthByThread,
        [threadId]: {
          status: 'checking',
          result: s.healthByThread[threadId]?.result ?? null,
          error: null,
        },
      },
    }))
    try {
      const result = await window.api.invoke('cli:health', provider, connectionType, ssh, wsl)
      set((s) => {
        if (s.requestIdByThread[threadId] !== requestId) return s
        return {
          healthByThread: {
            ...s.healthByThread,
            [threadId]: {
              status: result.installed ? 'ok' : 'unavailable',
              result,
              error: null,
            },
          },
        }
      })
    } catch (err) {
      set((s) => {
        if (s.requestIdByThread[threadId] !== requestId) return s
        return {
          healthByThread: {
            ...s.healthByThread,
            [threadId]: {
              status: 'error',
              result: s.healthByThread[threadId]?.result ?? null,
              error: String(err),
            },
          },
        }
      })
    }
  },

  clear: (threadId) =>
    set((s) => {
      const next = { ...s.healthByThread }
      const nextRequests = { ...s.requestIdByThread }
      delete next[threadId]
      delete nextRequests[threadId]
      return { healthByThread: next, requestIdByThread: nextRequests }
    }),
}))

export { IDLE as CLI_HEALTH_IDLE }
