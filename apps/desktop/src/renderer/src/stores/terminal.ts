import { create } from 'zustand'
import { useUiStore } from './ui'

interface TerminalStore {
  /** Active terminal ID per location (one terminal per location at most) */
  terminalByLocation: Record<string, string | null>
  /** Whether the terminal pane is visible for each location */
  visibleByLocation: Record<string, boolean>
  /** Last used pane width per location */
  widthByLocation: Record<string, number>

  ensure: (threadId: string, locationId: string, cols: number, rows: number) => Promise<string>
  kill: (locationId: string) => Promise<void>
  setVisible: (locationId: string, visible: boolean) => void
  toggleVisible: (locationId: string) => void
  setWidth: (locationId: string, width: number) => void
  clearLocation: (locationId: string) => void
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  terminalByLocation: {},
  visibleByLocation: {},
  widthByLocation: {},

  ensure: async (threadId, locationId, cols, rows) => {
    const existing = get().terminalByLocation[locationId]
    if (existing) {
      window.api.send('terminal:resize', existing, cols, rows)
      set((s) => ({
        visibleByLocation: { ...s.visibleByLocation, [locationId]: true },
      }))
      useUiStore.getState().setLocationAuxTab(locationId, 'terminal')
      return existing
    }

    const terminalId = await window.api.invoke('terminal:spawn', threadId, cols, rows) as string
    set((s) => ({
      terminalByLocation: { ...s.terminalByLocation, [locationId]: terminalId },
      visibleByLocation: { ...s.visibleByLocation, [locationId]: true },
    }))
    useUiStore.getState().setLocationAuxTab(locationId, 'terminal')
    return terminalId
  },

  kill: async (locationId) => {
    const terminalId = get().terminalByLocation[locationId]
    if (terminalId) {
      try { await window.api.invoke('terminal:kill', terminalId) } catch { /* ignore */ }
    }
    set((s) => ({
      terminalByLocation: { ...s.terminalByLocation, [locationId]: null },
      visibleByLocation: { ...s.visibleByLocation, [locationId]: false },
    }))
  },

  setVisible: (locationId, visible) => {
    set((s) => ({
      visibleByLocation: { ...s.visibleByLocation, [locationId]: visible },
    }))
    if (visible) {
      useUiStore.getState().setLocationAuxTab(locationId, 'terminal')
    }
  },

  toggleVisible: (locationId) => {
    const current = get().visibleByLocation[locationId] ?? false
    get().setVisible(locationId, !current)
  },

  setWidth: (locationId, width) => {
    set((s) => ({
      widthByLocation: { ...s.widthByLocation, [locationId]: width },
    }))
  },

  clearLocation: (locationId) => {
    set((s) => {
      const terminalByLocation = { ...s.terminalByLocation }
      const visibleByLocation = { ...s.visibleByLocation }
      const widthByLocation = { ...s.widthByLocation }
      delete terminalByLocation[locationId]
      delete visibleByLocation[locationId]
      delete widthByLocation[locationId]
      return { terminalByLocation, visibleByLocation, widthByLocation }
    })
  },
}))
