import { create } from 'zustand'
import type { Session } from '@polycode/shared'
import { rpc } from '../api/rpc'
import { requireConnection } from './hosts'

/** Mirrors the desktop session store: per-thread session list + active id. */
interface SessionsState {
  sessionsByThread: Record<string, Session[]>
  activeSessionByThread: Record<string, string | undefined>

  fetch: (threadId: string) => Promise<void>
  switchSession: (threadId: string, sessionId: string) => Promise<void>
  clear: (threadId: string) => void
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessionsByThread: {},
  activeSessionByThread: {},

  fetch: async (threadId) => {
    const sessions = await rpc(requireConnection(), 'sessions:list', threadId)
    const active = sessions.find((session) => session.is_active)
    set((s) => ({
      sessionsByThread: { ...s.sessionsByThread, [threadId]: sessions },
      activeSessionByThread: { ...s.activeSessionByThread, [threadId]: active?.id },
    }))
  },

  switchSession: async (threadId, sessionId) => {
    if (get().activeSessionByThread[threadId] === sessionId) return
    await rpc(requireConnection(), 'sessions:switch', threadId, sessionId)
    set((s) => ({
      activeSessionByThread: { ...s.activeSessionByThread, [threadId]: sessionId },
    }))
  },

  clear: (threadId) =>
    set((s) => {
      const sessions = { ...s.sessionsByThread }
      const active = { ...s.activeSessionByThread }
      delete sessions[threadId]
      delete active[threadId]
      return { sessionsByThread: sessions, activeSessionByThread: active }
    }),
}))
