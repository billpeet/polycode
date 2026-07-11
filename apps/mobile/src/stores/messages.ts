import { create } from 'zustand'
import {
  appendOrMergeMessage,
  eventRole,
  type Message,
  type OutputEvent,
  type TokenUsage,
} from '@polycode/shared'
import { rpc } from '../api/rpc'
import { requireConnection } from './hosts'

let streamCounter = 0

interface MessagesState {
  messagesByThread: Record<string, Message[]>
  usageByThread: Record<string, TokenUsage>
  loadingByThread: Record<string, boolean>

  fetch: (threadId: string) => Promise<Message[]>
  appendEvent: (threadId: string, event: OutputEvent) => void
  appendUserMessage: (threadId: string, content: string) => void
  clear: (threadId: string) => void
}

export const useMessagesStore = create<MessagesState>((set) => ({
  messagesByThread: {},
  usageByThread: {},
  loadingByThread: {},

  fetch: async (threadId) => {
    set((s) => ({ loadingByThread: { ...s.loadingByThread, [threadId]: true } }))
    try {
      const messages = await rpc(requireConnection(), 'messages:list', threadId)
      set((s) => ({
        messagesByThread: { ...s.messagesByThread, [threadId]: messages },
        loadingByThread: { ...s.loadingByThread, [threadId]: false },
      }))
      return messages
    } catch (error) {
      set((s) => ({ loadingByThread: { ...s.loadingByThread, [threadId]: false } }))
      throw error
    }
  },

  appendEvent: (threadId, event) => {
    // usage events update the token counter instead of rendering a bubble.
    if (event.type === 'usage') {
      const meta = event.metadata ?? {}
      const usage: TokenUsage = {
        input_tokens: typeof meta.input_tokens === 'number' ? meta.input_tokens : 0,
        output_tokens: typeof meta.output_tokens === 'number' ? meta.output_tokens : 0,
        context_window: typeof meta.context_window === 'number' ? meta.context_window : 0,
      }
      set((s) => ({ usageByThread: { ...s.usageByThread, [threadId]: usage } }))
      return
    }
    // status / rate_limit events are not message bubbles (mirrors desktop).
    if (event.type === 'status' || event.type === 'rate_limit') return
    // question / permission_request drive banner state, not bubbles.
    if (event.type === 'question' || event.type === 'permission_request') return

    const msg: Message = {
      id: `stream-${Date.now()}-${streamCounter++}`,
      thread_id: threadId,
      session_id: event.sessionId ?? null,
      role: eventRole(event),
      content: event.content,
      metadata: event.metadata ? JSON.stringify(event.metadata) : null,
      created_at: new Date().toISOString(),
    }
    set((s) => ({
      messagesByThread: {
        ...s.messagesByThread,
        [threadId]: appendOrMergeMessage(s.messagesByThread[threadId] ?? [], msg, event),
      },
    }))
  },

  appendUserMessage: (threadId, content) => {
    const msg: Message = {
      id: `optimistic-${Date.now()}-${streamCounter++}`,
      thread_id: threadId,
      session_id: null,
      role: 'user',
      content,
      metadata: null,
      created_at: new Date().toISOString(),
    }
    set((s) => ({
      messagesByThread: {
        ...s.messagesByThread,
        [threadId]: [...(s.messagesByThread[threadId] ?? []), msg],
      },
    }))
  },

  clear: (threadId) =>
    set((s) => {
      const updated = { ...s.messagesByThread }
      delete updated[threadId]
      return { messagesByThread: updated }
    }),
}))
