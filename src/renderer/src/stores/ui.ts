import { create } from 'zustand'

interface UiStore {
  todoPanelOpenByThread: Record<string, boolean>
  setTodoPanelOpen: (threadId: string, open: boolean) => void
  isTodoPanelOpen: (threadId: string) => boolean
  toggleTodoPanel: (threadId: string) => void
}

export const useUiStore = create<UiStore>((set, get) => ({
  todoPanelOpenByThread: {},

  setTodoPanelOpen: (threadId, open) =>
    set((s) => ({
      todoPanelOpenByThread: { ...s.todoPanelOpenByThread, [threadId]: open },
    })),

  isTodoPanelOpen: (threadId) => get().todoPanelOpenByThread[threadId] ?? true,

  toggleTodoPanel: (threadId) => {
    const current = get().todoPanelOpenByThread[threadId] ?? true
    set((s) => ({
      todoPanelOpenByThread: { ...s.todoPanelOpenByThread, [threadId]: !current },
    }))
  },
}))
