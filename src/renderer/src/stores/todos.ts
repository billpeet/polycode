import { create } from 'zustand'
import { Message } from '../types/ipc'

export interface Todo {
  content: string
  activeForm: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** Normalize a Codex todo_list item to the common Todo shape. */
function codexItemToTodo(item: { text: string; completed: boolean }): Todo {
  return {
    content: item.text,
    activeForm: '',
    status: item.completed ? 'completed' : 'pending',
  }
}

/** Extract the latest TodoWrite/todo_list todos from a list of persisted messages. */
export function extractTodosFromMessages(messages: Message[]): Todo[] | null {
  // Walk backwards to find the most recent TodoWrite or todo_list tool_call
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg.metadata) continue
    try {
      const meta = JSON.parse(msg.metadata) as Record<string, unknown>
      // Claude Code: TodoWrite tool_call with input.todos
      if (meta.type === 'tool_call' && meta.name === 'TodoWrite') {
        const input = meta.input as { todos?: Todo[] } | undefined
        if (Array.isArray(input?.todos)) {
          return input.todos as Todo[]
        }
      }

      // Codex: tool_call or tool_result with items[] — msg.content is 'todo_list' for tool_call
      if (meta.type === 'tool_call' || meta.type === 'tool_result') {
        const items = meta.items as { text: string; completed: boolean }[] | undefined
        if (Array.isArray(items) && items.length > 0 && typeof items[0].text === 'string') {
          return items.map(codexItemToTodo)
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
    set((s) => {
      if (todos) {
        return {
          todosByThread: { ...s.todosByThread, [threadId]: todos },
        }
      }

      const updated = { ...s.todosByThread }
      delete updated[threadId]
      return { todosByThread: updated }
    })
  },

  clearTodos: (threadId) =>
    set((s) => {
      const updated = { ...s.todosByThread }
      delete updated[threadId]
      return { todosByThread: updated }
    }),
}))
