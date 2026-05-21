import { create } from 'zustand'
import { Message } from '../types/ipc'

export interface Todo {
  id?: string
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

function taskCreateToTodo(input: Record<string, unknown>, fallbackId: string): Todo {
  return {
    id: typeof input.taskId === 'string' ? input.taskId : typeof input.id === 'string' ? input.id : fallbackId,
    content: typeof input.subject === 'string' ? input.subject : '',
    activeForm: typeof input.activeForm === 'string' ? input.activeForm : '',
    status: 'pending',
  }
}

function updateTask(todos: Todo[], taskId: string, status: Todo['status']): Todo[] {
  const index = todos.findIndex((todo, idx) => todo.id === taskId || (!todo.id && String(idx + 1) === taskId))
  if (index === -1) return todos
  return todos.map((todo, idx) => (idx === index ? { ...todo, status } : todo))
}

/** Extract the latest TodoWrite/todo_list/TaskCreate+TaskUpdate tasks from persisted messages. */
export function extractTodosFromMessages(messages: Message[]): Todo[] | null {
  let todos: Todo[] | null = null

  for (const msg of messages) {
    if (!msg.metadata) continue
    try {
      const meta = JSON.parse(msg.metadata) as Record<string, unknown>

      // Claude Code: TodoWrite tool_call with input.todos replaces the whole list.
      if (meta.type === 'tool_call' && meta.name === 'TodoWrite') {
        const input = meta.input as { todos?: Todo[] } | undefined
        if (Array.isArray(input?.todos)) {
          todos = input.todos as Todo[]
        }
      }

      // Claude Code tasks: TaskCreate appends one task, TaskUpdate updates one task by id.
      if (meta.type === 'tool_call' && meta.name === 'TaskCreate') {
        const input = (meta.input as Record<string, unknown> | undefined) ?? {}
        todos = [...(todos ?? []), taskCreateToTodo(input, String((todos?.length ?? 0) + 1))]
      }
      if (meta.type === 'tool_call' && meta.name === 'TaskUpdate') {
        const input = (meta.input as Record<string, unknown> | undefined) ?? {}
        const taskId = typeof input.taskId === 'string' ? input.taskId : undefined
        const status = input.status as Todo['status'] | undefined
        if (todos && taskId && (status === 'pending' || status === 'in_progress' || status === 'completed')) {
          todos = updateTask(todos, taskId, status)
        }
      }

      // Codex: tool_call or tool_result with items[] replaces the whole list.
      if (meta.type === 'tool_call' || meta.type === 'tool_result') {
        const items = meta.items as { text: string; completed: boolean }[] | undefined
        if (Array.isArray(items) && items.length > 0 && typeof items[0].text === 'string') {
          todos = items.map(codexItemToTodo)
        }
      }
    } catch {
      // skip unparseable metadata
    }
  }

  return todos
}

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
      todosByThread: { ...s.todosByThread, [threadId]: updateTask(s.todosByThread[threadId] ?? [], taskId, status) },
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
