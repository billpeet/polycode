import { create } from 'zustand'
import { rpc } from '../api/rpc'
import { requireConnection } from './hosts'

export interface PlanEntry {
  name: string
  path: string | null
  content: string | null
}

/**
 * Plan files associated with threads. Populated live from plan:associated /
 * plan-file:changed SSE events and seeded via plans:getForThread on open
 * (content falls back to files:read when the session no longer holds it).
 */
interface PlansState {
  planByThread: Record<string, PlanEntry>
  threadByPlanName: Record<string, string>

  setPlan: (threadId: string, plan: PlanEntry) => void
  updateByName: (name: string, content: string) => void
  fetch: (threadId: string) => Promise<void>
}

export const usePlansStore = create<PlansState>((set, get) => ({
  planByThread: {},
  threadByPlanName: {},

  setPlan: (threadId, plan) =>
    set((s) => ({
      planByThread: { ...s.planByThread, [threadId]: plan },
      threadByPlanName: { ...s.threadByPlanName, [plan.name]: threadId },
    })),

  updateByName: (name, content) => {
    const threadId = get().threadByPlanName[name]
    if (!threadId) return
    set((s) => ({
      planByThread: {
        ...s.planByThread,
        [threadId]: { ...s.planByThread[threadId], content },
      },
    }))
  },

  fetch: async (threadId) => {
    const connection = requireConnection()
    const plan = await rpc(connection, 'plans:getForThread', threadId)
    if (!plan) return
    let content = plan.content
    // The session drops plan content after approval — re-read from disk.
    if (!content && plan.path) {
      try {
        const file = await rpc(connection, 'files:read', plan.path)
        content = file?.content ?? null
      } catch {
        content = null
      }
    }
    get().setPlan(threadId, { ...plan, content })
  },
}))
