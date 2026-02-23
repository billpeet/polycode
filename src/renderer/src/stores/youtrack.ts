import { create } from 'zustand'
import { YouTrackServer } from '../types/ipc'

interface YouTrackStore {
  servers: YouTrackServer[]
  fetch: () => Promise<void>
  create: (name: string, url: string, token: string) => Promise<YouTrackServer>
  update: (id: string, name: string, url: string, token: string) => Promise<void>
  remove: (id: string) => Promise<void>
}

export const useYouTrackStore = create<YouTrackStore>((set) => ({
  servers: [],

  fetch: async () => {
    const servers = await window.api.invoke('youtrack:servers:list')
    set({ servers })
  },

  create: async (name, url, token) => {
    const server = await window.api.invoke('youtrack:servers:create', name, url, token)
    set((s) => ({ servers: [...s.servers, server] }))
    return server
  },

  update: async (id, name, url, token) => {
    await window.api.invoke('youtrack:servers:update', id, name, url, token)
    set((s) => ({
      servers: s.servers.map((srv) =>
        srv.id === id ? { ...srv, name, url, token, updated_at: new Date().toISOString() } : srv
      ),
    }))
  },

  remove: async (id) => {
    await window.api.invoke('youtrack:servers:delete', id)
    set((s) => ({ servers: s.servers.filter((srv) => srv.id !== id) }))
  },
}))
