import { create } from 'zustand'
import { RepoLocation, SshConfig, WslConfig, ConnectionType } from '../types/ipc'

interface LocationStore {
  byProject: Record<string, RepoLocation[]>
  fetch: (projectId: string) => Promise<void>
  create: (projectId: string, label: string, connectionType: ConnectionType, path: string, ssh?: SshConfig | null, wsl?: WslConfig | null) => Promise<RepoLocation>
  update: (id: string, projectId: string, label: string, connectionType: ConnectionType, path: string, ssh?: SshConfig | null, wsl?: WslConfig | null) => Promise<void>
  remove: (id: string, projectId: string) => Promise<void>
}

export const useLocationStore = create<LocationStore>((set) => ({
  byProject: {},

  fetch: async (projectId) => {
    const locations = await window.api.invoke('locations:list', projectId)
    set((s) => ({
      byProject: { ...s.byProject, [projectId]: locations }
    }))
  },

  create: async (projectId, label, connectionType, path, ssh, wsl) => {
    const location = await window.api.invoke('locations:create', projectId, label, connectionType, path, ssh, wsl)
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: [...(s.byProject[projectId] ?? []), location]
      }
    }))
    return location
  },

  update: async (id, projectId, label, connectionType, path, ssh, wsl) => {
    await window.api.invoke('locations:update', id, label, connectionType, path, ssh, wsl)
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: (s.byProject[projectId] ?? []).map((l) =>
          l.id === id ? { ...l, label, connection_type: connectionType, path, ssh: ssh ?? null, wsl: wsl ?? null } : l
        )
      }
    }))
  },

  remove: async (id, projectId) => {
    await window.api.invoke('locations:delete', id)
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: (s.byProject[projectId] ?? []).filter((l) => l.id !== id)
      }
    }))
  },
}))
