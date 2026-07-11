import { create } from 'zustand'
import type { Project, RepoLocation } from '@polycode/shared'
import { rpc } from '../api/rpc'
import { requireConnection } from './hosts'

interface ProjectsState {
  projects: Project[]
  locationsByProject: Record<string, RepoLocation[]>
  loading: boolean
  error: string | null

  fetch: () => Promise<void>
  fetchLocations: (projectId: string) => Promise<RepoLocation[]>
  clear: () => void
}

export const useProjectsStore = create<ProjectsState>((set) => ({
  projects: [],
  locationsByProject: {},
  loading: false,
  error: null,

  fetch: async () => {
    set({ loading: true, error: null })
    try {
      const projects = await rpc(requireConnection(), 'projects:list')
      set({ projects, loading: false })
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  },

  fetchLocations: async (projectId) => {
    const locations = await rpc(requireConnection(), 'locations:list', projectId)
    set((s) => ({ locationsByProject: { ...s.locationsByProject, [projectId]: locations } }))
    return locations
  },

  clear: () => set({ projects: [], locationsByProject: {}, error: null }),
}))
