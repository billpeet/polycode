import { create } from 'zustand'
import { Project } from '../types/ipc'

interface ProjectStore {
  projects: Project[]
  selectedProjectId: string | null
  expandedProjectIds: Set<string>
  loading: boolean
  fetch: () => Promise<void>
  create: (name: string, path: string) => Promise<void>
  update: (id: string, name: string, path: string) => Promise<void>
  remove: (id: string) => Promise<void>
  select: (id: string | null) => void
  toggleExpanded: (id: string) => void
  isExpanded: (id: string) => boolean
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [],
  selectedProjectId: null,
  expandedProjectIds: new Set<string>(),
  loading: false,

  fetch: async () => {
    set({ loading: true })
    try {
      const projects = await window.api.invoke('projects:list')
      set({ projects, loading: false })
    } catch (err) {
      console.error('Failed to fetch projects', err)
      set({ loading: false })
    }
  },

  create: async (name, path) => {
    const project = await window.api.invoke('projects:create', name, path)
    set((s) => ({ projects: [project, ...s.projects] }))
  },

  update: async (id, name, path) => {
    await window.api.invoke('projects:update', id, name, path)
    set((s) => ({
      projects: s.projects.map((p) => p.id === id ? { ...p, name, path } : p)
    }))
  },

  remove: async (id) => {
    await window.api.invoke('projects:delete', id)
    set((s) => {
      const newExpanded = new Set(s.expandedProjectIds)
      newExpanded.delete(id)
      return {
        projects: s.projects.filter((p) => p.id !== id),
        selectedProjectId: s.selectedProjectId === id ? null : s.selectedProjectId,
        expandedProjectIds: newExpanded
      }
    })
  },

  select: (id) => set({ selectedProjectId: id }),

  toggleExpanded: (id) => set((s) => {
    const newExpanded = new Set(s.expandedProjectIds)
    if (newExpanded.has(id)) {
      newExpanded.delete(id)
    } else {
      newExpanded.add(id)
    }
    return { expandedProjectIds: newExpanded }
  }),

  isExpanded: (id) => get().expandedProjectIds.has(id)
}))
