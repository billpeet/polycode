import { create } from 'zustand'
import type { SendOptions, Thread, ThreadStatus } from '@polycode/shared'
import { rpc } from '../api/rpc'
import { requireConnection } from './hosts'

interface ThreadsState {
  threadsByProject: Record<string, Thread[]>
  loading: boolean
  error: string | null

  fetch: (projectId: string) => Promise<void>
  create: (projectId: string, name: string, locationId: string) => Promise<Thread>
  rename: (projectId: string, threadId: string, name: string) => Promise<void>
  archive: (projectId: string, threadId: string) => Promise<void>
  unarchive: (projectId: string, threadId: string) => Promise<void>
  remove: (projectId: string, threadId: string) => Promise<void>
  reset: (threadId: string) => Promise<void>
  listArchived: (projectId: string) => Promise<Thread[]>
  archivedCount: (projectId: string) => Promise<number>
  send: (threadId: string, content: string, options?: SendOptions) => Promise<void>
  stop: (threadId: string) => Promise<void>
  setUnread: (projectId: string, threadId: string, unread: boolean) => Promise<void>
  setPermissionMode: (projectId: string, threadId: string, mode: Thread['permission_mode']) => Promise<void>
  updateProviderAndModel: (projectId: string, threadId: string, provider: string, model: string) => Promise<void>
  updateReasoningLevel: (threadId: string, level: Thread['reasoning_level']) => Promise<void>

  /** Apply a live status/title update coming from the SSE stream. */
  applyStatus: (threadId: string, status: ThreadStatus) => void
  applyTitle: (threadId: string, name: string) => void
  patchThread: (threadId: string, patch: Partial<Thread>) => void
  findThread: (threadId: string) => Thread | undefined
}

function patchInAllProjects(
  threadsByProject: Record<string, Thread[]>,
  threadId: string,
  patch: Partial<Thread>,
): Record<string, Thread[]> {
  let changed = false
  const next: Record<string, Thread[]> = {}
  for (const [projectId, threads] of Object.entries(threadsByProject)) {
    const index = threads.findIndex((t) => t.id === threadId)
    if (index === -1) {
      next[projectId] = threads
      continue
    }
    changed = true
    next[projectId] = threads.map((t) => (t.id === threadId ? { ...t, ...patch } : t))
  }
  return changed ? next : threadsByProject
}

export const useThreadsStore = create<ThreadsState>((set, get) => ({
  threadsByProject: {},
  loading: false,
  error: null,

  fetch: async (projectId) => {
    set({ loading: true, error: null })
    try {
      const threads = await rpc(requireConnection(), 'threads:list', projectId)
      set((s) => ({ threadsByProject: { ...s.threadsByProject, [projectId]: threads }, loading: false }))
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  },

  create: async (projectId, name, locationId) => {
    const thread = await rpc(requireConnection(), 'threads:create', projectId, name, locationId)
    set((s) => ({
      threadsByProject: {
        ...s.threadsByProject,
        [projectId]: [thread, ...(s.threadsByProject[projectId] ?? [])],
      },
    }))
    return thread
  },

  rename: async (projectId, threadId, name) => {
    await rpc(requireConnection(), 'threads:updateName', threadId, name)
    get().patchThread(threadId, { name })
  },

  archive: async (projectId, threadId) => {
    await rpc(requireConnection(), 'threads:archive', threadId)
    set((s) => ({
      threadsByProject: {
        ...s.threadsByProject,
        [projectId]: (s.threadsByProject[projectId] ?? []).filter((t) => t.id !== threadId),
      },
    }))
  },

  unarchive: async (projectId, threadId) => {
    await rpc(requireConnection(), 'threads:unarchive', threadId)
    await get().fetch(projectId)
  },

  remove: async (projectId, threadId) => {
    await rpc(requireConnection(), 'threads:delete', threadId)
    set((s) => ({
      threadsByProject: {
        ...s.threadsByProject,
        [projectId]: (s.threadsByProject[projectId] ?? []).filter((t) => t.id !== threadId),
      },
    }))
  },

  reset: async (threadId) => {
    await rpc(requireConnection(), 'threads:reset', threadId)
  },

  listArchived: async (projectId) => {
    return rpc(requireConnection(), 'threads:listArchived', projectId)
  },

  archivedCount: async (projectId) => {
    return rpc(requireConnection(), 'threads:archivedCount', projectId)
  },

  send: async (threadId, content, options) => {
    await rpc(requireConnection(), 'threads:send', threadId, content, options)
    get().patchThread(threadId, { status: 'running', has_messages: true })
  },

  stop: async (threadId) => {
    await rpc(requireConnection(), 'threads:stop', threadId)
    get().patchThread(threadId, { status: 'stopping' })
  },

  setUnread: async (projectId, threadId, unread) => {
    get().patchThread(threadId, { unread })
    await rpc(requireConnection(), 'threads:setUnread', threadId, unread)
  },

  setPermissionMode: async (projectId, threadId, mode) => {
    get().patchThread(threadId, { permission_mode: mode, yolo_mode: mode === 'yolo' })
    await rpc(requireConnection(), 'threads:setPermissionMode', threadId, mode)
  },

  updateProviderAndModel: async (projectId, threadId, provider, model) => {
    get().patchThread(threadId, { provider, model })
    await rpc(requireConnection(), 'threads:updateProviderAndModel', threadId, provider, model)
  },

  updateReasoningLevel: async (threadId, level) => {
    get().patchThread(threadId, { reasoning_level: level })
    await rpc(requireConnection(), 'threads:updateReasoningLevel', threadId, level)
  },

  applyStatus: (threadId, status) => {
    get().patchThread(threadId, { status })
  },

  applyTitle: (threadId, name) => {
    get().patchThread(threadId, { name })
  },

  patchThread: (threadId, patch) => {
    set((s) => ({ threadsByProject: patchInAllProjects(s.threadsByProject, threadId, patch) }))
  },

  findThread: (threadId) => {
    for (const threads of Object.values(get().threadsByProject)) {
      const found = threads.find((t) => t.id === threadId)
      if (found) return found
    }
    return undefined
  },
}))
