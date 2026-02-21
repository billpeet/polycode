import { create } from 'zustand'
import { GitStatus } from '../types/ipc'

interface GitStore {
  // Keyed by project path
  statusByPath: Record<string, GitStatus | null>
  loadingByPath: Record<string, boolean>

  fetch: (repoPath: string) => Promise<void>
  commit: (repoPath: string, message: string) => Promise<void>
}

export const useGitStore = create<GitStore>((set, get) => ({
  statusByPath: {},
  loadingByPath: {},

  fetch: async (repoPath) => {
    if (get().loadingByPath[repoPath]) return
    set((s) => ({ loadingByPath: { ...s.loadingByPath, [repoPath]: true } }))
    try {
      const status = await window.api.invoke('git:status', repoPath)
      set((s) => ({
        statusByPath: { ...s.statusByPath, [repoPath]: status },
        loadingByPath: { ...s.loadingByPath, [repoPath]: false },
      }))
    } catch {
      set((s) => ({ loadingByPath: { ...s.loadingByPath, [repoPath]: false } }))
    }
  },

  commit: async (repoPath, message) => {
    await window.api.invoke('git:commit', repoPath, message)
    // Refresh status after commit
    await get().fetch(repoPath)
  },
}))
