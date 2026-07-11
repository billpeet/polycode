import { create } from 'zustand'
import {
  extractTodosFromMessages,
  taskCreateToTodo,
  updateTaskStatus,
  type Message,
  type OutputEvent,
  type Todo,
} from '@polycode/shared'

interface TodosState {
  todosByThread: Record<string, Todo[]>

  /** Intercept a live tool_call/tool_result event and update the todo list. */
  applyEvent: (threadId: string, event: OutputEvent) => void
  /** Re-extract todos from persisted messages (initial load / catch-up). */
  syncFromMessages: (threadId: string, messages: Message[]) => void
  clear: (threadId: string) => void
}

export const useTodosStore = create<TodosState>((set) => ({
  todosByThread: {},

  applyEvent: (threadId, event) => {
    const meta = event.metadata
    if (!meta) return
    // Only main-scope activity drives the thread's todo panel (mirrors desktop).
    if (meta.agent_scope === 'subagent' || meta.agent_task_id || meta.agent_parent_tool_use_id) return

    set((s) => {
      const current = s.todosByThread[threadId] ?? []

      if (meta.type === 'tool_call' && meta.name === 'TodoWrite') {
        const input = meta.input as { todos?: Todo[] } | undefined
        if (Array.isArray(input?.todos)) {
          return { todosByThread: { ...s.todosByThread, [threadId]: input.todos } }
        }
        return s
      }

      if (meta.type === 'tool_call' && meta.name === 'TaskCreate') {
        const input = (meta.input as Record<string, unknown> | undefined) ?? {}
        return {
          todosByThread: {
            ...s.todosByThread,
            [threadId]: [...current, taskCreateToTodo(input, String(current.length + 1))],
          },
        }
      }

      if (meta.type === 'tool_call' && meta.name === 'TaskUpdate') {
        const input = (meta.input as Record<string, unknown> | undefined) ?? {}
        const taskId = typeof input.taskId === 'string' ? input.taskId : undefined
        const status = input.status as Todo['status'] | undefined
        if (taskId && (status === 'pending' || status === 'in_progress' || status === 'completed')) {
          return {
            todosByThread: { ...s.todosByThread, [threadId]: updateTaskStatus(current, taskId, status) },
          }
        }
        return s
      }

      // Codex: tool_call or tool_result carrying items[] replaces the list.
      if (meta.type === 'tool_call' || meta.type === 'tool_result') {
        const items = meta.items as { text: string; completed: boolean }[] | undefined
        if (Array.isArray(items) && items.length > 0 && typeof items[0]?.text === 'string') {
          return {
            todosByThread: {
              ...s.todosByThread,
              [threadId]: items.map((item) => ({
                content: item.text,
                activeForm: '',
                status: item.completed ? ('completed' as const) : ('pending' as const),
              })),
            },
          }
        }
      }

      return s
    })
  },

  syncFromMessages: (threadId, messages) => {
    const todos = extractTodosFromMessages(messages)
    set((s) => {
      if (todos) return { todosByThread: { ...s.todosByThread, [threadId]: todos } }
      const updated = { ...s.todosByThread }
      delete updated[threadId]
      return { todosByThread: updated }
    })
  },

  clear: (threadId) =>
    set((s) => {
      const updated = { ...s.todosByThread }
      delete updated[threadId]
      return { todosByThread: updated }
    }),
}))
