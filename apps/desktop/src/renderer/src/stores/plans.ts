import { create } from 'zustand'

export interface PlanFileEntry {
  name: string
  path: string
  content: string
  modifiedAt: number
}

interface PlanStore {
  /** Plan file per thread */
  planByThread: Record<string, PlanFileEntry>
  /** Reverse lookup: plan filename → threadId (for file-watcher updates) */
  threadByPlanFile: Record<string, string>
  /** Whether the plan viewer is visible (per thread) */
  visibleByThread: Record<string, boolean>

  setPlanForThread: (threadId: string, plan: PlanFileEntry) => void
  setVisible: (threadId: string, visible: boolean) => void
  toggleVisible: (threadId: string) => void
  clearThread: (threadId: string) => void
  /** Update plan content when file watcher detects changes (keyed by filename) */
  updatePlanContent: (fileName: string, content: string, modifiedAt: number) => void
}

export const usePlanStore = create<PlanStore>((set) => ({
  planByThread: {},
  threadByPlanFile: {},
  visibleByThread: {},

  setPlanForThread: (threadId, plan) =>
    set((s) => ({
      planByThread: { ...s.planByThread, [threadId]: plan },
      threadByPlanFile: { ...s.threadByPlanFile, [plan.name]: threadId },
    })),

  setVisible: (threadId, visible) =>
    set((s) => ({
      visibleByThread: { ...s.visibleByThread, [threadId]: visible },
    })),

  toggleVisible: (threadId) =>
    set((s) => ({
      visibleByThread: { ...s.visibleByThread, [threadId]: !s.visibleByThread[threadId] },
    })),

  clearThread: (threadId) =>
    set((s) => {
      const { [threadId]: removed, ...rest } = s.planByThread
      const { [threadId]: _vis, ...restVis } = s.visibleByThread
      // Remove reverse lookup entry
      const newThreadByFile = { ...s.threadByPlanFile }
      if (removed) {
        delete newThreadByFile[removed.name]
      }
      return { planByThread: rest, visibleByThread: restVis, threadByPlanFile: newThreadByFile }
    }),

  updatePlanContent: (fileName, content, modifiedAt) =>
    set((s) => {
      const threadId = s.threadByPlanFile[fileName]
      if (!threadId) return s // Unknown file, no thread association
      const existing = s.planByThread[threadId]
      if (!existing) return s
      return {
        planByThread: {
          ...s.planByThread,
          [threadId]: { ...existing, content, modifiedAt },
        },
      }
    }),
}))

// Subscribe to plan:associated events from session layer (per-thread)
window.api.on('plan:associated', (data: unknown) => {
  const { threadId, name, path, content } = data as {
    threadId: string
    name: string
    path: string
    content: string
  }
  const plan: PlanFileEntry = { name, path, content, modifiedAt: Date.now() }
  usePlanStore.getState().setPlanForThread(threadId, plan)
  usePlanStore.getState().setVisible(threadId, true)
})

// Subscribe to plan-file:changed events from file watcher (content updates)
window.api.on('plan-file:changed', (data: unknown) => {
  const { name, content, modifiedAt } = data as {
    name: string
    path: string
    content: string
    modifiedAt: number
  }
  usePlanStore.getState().updatePlanContent(name, content, modifiedAt)
})
