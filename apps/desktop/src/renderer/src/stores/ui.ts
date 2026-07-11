import { create } from 'zustand'

export type RightPanelTab = 'tasks' | 'files' | 'commands'
export type LocationAuxTab = 'diff' | 'file' | 'command' | 'terminal' | null

interface UiStore {
  todoPanelOpenByThread: Record<string, boolean>
  setTodoPanelOpen: (threadId: string, open: boolean) => void
  isTodoPanelOpen: (threadId: string) => boolean
  toggleTodoPanel: (threadId: string) => void

  // Right panel tab state
  rightPanelTab: RightPanelTab
  setRightPanelTab: (tab: RightPanelTab) => void

  locationAuxTabByLocation: Record<string, Exclude<LocationAuxTab, null>>
  locationAuxTabRequestByLocation: Record<string, number>
  setLocationAuxTab: (locationId: string, tab: Exclude<LocationAuxTab, null>) => void
  clearLocationAuxTab: (locationId: string) => void
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

  // Right panel tab
  rightPanelTab: 'tasks',
  setRightPanelTab: (tab) => set({ rightPanelTab: tab }),

  locationAuxTabByLocation: {},
  locationAuxTabRequestByLocation: {},
  setLocationAuxTab: (locationId, tab) =>
    set((s) => ({
      locationAuxTabByLocation: { ...s.locationAuxTabByLocation, [locationId]: tab },
      locationAuxTabRequestByLocation: {
        ...s.locationAuxTabRequestByLocation,
        [locationId]: (s.locationAuxTabRequestByLocation[locationId] ?? 0) + 1,
      },
    })),
  clearLocationAuxTab: (locationId) =>
    set((s) => {
      const next = { ...s.locationAuxTabByLocation }
      const nextRequests = { ...s.locationAuxTabRequestByLocation }
      delete next[locationId]
      delete nextRequests[locationId]
      return { locationAuxTabByLocation: next, locationAuxTabRequestByLocation: nextRequests }
    }),
}))
