import { create } from 'zustand'
import { Thread, ThreadStatus, SendOptions, Question, TokenUsage } from '../types/ipc'

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
  selectedThreadId: string | null
  statusMap: Record<string, ThreadStatus>
  showArchived: boolean
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
  fetch: (projectId: string) => Promise<void>
  fetchArchived: (projectId: string) => Promise<void>
  create: (projectId: string, name: string, locationId: string) => Promise<void>
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
  setProviderAndModel: (threadId: string, provider: string, model: string) => Promise<void>
  setWsl: (threadId: string, useWsl: boolean, wslDistro: string | null) => Promise<void>
  start: (threadId: string) => Promise<void>
  stop: (threadId: string) => Promise<void>
  send: (threadId: string, content: string, options?: SendOptions) => Promise<void>
  approvePlan: (threadId: string) => Promise<void>
  rejectPlan: (threadId: string) => Promise<void>
  getQuestions: (threadId: string) => Promise<Question[]>
  answerQuestion: (threadId: string, answers: Record<string, string>, questionComments: Record<string, string>, generalComment: string) => Promise<void>
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
  selectedThreadId: null,
  statusMap: {},
  showArchived: false,
  draftByThread: {},
  planModeByThread: {},
  queuedMessageByThread: {},
  usageByThread: {},
  runStartedAtByThread: {},
  pidByThread: {},

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

  fetchArchived: async (projectId) => {
    const threads = await window.api.invoke('threads:listArchived', projectId)
    set((s) => ({
      archivedByProject: { ...s.archivedByProject, [projectId]: threads },
      archivedCountByProject: { ...s.archivedCountByProject, [projectId]: threads.length },
    }))
  },

  create: async (projectId, name, locationId) => {
    const projectThreads = get().byProject[projectId] ?? []
    const selectedThread = projectThreads.find((t) => t.id === get().selectedThreadId)
    const sourceThread =
      (selectedThread && selectedThread.location_id === locationId) ? selectedThread
        : projectThreads.find((t) => t.location_id === locationId) ?? null

    let thread = await window.api.invoke('threads:create', projectId, name, locationId)

    // Carry over per-thread WSL override for this location to new threads.
    if (
      sourceThread &&
      (thread.use_wsl !== sourceThread.use_wsl || thread.wsl_distro !== sourceThread.wsl_distro)
    ) {
      await window.api.invoke('threads:setWsl', thread.id, sourceThread.use_wsl, sourceThread.wsl_distro)
      thread = { ...thread, use_wsl: sourceThread.use_wsl, wsl_distro: sourceThread.wsl_distro }
    }

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
        queuedMessageByThread: updatedQueue,
        planModeByThread: updatedPlanMode,
        runStartedAtByThread: updatedRunStartedAt,
        pidByThread: updatedPid,
      }
    })
  },

  archive: async (id, projectId) => {
    const result = await window.api.invoke('threads:archive', id)
    set((s) => {
      const thread = (s.byProject[projectId] ?? []).find((t) => t.id === id)
      const updatedStatus = { ...s.statusMap }
      delete updatedStatus[id]
      const updatedQueue = { ...s.queuedMessageByThread }
      delete updatedQueue[id]
      const updatedPlanMode = { ...s.planModeByThread }
      delete updatedPlanMode[id]
      const updatedRunStartedAt = { ...s.runStartedAtByThread }
      delete updatedRunStartedAt[id]
      const updatedPid = { ...s.pidByThread }
      delete updatedPid[id]
      const withoutThread = (s.byProject[projectId] ?? []).filter((t) => t.id !== id)
      if (result === 'deleted') {
        return {
          byProject: { ...s.byProject, [projectId]: withoutThread },
          selectedThreadId: s.selectedThreadId === id ? null : s.selectedThreadId,
          statusMap: updatedStatus,
          queuedMessageByThread: updatedQueue,
          planModeByThread: updatedPlanMode,
          runStartedAtByThread: updatedRunStartedAt,
          pidByThread: updatedPid,
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
        statusMap: updatedStatus,
        queuedMessageByThread: updatedQueue,
        planModeByThread: updatedPlanMode,
        runStartedAtByThread: updatedRunStartedAt,
        pidByThread: updatedPid,
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
    set((s) => {
      const runStartedAtByThread = { ...s.runStartedAtByThread }
      if (status === 'running') {
        if (!runStartedAtByThread[threadId]) runStartedAtByThread[threadId] = Date.now()
      } else {
        delete runStartedAtByThread[threadId]
      }
      return { statusMap: { ...s.statusMap, [threadId]: status }, runStartedAtByThread }
    }),

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

  start: async (threadId) => {
    await window.api.invoke('threads:start', threadId)
  },

  stop: async (threadId) => {
    await window.api.invoke('threads:stop', threadId)
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
    set((s) => ({ pidByThread: { ...s.pidByThread, [threadId]: pid } })),
}))
