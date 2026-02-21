import { create } from 'zustand'
import { Message, OutputEvent } from '../types/ipc'

interface MessageStore {
  messagesByThread: Record<string, Message[]>
  fetch: (threadId: string) => Promise<void>
  appendEvent: (threadId: string, event: OutputEvent) => void
  appendUserMessage: (threadId: string, content: string) => void
  clear: (threadId: string) => void
}

export const useMessageStore = create<MessageStore>((set) => ({
  messagesByThread: {},

  fetch: async (threadId) => {
    const messages = await window.api.invoke('messages:list', threadId)
    set((s) => ({ messagesByThread: { ...s.messagesByThread, [threadId]: messages } }))
  },

  appendEvent: (threadId, event) => {
    if (event.type === 'status') return

    const role = event.type === 'error' ? 'system' : 'assistant'
    const msg: Message = {
      id: `stream-${Date.now()}-${Math.random()}`,
      thread_id: threadId,
      role,
      content: event.content,
      metadata: event.metadata ? JSON.stringify(event.metadata) : null,
      created_at: new Date().toISOString()
    }
    set((s) => ({
      messagesByThread: {
        ...s.messagesByThread,
        [threadId]: [...(s.messagesByThread[threadId] ?? []), msg]
      }
    }))
  },

  appendUserMessage: (threadId, content) => {
    const msg: Message = {
      id: `optimistic-${Date.now()}-${Math.random()}`,
      thread_id: threadId,
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

  clear: (threadId) =>
    set((s) => {
      const updated = { ...s.messagesByThread }
      delete updated[threadId]
      return { messagesByThread: updated }
    })
}))
