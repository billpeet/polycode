import { create } from 'zustand'

interface TerminalStore {
  /** Active terminal ID per thread (one terminal per thread at most) */
  terminalByThread: Record<string, string | null>
  /** Whether the terminal pane is visible for each thread */
  visibleByThread: Record<string, boolean>

  spawn: (threadId: string, cols: number, rows: number) => Promise<string>
  kill: (threadId: string) => Promise<void>
  setVisible: (threadId: string, visible: boolean) => void
  toggleVisible: (threadId: string) => void
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  terminalByThread: {},
  visibleByThread: {},

  spawn: async (threadId, cols, rows) => {
    const existing = get().terminalByThread[threadId]
    if (existing) {
      try { await window.api.invoke('terminal:kill', existing) } catch { /* ignore */ }
    }
    const terminalId = await window.api.invoke('terminal:spawn', threadId, cols, rows) as string
    set((s) => ({
      terminalByThread: { ...s.terminalByThread, [threadId]: terminalId },
      visibleByThread: { ...s.visibleByThread, [threadId]: true },
    }))
    return terminalId
  },

  kill: async (threadId) => {
    const terminalId = get().terminalByThread[threadId]
    if (!terminalId) return
    try { await window.api.invoke('terminal:kill', terminalId) } catch { /* ignore */ }
    set((s) => ({
      terminalByThread: { ...s.terminalByThread, [threadId]: null },
      visibleByThread: { ...s.visibleByThread, [threadId]: false },
    }))
  },

  setVisible: (threadId, visible) => {
    set((s) => ({
      visibleByThread: { ...s.visibleByThread, [threadId]: visible },
    }))
  },

  toggleVisible: (threadId) => {
    const current = get().visibleByThread[threadId] ?? false
    set((s) => ({
      visibleByThread: { ...s.visibleByThread, [threadId]: !current },
    }))
  },
}))
