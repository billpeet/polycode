import { create } from 'zustand'
import { Project } from '../types/ipc'

interface ProjectStore {
  projects: Project[]
  archivedProjects: Project[]
  selectedProjectId: string | null
  expandedProjectIds: Set<string>
  loading: boolean
  fetch: () => Promise<void>
  create: (name: string, gitUrl?: string | null) => Promise<Project>
  update: (id: string, name: string, gitUrl?: string | null) => Promise<void>
  remove: (id: string) => Promise<void>
  archive: (id: string) => Promise<void>
  unarchive: (id: string) => Promise<void>
  select: (id: string | null) => void
  expand: (id: string) => void
  toggleExpanded: (id: string) => void
  isExpanded: (id: string) => boolean
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [],
  archivedProjects: [],
  selectedProjectId: null,
  expandedProjectIds: new Set<string>(),
  loading: false,

  fetch: async () => {
    set({ loading: true })
    try {
      const [projects, archivedProjects] = await Promise.all([
        window.api.invoke('projects:list'),
        window.api.invoke('projects:listArchived'),
      ])
      set({ projects, archivedProjects, loading: false })
    } catch (err) {
      console.error('Failed to fetch projects', err)
      set({ loading: false })
    }
  },

  create: async (name, gitUrl) => {
    const project = await window.api.invoke('projects:create', name, gitUrl)
    set((s) => ({ projects: [project, ...s.projects] }))
    return project
  },

  update: async (id, name, gitUrl) => {
    await window.api.invoke('projects:update', id, name, gitUrl)
    set((s) => ({
      projects: s.projects.map((p) => p.id === id ? { ...p, name, git_url: gitUrl ?? null } : p),
      archivedProjects: s.archivedProjects.map((p) => p.id === id ? { ...p, name, git_url: gitUrl ?? null } : p),
    }))
  },

  remove: async (id) => {
    await window.api.invoke('projects:delete', id)
    set((s) => {
      const newExpanded = new Set(s.expandedProjectIds)
      newExpanded.delete(id)
      return {
        projects: s.projects.filter((p) => p.id !== id),
        archivedProjects: s.archivedProjects.filter((p) => p.id !== id),
        selectedProjectId: s.selectedProjectId === id ? null : s.selectedProjectId,
        expandedProjectIds: newExpanded
      }
    })
  },

  archive: async (id) => {
    await window.api.invoke('projects:archive', id)
    set((s) => {
      const project = s.projects.find((p) => p.id === id)
      if (!project) return s
      const now = new Date().toISOString()
      const newExpanded = new Set(s.expandedProjectIds)
      newExpanded.delete(id)
      return {
        projects: s.projects.filter((p) => p.id !== id),
        archivedProjects: [{ ...project, archived_at: now }, ...s.archivedProjects],
        selectedProjectId: s.selectedProjectId === id ? null : s.selectedProjectId,
        expandedProjectIds: newExpanded,
      }
    })
  },

  unarchive: async (id) => {
    await window.api.invoke('projects:unarchive', id)
    set((s) => {
      const project = s.archivedProjects.find((p) => p.id === id)
      if (!project) return s
      return {
        projects: [{ ...project, archived_at: null }, ...s.projects],
        archivedProjects: s.archivedProjects.filter((p) => p.id !== id),
      }
    })
  },

  select: (id) => set({ selectedProjectId: id }),

  expand: (id) => set((s) => {
    const newExpanded = new Set(s.expandedProjectIds)
    newExpanded.add(id)
    return { expandedProjectIds: newExpanded }
  }),

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
