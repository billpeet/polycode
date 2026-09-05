import { create } from 'zustand'
import { appendFoldedMessage, eventRole } from '@polycode/shared'
import { Message, OutputEvent } from '../types/ipc'
import { isRemoteTransportError } from '../lib/remoteErrors'

interface MessageStore {
  messagesByThread: Record<string, Message[]>
  messagesBySession: Record<string, Message[]>

  fetch: (threadId: string) => Promise<void>
  fetchBySession: (sessionId: string) => Promise<void>

  appendEvent: (threadId: string, event: OutputEvent) => void
  appendEventToSession: (sessionId: string, threadId: string, event: OutputEvent) => void

  appendUserMessage: (threadId: string, content: string, messageId?: string) => void
  appendUserMessageToSession: (sessionId: string, threadId: string, content: string, messageId?: string) => void
  moveThreadMessages: (fromThreadId: string, toThreadId: string) => void

  clear: (threadId: string) => void
  clearSession: (sessionId: string) => void
}

export const useMessageStore = create<MessageStore>((set) => ({
  messagesByThread: {},
  messagesBySession: {},

  fetch: async (threadId) => {
    let messages: Message[]
    try {
      messages = await window.api.invoke('messages:list', threadId)
    } catch (error) {
      // A routine connectivity transition (remote host offline or slow) is not a defect:
      // keep the last-good transcript on screen and let the connection banner explain.
      // Anything else still propagates. (Issue #48.)
      if (isRemoteTransportError(error)) return
      throw error
    }
    set((s) => {
      const serverIds = new Set(messages.map((message: Message) => message.id))
      const pendingUserMessages = (s.messagesByThread[threadId] ?? [])
        .filter((message) => message.role === 'user' && !serverIds.has(message.id))
      return {
        messagesByThread: {
          ...s.messagesByThread,
          [threadId]: [...messages, ...pendingUserMessages],
        },
      }
    })
  },

  fetchBySession: async (sessionId) => {
    let messages: Message[]
    try {
      messages = await window.api.invoke('messages:listBySession', sessionId)
    } catch (error) {
      if (isRemoteTransportError(error)) return
      throw error
    }
    set((s) => ({ messagesBySession: { ...s.messagesBySession, [sessionId]: messages } }))
  },

  appendEvent: (threadId, event) => {
    if (event.type === 'status' || event.type === 'rate_limit' || event.type === 'usage') return

    // Determine role: check metadata.role first (for question answers), then infer from type
    const role = eventRole(event)
    const msg: Message = {
      id: `stream-${Date.now()}-${Math.random()}`,
      thread_id: threadId,
      session_id: event.sessionId ?? null,
      role,
      content: event.content,
      metadata: event.metadata ? JSON.stringify(event.metadata) : null,
      created_at: new Date().toISOString()
    }
    set((s) => ({
      messagesByThread: {
        ...s.messagesByThread,
        [threadId]: appendFoldedMessage(s.messagesByThread[threadId] ?? [], msg)
      }
    }))
  },

  appendEventToSession: (sessionId, threadId, event) => {
    if (event.type === 'status' || event.type === 'rate_limit' || event.type === 'usage') return

    const role = eventRole(event)
    const msg: Message = {
      id: `stream-${Date.now()}-${Math.random()}`,
      thread_id: threadId,
      session_id: sessionId,
      role,
      content: event.content,
      metadata: event.metadata ? JSON.stringify(event.metadata) : null,
      created_at: new Date().toISOString()
    }
    set((s) => ({
      messagesBySession: {
        ...s.messagesBySession,
        [sessionId]: appendFoldedMessage(s.messagesBySession[sessionId] ?? [], msg)
      }
    }))
  },

  appendUserMessage: (threadId, content, messageId) => {
    const msg: Message = {
      id: messageId ?? `optimistic-${Date.now()}-${Math.random()}`,
      thread_id: threadId,
      session_id: null,
      role: 'user',
      content,
      metadata: null,
      created_at: new Date().toISOString()
    }
    set((s) => ({
      messagesByThread: {
        ...s.messagesByThread,
        [threadId]: [...(s.messagesByThread[threadId] ?? []), msg]
      }
    }))
  },

  appendUserMessageToSession: (sessionId, threadId, content, messageId) => {
    const msg: Message = {
      id: messageId ?? `optimistic-${Date.now()}-${Math.random()}`,
      thread_id: threadId,
      session_id: sessionId,
      role: 'user',
      content,
      metadata: null,
      created_at: new Date().toISOString()
    }
    set((s) => ({
      messagesBySession: {
        ...s.messagesBySession,
        [sessionId]: [...(s.messagesBySession[sessionId] ?? []), msg]
      }
    }))
  },

  moveThreadMessages: (fromThreadId, toThreadId) =>
    set((s) => {
      const source = s.messagesByThread[fromThreadId] ?? []
      if (source.length === 0) return s
      const updated = { ...s.messagesByThread }
      delete updated[fromThreadId]
      updated[toThreadId] = [
        ...(updated[toThreadId] ?? []),
        ...source.map((message) => ({ ...message, thread_id: toThreadId })),
      ]
      return { messagesByThread: updated }
    }),

  clear: (threadId) =>
    set((s) => {
      const updated = { ...s.messagesByThread }
      delete updated[threadId]
      return { messagesByThread: updated }
    }),

  clearSession: (sessionId) =>
    set((s) => {
      const updated = { ...s.messagesBySession }
      delete updated[sessionId]
      return { messagesBySession: updated }
    })
}))
