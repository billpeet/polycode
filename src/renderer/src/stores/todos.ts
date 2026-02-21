import { create } from 'zustand'

export interface Todo {
  content: string
  activeForm: string
  status: 'pending' | 'in_progress' | 'completed'
}

interface TodoStore {
  todosByThread: Record<string, Todo[]>
  setTodos: (threadId: string, todos: Todo[]) => void
  clearTodos: (threadId: string) => void
}

export const useTodoStore = create<TodoStore>((set) => ({
  todosByThread: {},

  setTodos: (threadId, todos) =>
    set((s) => ({
      todosByThread: { ...s.todosByThread, [threadId]: todos },
    })),

  clearTodos: (threadId) =>
    set((s) => {
      const updated = { ...s.todosByThread }
      delete updated[threadId]
      return { todosByThread: updated }
    }),
}))
