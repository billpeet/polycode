import { create } from 'zustand'
import type { QueueThread, SendOptions, Thread, ThreadStatus } from '@polycode/shared'
import { rpc } from '../api/rpc'
import { requireConnection } from './hosts'

/** Page size for the Queue's collapsed Snoozed/Archived sections. */
export const QUEUE_PAGE_SIZE = 30

interface ThreadsState {
  threadsByProject: Record<string, Thread[]>
  /**
   * The Queue: the cross-project attention list (see `threads:listQueue`).
   * Ordering is not stored here — `bucketQueueThreads` derives it at render
   * time so desktop and mobile cannot drift.
   */
  queueThreads: QueueThread[]
  queueLoading: boolean
  loading: boolean
  error: string | null

  fetch: (projectId: string) => Promise<void>
  fetchQueue: () => Promise<void>
  /** Server-side search over the collapsed Queue sections. */
  listQueueSnoozed: (search: string | null, offset?: number) => Promise<QueueThread[]>
  listQueueArchived: (search: string | null, offset?: number) => Promise<QueueThread[]>
  create: (projectId: string, name: string, locationId: string) => Promise<Thread>
  rename: (projectId: string, threadId: string, name: string) => Promise<void>
  archive: (projectId: string, threadId: string) => Promise<void>
  unarchive: (projectId: string, threadId: string) => Promise<void>
  remove: (projectId: string, threadId: string) => Promise<void>
  reset: (threadId: string) => Promise<void>
  listArchived: (projectId: string) => Promise<Thread[]>
  archivedCount: (projectId: string) => Promise<number>
  /**
   * Snooze/wake. Mobile shares `threads:list` with the desktop, so snoozed
   * threads drop out of its lists too — hence the Snoozed section, without
   * which they would simply vanish with no way to find them.
   */
  snooze: (projectId: string, threadId: string, untilIso: string) => Promise<void>
  wake: (projectId: string, threadId: string) => Promise<void>
  listSnoozed: (projectId: string) => Promise<Thread[]>
  snoozedCount: (projectId: string) => Promise<number>
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

/**
 * Applies a patch to a thread wherever it appears in the Queue.
 *
 * The Queue is a parallel list to `threadsByProject` — the same thread can sit
 * in both — so a live status or title update has to reach both or a Queue row
 * will keep rendering a stale status for as long as the Queue stays open.
 */
function patchInQueue(queue: QueueThread[], threadId: string, patch: Partial<Thread>): QueueThread[] {
  // Returning the same array when nothing matched keeps the store's identity
  // check intact, so an unrelated thread's event does not re-render the Queue.
  if (!queue.some((t) => t.id === threadId)) return queue
  return queue.map((t) => (t.id === threadId ? { ...t, ...patch } : t))
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
  queueThreads: [],
  queueLoading: false,
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

  /**
   * Refetches the Queue. Deliberately does not clear `queueThreads` first: this
   * runs on every status event and on resume, and blanking the list mid-read
   * would make the Queue flicker on a phone that is polling in the background.
   */
  fetchQueue: async () => {
    set({ queueLoading: true })
    try {
      const threads = await rpc(requireConnection(), 'threads:listQueue')
      set({ queueThreads: threads, queueLoading: false })
    } catch (error) {
      set({ queueLoading: false, error: error instanceof Error ? error.message : String(error) })
    }
  },

  listQueueSnoozed: async (search, offset = 0) => {
    return rpc(requireConnection(), 'threads:listQueueSnoozed', search, QUEUE_PAGE_SIZE, offset)
  },

  listQueueArchived: async (search, offset = 0) => {
    return rpc(requireConnection(), 'threads:listQueueArchived', search, QUEUE_PAGE_SIZE, offset)
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
      queueThreads: s.queueThreads.filter((t) => t.id !== threadId),
    }))
  },

  unarchive: async (projectId, threadId) => {
    await rpc(requireConnection(), 'threads:unarchive', threadId)
    await Promise.all([get().fetch(projectId), get().fetchQueue()])
  },

  remove: async (projectId, threadId) => {
    await rpc(requireConnection(), 'threads:delete', threadId)
    set((s) => ({
      threadsByProject: {
        ...s.threadsByProject,
        [projectId]: (s.threadsByProject[projectId] ?? []).filter((t) => t.id !== threadId),
      },
      queueThreads: s.queueThreads.filter((t) => t.id !== threadId),
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

  /**
   * Snoozing drops the thread from both the project list and the Queue, since
   * a snoozed thread is by definition not awaiting the user.
   *
   * Unlike archiving this does no session teardown and drops no per-thread
   * state: a running thread keeps running while snoozed. The selection is left
   * alone too — you may well snooze the thread you are currently reading, and
   * yanking it out from under you would be hostile.
   */
  snooze: async (projectId, threadId, untilIso) => {
    await rpc(requireConnection(), 'threads:snooze', threadId, untilIso)
    set((s) => ({
      threadsByProject: {
        ...s.threadsByProject,
        [projectId]: (s.threadsByProject[projectId] ?? []).filter((t) => t.id !== threadId),
      },
      queueThreads: s.queueThreads.filter((t) => t.id !== threadId),
    }))
  },

  wake: async (projectId, threadId) => {
    await rpc(requireConnection(), 'threads:unsnooze', threadId)
    await Promise.all([get().fetch(projectId), get().fetchQueue()])
  },

  listSnoozed: async (projectId) => {
    return rpc(requireConnection(), 'threads:listSnoozed', projectId)
  },

  snoozedCount: async (projectId) => {
    return rpc(requireConnection(), 'threads:snoozedCount', projectId)
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
    set((s) => ({
      threadsByProject: patchInAllProjects(s.threadsByProject, threadId, patch),
      queueThreads: patchInQueue(s.queueThreads, threadId, patch),
    }))
  },

  findThread: (threadId) => {
    for (const threads of Object.values(get().threadsByProject)) {
      const found = threads.find((t) => t.id === threadId)
      if (found) return found
    }
    return undefined
  },
}))
