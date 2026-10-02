import { create } from 'zustand'
import { appendFoldedMessage, eventRole } from '@polycode/shared'
import { Message, OutputEvent } from '../types/ipc'
import { settleRemoteRefresh } from '../lib/remoteErrors'
import { client } from '../lib/client'

interface MessageStore {
  messagesByThread: Record<string, Message[]>
  messagesBySession: Record<string, Message[]>

  fetch: (threadId: string) => Promise<void>
  fetchBySession: (sessionId: string) => Promise<void>

  appendEvent: (threadId: string, event: OutputEvent) => void
  appendEventToSession: (sessionId: string, threadId: string, event: OutputEvent) => void
  /** One store write for a batch of frames; see lib/outputBatcher.ts. */
  appendEvents: (threadId: string, events: OutputEvent[]) => void
  appendEventsToSession: (sessionId: string, threadId: string, events: OutputEvent[]) => void

  appendUserMessage: (threadId: string, content: string, messageId?: string) => void
  appendUserMessageToSession: (sessionId: string, threadId: string, content: string, messageId?: string) => void
  moveThreadMessages: (fromThreadId: string, toThreadId: string) => void

  clear: (threadId: string) => void
  clearSession: (sessionId: string) => void
}

/** The transient message a streamed frame becomes, or nothing for frames that are not messages. */
function streamMessageFor(threadId: string, sessionId: string | null, event: OutputEvent): Message[] {
  if (event.type === 'status' || event.type === 'rate_limit' || event.type === 'usage') return []
  return [{
    id: `stream-${Date.now()}-${Math.random()}`,
    thread_id: threadId,
    session_id: sessionId ?? event.sessionId ?? null,
    role: eventRole(event),
    content: event.content,
    metadata: event.metadata ? JSON.stringify(event.metadata) : null,
    created_at: new Date().toISOString()
  }]
}

export const useMessageStore = create<MessageStore>((set) => ({
  messagesByThread: {},
  messagesBySession: {},

  fetch: async (threadId) => {
    const messages = await settleRemoteRefresh(client.invoke('messages:list', threadId))
    if (!messages) return
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
    const messages = await settleRemoteRefresh(client.invoke('messages:listBySession', sessionId))
    if (!messages) return
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

  appendEvents: (threadId, events) => {
    const incoming = events.flatMap((event) => streamMessageFor(threadId, null, event))
    if (incoming.length === 0) return
    set((s) => ({
      messagesByThread: {
        ...s.messagesByThread,
        [threadId]: incoming.reduce(appendFoldedMessage, s.messagesByThread[threadId] ?? [])
      }
    }))
  },

  appendEventsToSession: (sessionId, threadId, events) => {
    const incoming = events.flatMap((event) => streamMessageFor(threadId, sessionId, event))
    if (incoming.length === 0) return
    set((s) => ({
      messagesBySession: {
        ...s.messagesBySession,
        [sessionId]: incoming.reduce(appendFoldedMessage, s.messagesBySession[sessionId] ?? [])
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
