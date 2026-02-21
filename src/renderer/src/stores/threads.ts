import { create } from 'zustand'
import { Thread, ThreadStatus, SendOptions, Question } from '../types/ipc'

interface ThreadStore {
  /** active (non-archived) threads keyed by project ID */
  byProject: Record<string, Thread[]>
  /** archived threads keyed by project ID */
  archivedByProject: Record<string, Thread[]>
  /** count of archived threads keyed by project ID — populated on fetch, no full data load required */
  archivedCountByProject: Record<string, number>
  selectedThreadId: string | null
  statusMap: Record<string, ThreadStatus>
  showArchived: boolean
  /** draft input text keyed by thread ID */
  draftByThread: Record<string, string>
  fetch: (projectId: string) => Promise<void>
  fetchArchived: (projectId: string) => Promise<void>
  create: (projectId: string, name: string) => Promise<void>
  remove: (id: string, projectId: string) => Promise<void>
  archive: (id: string, projectId: string) => Promise<void>
  unarchive: (id: string, projectId: string) => Promise<void>
  toggleShowArchived: (projectId: string) => void
  select: (id: string | null) => void
  setStatus: (threadId: string, status: ThreadStatus) => void
  /** Update local name state only (used by IPC title push events where DB is already updated) */
  setName: (threadId: string, name: string) => void
  /** Rename thread (persists to DB and updates local state) */
  rename: (threadId: string, name: string) => Promise<void>
  setModel: (threadId: string, model: string) => Promise<void>
  start: (threadId: string, workingDir: string) => Promise<void>
  stop: (threadId: string) => Promise<void>
  send: (threadId: string, content: string, workingDir: string, options?: SendOptions) => Promise<void>
  approvePlan: (threadId: string) => Promise<void>
  rejectPlan: (threadId: string) => Promise<void>
  getQuestions: (threadId: string) => Promise<Question[]>
  answerQuestion: (threadId: string, answers: Record<string, string>) => Promise<void>
  setDraft: (threadId: string, draft: string) => void
}

