import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { RemoteConnectionStatus } from '@polycode/shared'
import { normalizeBaseUrl, testConnection, type HostConnection } from '../api/client'
import { sseManager } from '../api/sse'

/** Host metadata persisted to AsyncStorage. The bearer token lives in SecureStore. */
export interface HostMeta {
  id: string
  label: string
  baseUrl: string
  createdAt: string
  updatedAt: string
}

export interface HostInput {
  label: string
  baseUrl: string
  token: string
}

function tokenKey(hostId: string): string {
  return `polycode.host-token.${hostId}`
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function normalizeInput(input: HostInput): HostInput {
  const label = input.label.trim()
  if (!label) throw new Error('Host label is required')
  const token = input.token.trim()
  if (!token) throw new Error('Host token is required')
  return { label, baseUrl: normalizeBaseUrl(input.baseUrl), token }
}

interface HostsState {
  hosts: HostMeta[]
  activeHostId: string | null
  /** In-memory token cache loaded from SecureStore; never persisted to AsyncStorage. */
  tokens: Record<string, string>
  /** True once persisted metadata and tokens have been loaded. */
  hydrated: boolean
  health: Record<string, RemoteConnectionStatus | undefined>

  addHost: (input: HostInput) => Promise<HostMeta>
  updateHost: (id: string, input: HostInput) => Promise<void>
  removeHost: (id: string) => Promise<void>
  setActiveHost: (id: string | null) => void
  checkHealth: (id: string) => Promise<RemoteConnectionStatus>
  connectionFor: (id: string) => HostConnection | null
  activeConnection: () => HostConnection | null
}

export const useHostsStore = create<HostsState>()(
  persist(
    (set, get) => ({
      hosts: [],
      activeHostId: null,
      tokens: {},
      hydrated: false,
      health: {},

      addHost: async (input) => {
        const normalized = normalizeInput(input)
        const now = new Date().toISOString()
        const host: HostMeta = {
          id: newId(),
          label: normalized.label,
          baseUrl: normalized.baseUrl,
          createdAt: now,
          updatedAt: now,
        }
        await SecureStore.setItemAsync(tokenKey(host.id), normalized.token)
        set((s) => ({
          hosts: [...s.hosts, host],
          tokens: { ...s.tokens, [host.id]: normalized.token },
        }))
        // First host becomes active automatically.
        if (!get().activeHostId) get().setActiveHost(host.id)
        return host
      },

      updateHost: async (id, input) => {
        const normalized = normalizeInput(input)
        await SecureStore.setItemAsync(tokenKey(id), normalized.token)
        set((s) => ({
          hosts: s.hosts.map((h) =>
            h.id === id
              ? { ...h, label: normalized.label, baseUrl: normalized.baseUrl, updatedAt: new Date().toISOString() }
              : h,
          ),
          tokens: { ...s.tokens, [id]: normalized.token },
        }))
        if (get().activeHostId === id) syncSse()
      },

      removeHost: async (id) => {
        await SecureStore.deleteItemAsync(tokenKey(id))
        set((s) => {
          const tokens = { ...s.tokens }
          delete tokens[id]
          const health = { ...s.health }
          delete health[id]
          return { hosts: s.hosts.filter((h) => h.id !== id), tokens, health }
        })
        if (get().activeHostId === id) get().setActiveHost(null)
      },

      setActiveHost: (id) => {
        set({ activeHostId: id })
        syncSse()
      },

      checkHealth: async (id) => {
        const connection = get().connectionFor(id)
        const status: RemoteConnectionStatus = connection
          ? await testConnection(connection)
          : { ok: false, error: 'Missing token' }
        set((s) => ({ health: { ...s.health, [id]: status } }))
        return status
      },

      connectionFor: (id) => {
        const host = get().hosts.find((h) => h.id === id)
        const token = get().tokens[id]
        if (!host || !token) return null
        return { baseUrl: host.baseUrl, token }
      },

      activeConnection: () => {
        const { activeHostId } = get()
        if (!activeHostId) return null
        return get().connectionFor(activeHostId)
      },
    }),
    {
      name: 'polycode.hosts',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ hosts: s.hosts, activeHostId: s.activeHostId }),
      onRehydrateStorage: () => (state) => {
        void loadTokens(state?.hosts ?? [])
      },
    },
  ),
)

/** Load all host tokens from SecureStore into the in-memory cache, then connect SSE. */
async function loadTokens(hosts: HostMeta[]): Promise<void> {
  const tokens: Record<string, string> = {}
  await Promise.all(
    hosts.map(async (host) => {
      try {
        const token = await SecureStore.getItemAsync(tokenKey(host.id))
        if (token) tokens[host.id] = token
      } catch {
        // Missing/corrupt entry: host will show as unhealthy until re-paired.
      }
    }),
  )
  useHostsStore.setState({ tokens, hydrated: true })
  syncSse()
}

/** Point the SSE manager at the active host's connection (or disconnect). */
function syncSse(): void {
  sseManager.setHost(useHostsStore.getState().activeConnection())
}

/** Convenience for stores/screens: the active connection or a thrown error. */
export function requireConnection(): HostConnection {
  const connection = useHostsStore.getState().activeConnection()
  if (!connection) throw new Error('No active host connection')
  return connection
}
