import { create } from 'zustand'
import { Project, NewProjectSpec, ProjectSortMode } from '../types/ipc'

const SORT_MODE_SETTING_KEY = 'projects:sortMode'

function safeTime(iso: string | undefined): number {
  if (!iso) return 0
  const time = new Date(iso).getTime()
  return Number.isNaN(time) ? 0 : time
}

function projectActivityTime(project: Project, activityByProject?: Record<string, number>): number {
  // Use whichever is most recent: the DB-computed value or renderer-side thread activity.
  return Math.max(
    safeTime(project.last_activity_at ?? project.updated_at),
    activityByProject?.[project.id] ?? 0
  )
}

/**
 * Returns a new array sorted per the given mode (does not mutate the input).
 * `activityByProject` optionally supplies renderer-known activity timestamps (ms) per project id.
 */
export function sortProjects(
  projects: Project[],
  mode: ProjectSortMode,
  activityByProject?: Record<string, number>
): Project[] {
  const sorted = projects.slice()
  if (mode === 'alphabetical') {
    sorted.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  } else {
    // Descending: most recently active project at the top; stable tie-break on name
    sorted.sort((a, b) =>
      projectActivityTime(b, activityByProject) - projectActivityTime(a, activityByProject) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    )
  }
  return sorted
}

interface ProjectStore {
  projects: Project[]
  archivedProjects: Project[]
  selectedProjectId: string | null
  expandedProjectIds: Set<string>
  loading: boolean
  sortMode: ProjectSortMode
  fetch: () => Promise<void>
  loadSortMode: () => Promise<void>
  setSortMode: (mode: ProjectSortMode) => void
  /** Mark a project as just-active so it bubbles to the top in "last message" sort. */
  touch: (projectId: string) => void
  create: (name: string, gitUrl?: string | null, allowMainBranchCommits?: boolean) => Promise<Project>
  createFull: (spec: NewProjectSpec) => Promise<Project>
  update: (id: string, name: string, gitUrl?: string | null, allowMainBranchCommits?: boolean, faviconPath?: string | null) => Promise<void>
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
  sortMode: 'lastMessage',

  loadSortMode: async () => {
    try {
      const raw = await window.api.invoke('settings:get', SORT_MODE_SETTING_KEY)
      if (raw === 'alphabetical' || raw === 'lastMessage') {
        set({ sortMode: raw })
      }
    } catch (err) {
      console.error('Failed to load project sort mode', err)
    }
  },

  setSortMode: (mode) => {
    set({ sortMode: mode })
    void window.api.invoke('settings:set', SORT_MODE_SETTING_KEY, mode)
  },

  touch: (projectId) => set((s) => {
    if (!s.projects.some((p) => p.id === projectId)) return s
    const now = new Date().toISOString()
    return {
      projects: s.projects.map((p) => p.id === projectId ? { ...p, last_activity_at: now } : p),
    }
  }),

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

  create: async (name, gitUrl, allowMainBranchCommits = true) => {
    const project = await window.api.invoke('projects:create', name, gitUrl, allowMainBranchCommits)
    set((s) => ({ projects: [project, ...s.projects] }))
    return project
  },

  createFull: async (spec) => {
    const { project } = await window.api.invoke('projects:createFull', spec)
    set((s) => ({ projects: [project, ...s.projects] }))
    return project
  },

  update: async (id, name, gitUrl, allowMainBranchCommits = true, faviconPath) => {
    await window.api.invoke('projects:update', id, name, gitUrl, allowMainBranchCommits, faviconPath)
    set((s) => ({
      projects: s.projects.map((p) => p.id === id ? { ...p, name, git_url: gitUrl ?? null, favicon_path: faviconPath ?? null, allow_main_branch_commits: allowMainBranchCommits } : p),
      archivedProjects: s.archivedProjects.map((p) => p.id === id ? { ...p, name, git_url: gitUrl ?? null, favicon_path: faviconPath ?? null, allow_main_branch_commits: allowMainBranchCommits } : p),
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
