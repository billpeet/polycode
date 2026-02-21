import { create } from 'zustand'
import { Thread, ThreadStatus } from '../types/ipc'

interface ThreadStore {
  /** threads keyed by project ID */
  byProject: Record<string, Thread[]>
  selectedThreadId: string | null
  statusMap: Record<string, ThreadStatus>
  fetch: (projectId: string) => Promise<void>
  create: (projectId: string, name: string) => Promise<void>
  remove: (id: string, projectId: string) => Promise<void>
  select: (id: string | null) => void
  setStatus: (threadId: string, status: ThreadStatus) => void
  rename: (threadId: string, name: string) => void
  start: (threadId: string, workingDir: string) => Promise<void>
  stop: (threadId: string) => Promise<void>
  send: (threadId: string, content: string) => Promise<void>
}

export const useThreadStore = create<ThreadStore>((set) => ({
  byProject: {},
  selectedThreadId: null,
  statusMap: {},

  fetch: async (projectId) => {
    const threads = await window.api.invoke('threads:list', projectId)
    set((s) => ({
      byProject: { ...s.byProject, [projectId]: threads },
      statusMap: {
        ...s.statusMap,
        ...Object.fromEntries(threads.map((t: Thread) => [t.id, t.status]))
      }
    }))
  },

  create: async (projectId, name) => {
    const thread = await window.api.invoke('threads:create', projectId, name)
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: [thread, ...(s.byProject[projectId] ?? [])]
      },
      statusMap: { ...s.statusMap, [thread.id]: 'idle' }
    }))
  },

  remove: async (id, projectId) => {
    await window.api.invoke('threads:delete', id)
    set((s) => {
      const updated = { ...s.statusMap }
      delete updated[id]
      return {
        byProject: {
          ...s.byProject,
          [projectId]: (s.byProject[projectId] ?? []).filter((t) => t.id !== id)
        },
        selectedThreadId: s.selectedThreadId === id ? null : s.selectedThreadId,
        statusMap: updated
      }
    })
  },

  select: (id) => set({ selectedThreadId: id }),

  setStatus: (threadId, status) =>
    set((s) => ({ statusMap: { ...s.statusMap, [threadId]: status } })),

  rename: (threadId, name) =>
    set((s) => {
      const updated = { ...s.byProject }
      for (const pid of Object.keys(updated)) {
        updated[pid] = updated[pid].map((t) => (t.id === threadId ? { ...t, name } : t))
      }
      return { byProject: updated }
    }),

  start: async (threadId, workingDir) => {
    await window.api.invoke('threads:start', threadId, workingDir)
  },

  stop: async (threadId) => {
    await window.api.invoke('threads:stop', threadId)
  },

  send: async (threadId, content) => {
    await window.api.invoke('threads:send', threadId, content)
  }
}))
