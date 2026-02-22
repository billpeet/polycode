import { create } from 'zustand'
import { Session } from '../types/ipc'

const EMPTY_SESSIONS: Session[] = []

interface SessionStore {
  sessionsByThread: Record<string, Session[]>
  activeSessionByThread: Record<string, string>

  fetch: (threadId: string) => Promise<void>
  setActiveSession: (threadId: string, sessionId: string) => void
  switchSession: (threadId: string, sessionId: string) => Promise<void>
  clear: (threadId: string) => void
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessionsByThread: {},
  activeSessionByThread: {},

  fetch: async (threadId) => {
    const sessions = await window.api.invoke('sessions:list', threadId)
    const active = sessions.find((s: Session) => s.is_active)
    set((s) => ({
      sessionsByThread: { ...s.sessionsByThread, [threadId]: sessions },
      activeSessionByThread: active
        ? { ...s.activeSessionByThread, [threadId]: active.id }
        : s.activeSessionByThread
    }))
  },

  setActiveSession: (threadId, sessionId) => {
    set((s) => ({
      activeSessionByThread: { ...s.activeSessionByThread, [threadId]: sessionId }
    }))
  },

  switchSession: async (threadId, sessionId) => {
    await window.api.invoke('sessions:switch', threadId, sessionId)
    set((s) => ({
      activeSessionByThread: { ...s.activeSessionByThread, [threadId]: sessionId }
    }))
  },

  clear: (threadId) =>
    set((s) => {
      const updatedSessions = { ...s.sessionsByThread }
      const updatedActive = { ...s.activeSessionByThread }
      delete updatedSessions[threadId]
      delete updatedActive[threadId]
      return { sessionsByThread: updatedSessions, activeSessionByThread: updatedActive }
    })
}))

export { EMPTY_SESSIONS }
