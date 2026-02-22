import { create } from 'zustand'
import { Message } from '../types/ipc'

export interface Todo {
  content: string
  activeForm: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** Extract the latest TodoWrite todos from a list of persisted messages. */
export function extractTodosFromMessages(messages: Message[]): Todo[] | null {
  // Walk backwards to find the most recent TodoWrite tool_call
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg.metadata) continue
    try {
      const meta = JSON.parse(msg.metadata) as Record<string, unknown>
      if (meta.type === 'tool_call' && meta.name === 'TodoWrite') {
        const input = meta.input as { todos?: Todo[] } | undefined
        if (Array.isArray(input?.todos)) {
          return input.todos as Todo[]
        }
      }
    } catch {
      // skip unparseable metadata
    }
  }
  return null
}

interface TodoStore {
  todosByThread: Record<string, Todo[]>
  setTodos: (threadId: string, todos: Todo[]) => void
  syncFromMessages: (threadId: string, messages: Message[]) => void
  clearTodos: (threadId: string) => void
}

export const useTodoStore = create<TodoStore>((set) => ({
  todosByThread: {},

  setTodos: (threadId, todos) =>
    set((s) => ({
      todosByThread: { ...s.todosByThread, [threadId]: todos },
    })),

  /** Re-extract todos from persisted messages (recovery / catch-up). */
  syncFromMessages: (threadId, messages) => {
    const todos = extractTodosFromMessages(messages)
    if (todos) {
      set((s) => ({
        todosByThread: { ...s.todosByThread, [threadId]: todos },
      }))
    }
  },

  clearTodos: (threadId) =>
    set((s) => {
      const updated = { ...s.todosByThread }
      delete updated[threadId]
      return { todosByThread: updated }
    }),
}))
