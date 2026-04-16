import { create } from 'zustand'
import { Thread, ThreadStatus, SendOptions, Question, PermissionRequest, TokenUsage } from '../types/ipc'

const ARCHIVED_THREADS_PAGE_SIZE = 10

function makeOptimisticThreadId(): string {
  return `pending-thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function replaceThreadInList(threads: Thread[], threadId: string, nextThread: Thread): Thread[] {
  return threads.map((thread) => (thread.id === threadId ? nextThread : thread))
}

function removeThreadFromList(threads: Thread[], threadId: string): Thread[] {
  return threads.filter((thread) => thread.id !== threadId)
}

export interface QueuedMessage {
  content: string
  planMode: boolean
}

interface ThreadStore {
  /** active (non-archived) threads keyed by project ID */
  byProject: Record<string, Thread[]>
  /** archived threads keyed by project ID */
  archivedByProject: Record<string, Thread[]>
  /** count of archived threads keyed by project ID — populated on fetch, no full data load required */
  archivedCountByProject: Record<string, number>
  archivedPageByProject: Record<string, number>
  selectedThreadId: string | null
  statusMap: Record<string, ThreadStatus>
  unreadByThread: Record<string, boolean>
  expandedArchivedProjectId: string | null
  /** draft input text keyed by thread ID */
  draftByThread: Record<string, string>
  /** plan mode toggle keyed by thread ID */
  planModeByThread: Record<string, boolean>
  /** queued message keyed by thread ID (sent when current session completes) */
  queuedMessageByThread: Record<string, QueuedMessage | null>
  /** accumulated token usage keyed by thread ID */
  usageByThread: Record<string, TokenUsage>
  /** timestamp (ms) when each thread started running, keyed by thread ID */
  runStartedAtByThread: Record<string, number>
  /** OS PID of the running process, keyed by thread ID (null when not running) */
  pidByThread: Record<string, number | null>
  /** temporary thread ID currently being created per location */
  pendingThreadIdByLocation: Record<string, string | undefined>
  fetch: (projectId: string) => Promise<void>
  fetchArchived: (projectId: string, page?: number) => Promise<void>
  create: (projectId: string, name: string, locationId: string) => Promise<void>
  remove: (id: string, projectId: string) => Promise<void>
  archive: (id: string, projectId: string) => Promise<void>
  unarchive: (id: string, projectId: string) => Promise<void>
  toggleShowArchived: (projectId: string) => void
  setArchivedPage: (projectId: string, page: number) => Promise<void>
  select: (id: string | null) => void
  setStatus: (threadId: string, status: ThreadStatus) => void
  setUnread: (threadId: string, unread: boolean) => void
  /** Update local name state only (used by IPC title push events where DB is already updated) */
  setName: (threadId: string, name: string) => void
  /** Rename thread (persists to DB and updates local state) */
  rename: (threadId: string, name: string) => Promise<void>
  setModel: (threadId: string, model: string) => Promise<void>
  setProviderAndModel: (threadId: string, provider: string, model: string) => Promise<void>
  setYolo: (threadId: string, yoloMode: boolean) => Promise<void>
  setWsl: (threadId: string, useWsl: boolean, wslDistro: string | null) => Promise<void>
  start: (threadId: string) => Promise<void>
  stop: (threadId: string) => Promise<void>
  reset: (threadId: string) => Promise<void>
  send: (threadId: string, content: string, options?: SendOptions) => Promise<void>
  approvePlan: (threadId: string) => Promise<void>
  rejectPlan: (threadId: string) => Promise<void>
  getQuestions: (threadId: string) => Promise<Question[]>
  answerQuestion: (threadId: string, answers: Record<string, string>, questionComments: Record<string, string>, generalComment: string) => Promise<void>
  getPermissions: (threadId: string) => Promise<PermissionRequest[]>
  approvePermissions: (threadId: string, requestId?: string) => Promise<void>
  denyPermissions: (threadId: string, requestId?: string) => Promise<void>
  setDraft: (threadId: string, draft: string) => void
  setPlanMode: (threadId: string, planMode: boolean) => void
  queueMessage: (threadId: string, content: string, planMode: boolean) => void
  clearQueue: (threadId: string) => void
  importFromHistory: (projectId: string, locationId: string, sessionFilePath: string, sessionId: string, name: string) => Promise<void>
  addUsage: (threadId: string, input_tokens: number, output_tokens: number, context_window: number) => void
  setPid: (threadId: string, pid: number | null) => void
}

export const useThreadStore = create<ThreadStore>((set, get) => ({
  byProject: {},
  archivedByProject: {},
  archivedCountByProject: {},
  archivedPageByProject: {},
  selectedThreadId: null,
  statusMap: {},
  unreadByThread: {},
  expandedArchivedProjectId: null,
  draftByThread: {},
  planModeByThread: {},
  queuedMessageByThread: {},
  usageByThread: {},
  runStartedAtByThread: {},
  pidByThread: {},
  pendingThreadIdByLocation: {},

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
      },
      unreadByThread: {
        ...s.unreadByThread,
        ...Object.fromEntries(threads.map((t: Thread) => [t.id, !!t.unread]))
      },
      usageByThread: {
        ...s.usageByThread,
        ...Object.fromEntries(
          threads
            .filter((t: Thread) => t.input_tokens > 0 || t.output_tokens > 0)
            .map((t: Thread) => [t.id, { input_tokens: t.input_tokens, output_tokens: t.output_tokens, context_window: t.context_window }])
        )
      }
    }))
  },

  fetchArchived: async (projectId, page) => {
    const nextPage = page ?? get().archivedPageByProject[projectId] ?? 0
    const threads = await window.api.invoke(
      'threads:listArchived',
      projectId,
      ARCHIVED_THREADS_PAGE_SIZE,
      nextPage * ARCHIVED_THREADS_PAGE_SIZE
    )
    set((s) => ({
      archivedByProject: { ...s.archivedByProject, [projectId]: threads },
      archivedPageByProject: { ...s.archivedPageByProject, [projectId]: nextPage },
    }))
  },

  create: async (projectId, name, locationId) => {
    const existingPendingId = get().pendingThreadIdByLocation[locationId]
    if (existingPendingId) {
      set({ selectedThreadId: existingPendingId })
      return
    }

    const projectThreads = get().byProject[projectId] ?? []
    const previousSelectedThreadId = get().selectedThreadId
    const selectedThread = projectThreads.find((t) => t.id === get().selectedThreadId)
    const sourceThread =
      (selectedThread && selectedThread.location_id === locationId) ? selectedThread
        : projectThreads.find((t) => t.location_id === locationId) ?? null

    const optimisticId = makeOptimisticThreadId()
    const now = new Date().toISOString()
    const optimisticThread: Thread = {
      id: optimisticId,
      project_id: projectId,
      location_id: locationId,
      name,
      is_pending: true,
      provider: sourceThread?.provider ?? 'claude-code',
      model: sourceThread?.model ?? 'claude-opus-4-5',
      status: 'idle',
      archived: false,
      input_tokens: 0,
      output_tokens: 0,
      context_window: 0,
      unread: false,
      has_messages: false,
      yolo_mode: sourceThread?.yolo_mode ?? false,
      use_wsl: sourceThread?.use_wsl ?? false,
      wsl_distro: sourceThread?.wsl_distro ?? null,
      git_branch: null,
      created_at: now,
      updated_at: now,
    }

    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: [optimisticThread, ...(s.byProject[projectId] ?? [])]
      },
      statusMap: { ...s.statusMap, [optimisticId]: 'idle' },
      unreadByThread: { ...s.unreadByThread, [optimisticId]: false },
      pendingThreadIdByLocation: { ...s.pendingThreadIdByLocation, [locationId]: optimisticId },
      selectedThreadId: optimisticId,
    }))

    try {
      let thread = await window.api.invoke('threads:create', projectId, name, locationId)

      // Carry over per-thread WSL override for this location to new threads.
      if (
        sourceThread &&
        (
          thread.use_wsl !== sourceThread.use_wsl ||
          thread.wsl_distro !== sourceThread.wsl_distro ||
          thread.yolo_mode !== sourceThread.yolo_mode
        )
      ) {
        await window.api.invoke('threads:setWsl', thread.id, sourceThread.use_wsl, sourceThread.wsl_distro)
        await window.api.invoke('threads:setYolo', thread.id, sourceThread.yolo_mode)
        thread = {
          ...thread,
          use_wsl: sourceThread.use_wsl,
          wsl_distro: sourceThread.wsl_distro,
          yolo_mode: sourceThread.yolo_mode,
        }
      }

      set((s) => {
        const draft = s.draftByThread[optimisticId]
        const planMode = s.planModeByThread[optimisticId]
        const queuedMessage = s.queuedMessageByThread[optimisticId]
        const usage = s.usageByThread[optimisticId]
        const runStartedAt = s.runStartedAtByThread[optimisticId]
        const pid = s.pidByThread[optimisticId]

        const nextDraftByThread = { ...s.draftByThread }
        if (draft !== undefined) nextDraftByThread[thread.id] = draft
        delete nextDraftByThread[optimisticId]

        const nextPlanModeByThread = { ...s.planModeByThread }
        if (planMode !== undefined) nextPlanModeByThread[thread.id] = planMode
        delete nextPlanModeByThread[optimisticId]

        const nextQueuedByThread = { ...s.queuedMessageByThread }
        if (queuedMessage !== undefined) nextQueuedByThread[thread.id] = queuedMessage
        delete nextQueuedByThread[optimisticId]

        const nextUsageByThread = { ...s.usageByThread }
        if (usage !== undefined) nextUsageByThread[thread.id] = usage
        delete nextUsageByThread[optimisticId]

        const nextRunStartedAtByThread = { ...s.runStartedAtByThread }
        if (runStartedAt !== undefined) nextRunStartedAtByThread[thread.id] = runStartedAt
        delete nextRunStartedAtByThread[optimisticId]

        const nextPidByThread = { ...s.pidByThread }
        if (pid !== undefined) nextPidByThread[thread.id] = pid
        delete nextPidByThread[optimisticId]

        const nextStatusMap = { ...s.statusMap, [thread.id]: 'idle' }
        delete nextStatusMap[optimisticId]

        const nextUnreadByThread = { ...s.unreadByThread, [thread.id]: false }
        delete nextUnreadByThread[optimisticId]

        const nextPendingThreadIdByLocation = { ...s.pendingThreadIdByLocation }
        delete nextPendingThreadIdByLocation[locationId]

        return {
          byProject: {
            ...s.byProject,
            [projectId]: replaceThreadInList(s.byProject[projectId] ?? [], optimisticId, thread)
          },
          statusMap: nextStatusMap,
          unreadByThread: nextUnreadByThread,
          pendingThreadIdByLocation: nextPendingThreadIdByLocation,
          draftByThread: nextDraftByThread,
          planModeByThread: nextPlanModeByThread,
          queuedMessageByThread: nextQueuedByThread,
          usageByThread: nextUsageByThread,
          runStartedAtByThread: nextRunStartedAtByThread,
          pidByThread: nextPidByThread,
          selectedThreadId: s.selectedThreadId === optimisticId ? thread.id : s.selectedThreadId,
        }
      })
    } catch (error) {
      set((s) => {
        const nextPendingThreadIdByLocation = { ...s.pendingThreadIdByLocation }
        delete nextPendingThreadIdByLocation[locationId]

        const nextStatusMap = { ...s.statusMap }
        delete nextStatusMap[optimisticId]

        const nextUnreadByThread = { ...s.unreadByThread }
        delete nextUnreadByThread[optimisticId]

        const nextDraftByThread = { ...s.draftByThread }
        delete nextDraftByThread[optimisticId]

        const nextPlanModeByThread = { ...s.planModeByThread }
        delete nextPlanModeByThread[optimisticId]

        const nextQueuedByThread = { ...s.queuedMessageByThread }
        delete nextQueuedByThread[optimisticId]

        const nextUsageByThread = { ...s.usageByThread }
        delete nextUsageByThread[optimisticId]

        const nextRunStartedAtByThread = { ...s.runStartedAtByThread }
        delete nextRunStartedAtByThread[optimisticId]

        const nextPidByThread = { ...s.pidByThread }
        delete nextPidByThread[optimisticId]

        return {
          byProject: {
            ...s.byProject,
            [projectId]: removeThreadFromList(s.byProject[projectId] ?? [], optimisticId)
          },
          statusMap: nextStatusMap,
          unreadByThread: nextUnreadByThread,
          pendingThreadIdByLocation: nextPendingThreadIdByLocation,
          draftByThread: nextDraftByThread,
          planModeByThread: nextPlanModeByThread,
          queuedMessageByThread: nextQueuedByThread,
          usageByThread: nextUsageByThread,
          runStartedAtByThread: nextRunStartedAtByThread,
          pidByThread: nextPidByThread,
          selectedThreadId: s.selectedThreadId === optimisticId ? previousSelectedThreadId : s.selectedThreadId,
        }
      })
      throw error
    }
  },

  remove: async (id, projectId) => {
    await window.api.invoke('threads:delete', id)
    set((s) => {
      const updatedStatus = { ...s.statusMap }
      delete updatedStatus[id]
      const updatedUnread = { ...s.unreadByThread }
      delete updatedUnread[id]
      const updatedQueue = { ...s.queuedMessageByThread }
      delete updatedQueue[id]
      const updatedPlanMode = { ...s.planModeByThread }
      delete updatedPlanMode[id]
      const updatedRunStartedAt = { ...s.runStartedAtByThread }
      delete updatedRunStartedAt[id]
      const updatedPid = { ...s.pidByThread }
      delete updatedPid[id]
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
        statusMap: updatedStatus,
        unreadByThread: updatedUnread,
        queuedMessageByThread: updatedQueue,
        planModeByThread: updatedPlanMode,
        runStartedAtByThread: updatedRunStartedAt,
        pidByThread: updatedPid,
      }
    })
  },

  archive: async (id, projectId) => {
    const snapshot = get()
    const wasArchivedExpanded = get().expandedArchivedProjectId === projectId
    const currentArchivedPage = get().archivedPageByProject[projectId] ?? 0
    set((s) => {
      const thread = (s.byProject[projectId] ?? []).find((t) => t.id === id)
      if (!thread) return s
      const updatedStatus = { ...s.statusMap }
      delete updatedStatus[id]
      const updatedUnread = { ...s.unreadByThread }
      delete updatedUnread[id]
      const updatedQueue = { ...s.queuedMessageByThread }
      delete updatedQueue[id]
      const updatedPlanMode = { ...s.planModeByThread }
      delete updatedPlanMode[id]
      const updatedRunStartedAt = { ...s.runStartedAtByThread }
      delete updatedRunStartedAt[id]
      const updatedPid = { ...s.pidByThread }
      delete updatedPid[id]
      const withoutThread = removeThreadFromList(s.byProject[projectId] ?? [], id)
      const prevCount = s.archivedCountByProject[projectId] ?? 0
      return {
        byProject: { ...s.byProject, [projectId]: withoutThread },
        archivedCountByProject: { ...s.archivedCountByProject, [projectId]: prevCount + 1 },
        selectedThreadId: s.selectedThreadId === id ? null : s.selectedThreadId,
        statusMap: updatedStatus,
        unreadByThread: updatedUnread,
        queuedMessageByThread: updatedQueue,
        planModeByThread: updatedPlanMode,
        runStartedAtByThread: updatedRunStartedAt,
        pidByThread: updatedPid,
      }
    })

    try {
      const result = await window.api.invoke('threads:archive', id)
      if (result === 'deleted') {
        set((s) => {
          const prevCount = s.archivedCountByProject[projectId] ?? 0
          return {
            archivedCountByProject: {
              ...s.archivedCountByProject,
              [projectId]: Math.max(0, prevCount - 1)
            }
          }
        })
      } else if (wasArchivedExpanded) {
        await get().setArchivedPage(projectId, currentArchivedPage)
      }
    } catch (error) {
      set({
        byProject: snapshot.byProject,
        archivedCountByProject: snapshot.archivedCountByProject,
        selectedThreadId: snapshot.selectedThreadId,
        statusMap: snapshot.statusMap,
        unreadByThread: snapshot.unreadByThread,
        queuedMessageByThread: snapshot.queuedMessageByThread,
        planModeByThread: snapshot.planModeByThread,
        runStartedAtByThread: snapshot.runStartedAtByThread,
        pidByThread: snapshot.pidByThread,
      })
      throw error
    }
  },

  unarchive: async (id, projectId) => {
    const wasArchivedExpanded = get().expandedArchivedProjectId === projectId
    const currentArchivedPage = get().archivedPageByProject[projectId] ?? 0
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
        statusMap: thread ? { ...s.statusMap, [id]: thread.status } : s.statusMap,
        unreadByThread: thread ? { ...s.unreadByThread, [id]: !!thread.unread } : s.unreadByThread
      }
    })
    if (wasArchivedExpanded) {
      await get().setArchivedPage(projectId, currentArchivedPage)
    }
  },

  toggleShowArchived: (projectId) => {
    const isExpanded = get().expandedArchivedProjectId === projectId
    if (isExpanded) {
      set({ expandedArchivedProjectId: null })
      return
    }
    set({ expandedArchivedProjectId: projectId })
    void get().fetchArchived(projectId, 0)
  },

  setArchivedPage: async (projectId, page) => {
    const count = get().archivedCountByProject[projectId] ?? 0
    const maxPage = Math.max(0, Math.ceil(count / ARCHIVED_THREADS_PAGE_SIZE) - 1)
    const nextPage = Math.min(Math.max(page, 0), maxPage)
    await get().fetchArchived(projectId, nextPage)
  },

  select: (id) => {
    const wasUnread = !!(id && get().unreadByThread[id])
    set((s) => {
      if (!id) return { selectedThreadId: null }
      return {
        selectedThreadId: id,
        unreadByThread: { ...s.unreadByThread, [id]: false }
      }
    })
    if (id && wasUnread) {
      void window.api.invoke('threads:setUnread', id, false)
    }
  },

  setStatus: (threadId, status) =>
    set((s) => {
      const currentStatus = s.statusMap[threadId]
      const hasRunStart = !!s.runStartedAtByThread[threadId]
      const nextHasRunStart = status === 'running'
      if (currentStatus === status && hasRunStart === nextHasRunStart) return s

      const runStartedAtByThread = { ...s.runStartedAtByThread }
      if (nextHasRunStart) {
        if (!runStartedAtByThread[threadId]) runStartedAtByThread[threadId] = Date.now()
      } else {
        delete runStartedAtByThread[threadId]
      }
      return { statusMap: { ...s.statusMap, [threadId]: status }, runStartedAtByThread }
    }),

  setUnread: (threadId, unread) => {
    // Active thread cannot be unread by definition.
    const selectedThreadId = get().selectedThreadId
    const nextUnread = selectedThreadId === threadId ? false : unread
    const current = !!get().unreadByThread[threadId]
    if (current === nextUnread) return
    set((s) => ({ unreadByThread: { ...s.unreadByThread, [threadId]: nextUnread } }))
    void window.api.invoke('threads:setUnread', threadId, nextUnread)
  },

  setName: (threadId, name) =>
    set((s) => {
      let changed = false
      const updated: Record<string, Thread[]> = {}
      for (const pid of Object.keys(s.byProject)) {
        const nextThreads = s.byProject[pid].map((t) => {
          if (t.id !== threadId || t.name === name) return t
          changed = true
          return { ...t, name }
        })
        updated[pid] = nextThreads
      }
      return changed ? { byProject: updated } : s
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

  setProviderAndModel: async (threadId, provider, model) => {
    await window.api.invoke('threads:updateProviderAndModel', threadId, provider, model)
    set((s) => {
      const updated = { ...s.byProject }
      for (const pid of Object.keys(updated)) {
        updated[pid] = updated[pid].map((t) => (t.id === threadId ? { ...t, provider, model } : t))
      }
      return { byProject: updated }
    })
  },

  setWsl: async (threadId, useWsl, wslDistro) => {
    await window.api.invoke('threads:setWsl', threadId, useWsl, wslDistro)
    set((s) => {
      const updated = { ...s.byProject }
      for (const pid of Object.keys(updated)) {
        updated[pid] = updated[pid].map((t) =>
          t.id === threadId ? { ...t, use_wsl: useWsl, wsl_distro: wslDistro } : t
        )
      }
      return { byProject: updated }
    })
  },

  setYolo: async (threadId, yoloMode) => {
    await window.api.invoke('threads:setYolo', threadId, yoloMode)
    set((s) => {
      const updated = { ...s.byProject }
      for (const pid of Object.keys(updated)) {
        updated[pid] = updated[pid].map((t) =>
          t.id === threadId ? { ...t, yolo_mode: yoloMode } : t
        )
      }
      return { byProject: updated }
    })
  },

  start: async (threadId) => {
    await window.api.invoke('threads:start', threadId)
  },

  stop: async (threadId) => {
    await window.api.invoke('threads:stop', threadId)
  },

  reset: async (threadId) => {
    set((s) => {
      const runStartedAtByThread = { ...s.runStartedAtByThread }
      delete runStartedAtByThread[threadId]
      return {
        statusMap: { ...s.statusMap, [threadId]: 'idle' },
        pidByThread: { ...s.pidByThread, [threadId]: null },
        runStartedAtByThread,
      }
    })
    await window.api.invoke('threads:reset', threadId)
  },

  send: async (threadId, content, options) => {
    // Optimistically set status + mark thread as having messages
    set((s) => {
      const updated = { ...s.byProject }
      for (const pid of Object.keys(updated)) {
        updated[pid] = updated[pid].map((t) =>
          t.id === threadId ? { ...t, has_messages: true } : t
        )
      }
      return {
        statusMap: { ...s.statusMap, [threadId]: 'running' },
        byProject: updated,
        runStartedAtByThread: { ...s.runStartedAtByThread, [threadId]: Date.now() },
      }
    })
    await window.api.invoke('threads:send', threadId, content, options)
  },

  approvePlan: async (threadId) => {
    set((s) => ({
      statusMap: { ...s.statusMap, [threadId]: 'running' },
      runStartedAtByThread: { ...s.runStartedAtByThread, [threadId]: Date.now() },
    }))
    await window.api.invoke('threads:approvePlan', threadId)
  },

  rejectPlan: async (threadId) => {
    set((s) => ({ statusMap: { ...s.statusMap, [threadId]: 'idle' } }))
    await window.api.invoke('threads:rejectPlan', threadId)
  },

  getQuestions: async (threadId) => {
    return await window.api.invoke('threads:getQuestions', threadId)
  },

  answerQuestion: async (threadId, answers, questionComments, generalComment) => {
    set((s) => ({
      statusMap: { ...s.statusMap, [threadId]: 'running' },
      runStartedAtByThread: { ...s.runStartedAtByThread, [threadId]: Date.now() },
    }))
    await window.api.invoke('threads:answerQuestion', threadId, answers, questionComments, generalComment)
  },

  getPermissions: async (threadId) => {
    return window.api.invoke('threads:getPendingPermissions', threadId)
  },

  approvePermissions: async (threadId, requestId) => {
    set((s) => ({
      statusMap: { ...s.statusMap, [threadId]: 'running' },
      runStartedAtByThread: { ...s.runStartedAtByThread, [threadId]: Date.now() },
    }))
    await window.api.invoke('threads:approvePermissions', threadId, requestId)
  },

  denyPermissions: async (threadId, requestId) => {
    set((s) => ({
      statusMap: { ...s.statusMap, [threadId]: 'idle' },
    }))
    await window.api.invoke('threads:denyPermissions', threadId, requestId)
  },

  setDraft: (threadId, draft) =>
    set((s) => ({ draftByThread: { ...s.draftByThread, [threadId]: draft } })),

  setPlanMode: (threadId, planMode) =>
    set((s) => ({ planModeByThread: { ...s.planModeByThread, [threadId]: planMode } })),

  queueMessage: (threadId, content, planMode) =>
    set((s) => ({
      queuedMessageByThread: { ...s.queuedMessageByThread, [threadId]: { content, planMode } }
    })),

  clearQueue: (threadId) =>
    set((s) => {
      const updated = { ...s.queuedMessageByThread }
      delete updated[threadId]
      return { queuedMessageByThread: updated }
    }),

  importFromHistory: async (projectId, locationId, sessionFilePath, sessionId, name) => {
    const thread = await window.api.invoke('claude-history:import', projectId, locationId, sessionFilePath, sessionId, name)
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: [thread, ...(s.byProject[projectId] ?? [])]
      },
      statusMap: { ...s.statusMap, [thread.id]: 'idle' },
      unreadByThread: { ...s.unreadByThread, [thread.id]: false },
      selectedThreadId: thread.id
    }))
  },

  addUsage: (threadId, input_tokens, output_tokens, context_window) =>
    set((s) => {
      const prev = s.usageByThread[threadId]
      return {
        usageByThread: {
          ...s.usageByThread,
          [threadId]: {
            input_tokens: (prev?.input_tokens ?? 0) + input_tokens,
            output_tokens: (prev?.output_tokens ?? 0) + output_tokens,
            context_window,
          }
        }
      }
    }),

  setPid: (threadId, pid) =>
    set((s) => {
      if ((s.pidByThread[threadId] ?? null) === pid) return s
      return { pidByThread: { ...s.pidByThread, [threadId]: pid } }
    }),
}))
