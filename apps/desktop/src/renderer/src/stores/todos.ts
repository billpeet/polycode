import { create } from 'zustand'
import { Todo, taskCreateToTodo, updateTaskStatus, extractTodosFromMessages } from '@polycode/shared'
import { Message } from '../types/ipc'

// Re-export so existing consumers (ThreadView, TodoPanel, TasksSection) keep working.
export type { Todo }
export { extractTodosFromMessages }

interface TodoStore {
  todosByThread: Record<string, Todo[]>
  setTodos: (threadId: string, todos: Todo[]) => void
  addTask: (threadId: string, input: Record<string, unknown>) => void
  updateTask: (threadId: string, taskId: string, status: Todo['status']) => void
  syncFromMessages: (threadId: string, messages: Message[]) => void
  clearTodos: (threadId: string) => void
}

export const useTodoStore = create<TodoStore>((set) => ({
  todosByThread: {},

  setTodos: (threadId, todos) =>
    set((s) => ({
      todosByThread: { ...s.todosByThread, [threadId]: todos },
    })),

  addTask: (threadId, input) =>
    set((s) => {
      const current = s.todosByThread[threadId] ?? []
      return {
        todosByThread: { ...s.todosByThread, [threadId]: [...current, taskCreateToTodo(input, String(current.length + 1))] },
      }
    }),

  updateTask: (threadId, taskId, status) =>
    set((s) => ({
      todosByThread: { ...s.todosByThread, [threadId]: updateTaskStatus(s.todosByThread[threadId] ?? [], taskId, status) },
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
