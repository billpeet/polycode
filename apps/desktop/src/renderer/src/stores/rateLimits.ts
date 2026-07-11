import { create } from 'zustand'

export interface RateLimitEntry {
  status: 'allowed_warning' | 'blocked' | 'unknown'
  resetsAt?: number // Unix timestamp in seconds
  rateLimitType: string
  utilization?: number
  provider: string
}

interface RateLimitStore {
  limitsByThread: Record<string, Record<string, RateLimitEntry>>
  setLimit: (
    threadId: string,
    provider: string,
    info: {
      status?: string
      resetsAt?: number
      rateLimitType?: string
      utilization?: number
    }
  ) => void
  clearExpired: (threadId: string) => void
  clearThread: (threadId: string) => void
}

export const useRateLimitStore = create<RateLimitStore>((set) => ({
  limitsByThread: {},

  setLimit: (threadId, provider, info) => {
    const key = info.rateLimitType ?? 'default'
    const status = info.status ?? 'unknown'

    // If status is 'allowed', remove this limit type
    if (status === 'allowed') {
      set((s) => {
        const threadLimits = { ...(s.limitsByThread[threadId] ?? {}) }
        delete threadLimits[key]
        return { limitsByThread: { ...s.limitsByThread, [threadId]: threadLimits } }
      })
      return
    }

    if (status !== 'allowed_warning' && status !== 'blocked' && status !== 'unknown') return

    const entry: RateLimitEntry = {
      status: status as RateLimitEntry['status'],
      resetsAt: info.resetsAt,
      rateLimitType: key,
      utilization: info.utilization,
      provider,
    }

    set((s) => ({
      limitsByThread: {
        ...s.limitsByThread,
        [threadId]: { ...(s.limitsByThread[threadId] ?? {}), [key]: entry },
      },
    }))
  },

  clearExpired: (threadId) => {
    const now = Math.floor(Date.now() / 1000)
    set((s) => {
      const threadLimits = s.limitsByThread[threadId]
      if (!threadLimits) return s

      const updated: Record<string, RateLimitEntry> = {}
      let changed = false
      for (const [key, entry] of Object.entries(threadLimits)) {
        if (entry.resetsAt && entry.resetsAt <= now) {
          changed = true // expired — drop it
        } else {
          updated[key] = entry
        }
      }
      if (!changed) return s
      return { limitsByThread: { ...s.limitsByThread, [threadId]: updated } }
    })
  },

  clearThread: (threadId) => {
    set((s) => {
      const updated = { ...s.limitsByThread }
      delete updated[threadId]
      return { limitsByThread: updated }
    })
  },
}))