export const useThreadStore = create<ThreadStore>((set, get) => ({
  byProject: {},
  archivedByProject: {},
  archivedCountByProject: {},
  selectedThreadId: null,
  statusMap: {},
  showArchived: false,
  draftByThread: {},

  fetch: async (projectId) => {
    const [threads, count] = await Promise.all([
      window.api.invoke('threads:list', projectId),
      window.api.invoke('threads:archivedCount', projectId),
    ])
    set((s) => ({
      byProject: { ...s.byProject, [projectId]: threads },
      archivedCountByProject: { ...s.archivedCountByProject, [projectId]: count },
      statusMap: {
        ...s.statusMap,
        ...Object.fromEntries(threads.map((t: Thread) => [t.id, t.status]))
      }
    }))
  },

  fetchArchived: async (projectId) => {
    const threads = await window.api.invoke('threads:listArchived', projectId)
    set((s) => ({
      archivedByProject: { ...s.archivedByProject, [projectId]: threads },
      archivedCountByProject: { ...s.archivedCountByProject, [projectId]: threads.length },
    }))
  },

  create: async (projectId, name) => {
    const thread = await window.api.invoke('threads:create', projectId, name)
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: [thread, ...(s.byProject[projectId] ?? [])]
      },
      statusMap: { ...s.statusMap, [thread.id]: 'idle' },
      selectedThreadId: thread.id
    }))
  },

  remove: async (id, projectId) => {
    await window.api.invoke('threads:delete', id)
    set((s) => {
      const updatedStatus = { ...s.statusMap }
      delete updatedStatus[id]
      return {
        byProject: {
          ...s.byProject,
          [projectId]: (s.byProject[projectId] ?? []).filter((t) => t.id !== id)
        },
        archivedByProject: {
          ...s.archivedByProject,
          [projectId]: (s.archivedByProject[projectId] ?? []).filter((t) => t.id !== id)
        },
        selectedThreadId: s.selectedThreadId === id ? null : s.selectedThreadId,
        statusMap: updatedStatus
      }
    })
  },

  archive: async (id, projectId) => {
    const result = await window.api.invoke('threads:archive', id)
    set((s) => {
      const thread = (s.byProject[projectId] ?? []).find((t) => t.id === id)
      const updatedStatus = { ...s.statusMap }
      delete updatedStatus[id]
      const withoutThread = (s.byProject[projectId] ?? []).filter((t) => t.id !== id)
      if (result === 'deleted') {
        return {
          byProject: { ...s.byProject, [projectId]: withoutThread },
          selectedThreadId: s.selectedThreadId === id ? null : s.selectedThreadId,
          statusMap: updatedStatus
        }
      }
      const prevCount = s.archivedCountByProject[projectId] ?? 0
      return {
        byProject: { ...s.byProject, [projectId]: withoutThread },
        archivedByProject: {
          ...s.archivedByProject,
          [projectId]: thread
            ? [{ ...thread, archived: true }, ...(s.archivedByProject[projectId] ?? [])]
            : (s.archivedByProject[projectId] ?? [])
        },
        archivedCountByProject: { ...s.archivedCountByProject, [projectId]: prevCount + 1 },
        selectedThreadId: s.selectedThreadId === id ? null : s.selectedThreadId,
        statusMap: updatedStatus
      }
    })
  },

  unarchive: async (id, projectId) => {
    await window.api.invoke('threads:unarchive', id)
    set((s) => {
      const thread = (s.archivedByProject[projectId] ?? []).find((t) => t.id === id)
      const prevCount = s.archivedCountByProject[projectId] ?? 0
      return {
        archivedByProject: {
          ...s.archivedByProject,
          [projectId]: (s.archivedByProject[projectId] ?? []).filter((t) => t.id !== id)
        },
        archivedCountByProject: {
          ...s.archivedCountByProject,
          [projectId]: Math.max(0, prevCount - 1)
        },
        byProject: {
          ...s.byProject,
          [projectId]: thread
            ? [{ ...thread, archived: false }, ...(s.byProject[projectId] ?? [])]
            : (s.byProject[projectId] ?? [])
        },
        statusMap: thread ? { ...s.statusMap, [id]: thread.status } : s.statusMap
      }
    })
  },

  toggleShowArchived: (projectId) => {
    const next = !get().showArchived
    set({ showArchived: next })
    if (next) {
      get().fetchArchived(projectId)
    }
  },

  select: (id) => set({ selectedThreadId: id }),

  setStatus: (threadId, status) =>
    set((s) => ({ statusMap: { ...s.statusMap, [threadId]: status } })),

  setName: (threadId, name) =>
    set((s) => {
      const updated = { ...s.byProject }
      for (const pid of Object.keys(updated)) {
        updated[pid] = updated[pid].map((t) => (t.id === threadId ? { ...t, name } : t))
      }
      return { byProject: updated }
    }),

  rename: async (threadId, name) => {
    await window.api.invoke('threads:updateName', threadId, name)
    set((s) => {
      const updated = { ...s.byProject }
      for (const pid of Object.keys(updated)) {
        updated[pid] = updated[pid].map((t) => (t.id === threadId ? { ...t, name } : t))
      }
      return { byProject: updated }
    })
  },

  setModel: async (threadId, model) => {
    await window.api.invoke('threads:updateModel', threadId, model)
    set((s) => {
      const updated = { ...s.byProject }
      for (const pid of Object.keys(updated)) {
        updated[pid] = updated[pid].map((t) => (t.id === threadId ? { ...t, model } : t))
      }
      return { byProject: updated }
    })
  },

  start: async (threadId, workingDir) => {
    await window.api.invoke('threads:start', threadId, workingDir)
  },

  stop: async (threadId) => {
    await window.api.invoke('threads:stop', threadId)
  },

  send: async (threadId, content, workingDir, options) => {
    // Optimistically set status to running immediately for responsive UI
    set((s) => ({ statusMap: { ...s.statusMap, [threadId]: 'running' } }))
    await window.api.invoke('threads:send', threadId, content, workingDir, options)
  },

  approvePlan: async (threadId) => {
    set((s) => ({ statusMap: { ...s.statusMap, [threadId]: 'running' } }))
    await window.api.invoke('threads:approvePlan', threadId)
  },

  rejectPlan: async (threadId) => {
    set((s) => ({ statusMap: { ...s.statusMap, [threadId]: 'idle' } }))
    await window.api.invoke('threads:rejectPlan', threadId)
  },

  getQuestions: async (threadId) => {
    return await window.api.invoke('threads:getQuestions', threadId)
  },

  answerQuestion: async (threadId, answers) => {
    set((s) => ({ statusMap: { ...s.statusMap, [threadId]: 'running' } }))
    await window.api.invoke('threads:answerQuestion', threadId, answers)
  },

  setDraft: (threadId, draft) =>
    set((s) => ({ draftByThread: { ...s.draftByThread, [threadId]: draft } })),
}))
