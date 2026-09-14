import { create } from 'zustand'
import { YouTrackServer } from '../types/ipc'
import { client } from '../lib/client'
import { isRemoteTransportError } from '../lib/remoteErrors'

interface YouTrackStore {
  servers: YouTrackServer[]
  loading: boolean
  unavailable: boolean
  error: string | null
  fetch: () => Promise<void>
  create: (name: string, url: string, token: string) => Promise<YouTrackServer>
  update: (id: string, name: string, url: string, token: string) => Promise<void>
  remove: (id: string) => Promise<void>
}

export const useYouTrackStore = create<YouTrackStore>((set) => ({
  servers: [],
  loading: false,
  unavailable: false,
  error: null,

  fetch: async () => {
    set({ loading: true, unavailable: false, error: null })
    try {
      const servers = await client.invoke('youtrack:servers:list')
      set({ servers, loading: false, unavailable: false, error: null })
    } catch (error) {
      // Optional background reads settle here for both App and Sidebar callers.
      // Keep the last-good list, but expose unexpected failures in settings.
      const unavailable = isRemoteTransportError(error)
      set({
        loading: false,
        unavailable,
        error: unavailable ? null : String(error),
      })
    }
  },

  create: async (name, url, token) => {
    const server = await client.invoke('youtrack:servers:create', name, url, token)
    set((s) => ({ servers: [...s.servers, server] }))
    return server
  },

  update: async (id, name, url, token) => {
    await client.invoke('youtrack:servers:update', id, name, url, token)
    set((s) => ({
      servers: s.servers.map((srv) =>
        srv.id === id ? { ...srv, name, url, token, updated_at: new Date().toISOString() } : srv
      ),
    }))
  },

  remove: async (id) => {
    await client.invoke('youtrack:servers:delete', id)
    set((s) => ({ servers: s.servers.filter((srv) => srv.id !== id) }))
  },
}))
