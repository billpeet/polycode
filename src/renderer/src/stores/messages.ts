import { create } from 'zustand'
import { Message, OutputEvent } from '../types/ipc'

function parseMetadata(metadata: string | null): Record<string, unknown> | null {
  if (!metadata) return null
  try {
    return JSON.parse(metadata) as Record<string, unknown>
  } catch {
    return null
  }
}

function appendOrMergeMessage(messages: Message[], incoming: Message, event: OutputEvent): Message[] {
  const previous = messages[messages.length - 1]
  if (!previous || previous.role !== incoming.role) {
    return [...messages, incoming]
  }

  const previousMetadata = parseMetadata(previous.metadata)
  const nextMetadata = event.metadata ?? null

  if (event.type === 'text') {
    const previousType = previousMetadata?.type
    if (!previousType) {
      return [
        ...messages.slice(0, -1),
        {
          ...previous,
          content: previous.content + incoming.content,
          created_at: incoming.created_at,
        },
      ]
    }
    return [...messages, incoming]
  }

  if (event.type === 'tool_result') {
    const previousToolUseId = typeof previousMetadata?.tool_use_id === 'string' ? previousMetadata.tool_use_id : null
    const nextToolUseId = typeof nextMetadata?.tool_use_id === 'string' ? nextMetadata.tool_use_id : null
    if (!previousToolUseId || !nextToolUseId || previousToolUseId !== nextToolUseId) {
      return [...messages, incoming]
    }

    const previousContent = previous.content
    const nextContent =
      incoming.content.startsWith(previousContent)
        ? incoming.content
        : previousContent + incoming.content

    return [
      ...messages.slice(0, -1),
      {
        ...previous,
        content: nextContent,
        metadata: incoming.metadata,
        created_at: incoming.created_at,
      },
    ]
  }

  return [...messages, incoming]
}

interface MessageStore {
  messagesByThread: Record<string, Message[]>
  messagesBySession: Record<string, Message[]>

  fetch: (threadId: string) => Promise<void>
  fetchBySession: (sessionId: string) => Promise<void>

  appendEvent: (threadId: string, event: OutputEvent) => void
  appendEventToSession: (sessionId: string, threadId: string, event: OutputEvent) => void

  appendUserMessage: (threadId: string, content: string) => void
  appendUserMessageToSession: (sessionId: string, threadId: string, content: string) => void

  clear: (threadId: string) => void
  clearSession: (sessionId: string) => void
}

export const useMessageStore = create<MessageStore>((set) => ({
  messagesByThread: {},
  messagesBySession: {},

  fetch: async (threadId) => {
    const messages = await window.api.invoke('messages:list', threadId)
    set((s) => ({ messagesByThread: { ...s.messagesByThread, [threadId]: messages } }))
  },

  fetchBySession: async (sessionId) => {
    const messages = await window.api.invoke('messages:listBySession', sessionId)
    set((s) => ({ messagesBySession: { ...s.messagesBySession, [sessionId]: messages } }))
  },

  appendEvent: (threadId, event) => {
    if (event.type === 'status' || event.type === 'rate_limit' || event.type === 'usage') return

    // Determine role: check metadata.role first (for question answers), then infer from type
    const role = event.metadata?.role ?? (event.type === 'error' ? 'system' : 'assistant')
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
        [threadId]: appendOrMergeMessage(s.messagesByThread[threadId] ?? [], msg, event)
      }
    }))
  },

  appendEventToSession: (sessionId, threadId, event) => {
    if (event.type === 'status' || event.type === 'rate_limit' || event.type === 'usage') return

    const role = event.metadata?.role ?? (event.type === 'error' ? 'system' : 'assistant')
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
        [sessionId]: appendOrMergeMessage(s.messagesBySession[sessionId] ?? [], msg, event)
      }
    }))
  },

  appendUserMessage: (threadId, content) => {
    const msg: Message = {
      id: `optimistic-${Date.now()}-${Math.random()}`,
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

  appendUserMessageToSession: (sessionId, threadId, content) => {
    const msg: Message = {
      id: `optimistic-${Date.now()}-${Math.random()}`,
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
