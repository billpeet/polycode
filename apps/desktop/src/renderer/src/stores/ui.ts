import { create } from 'zustand'

export type RightPanelTab = 'tasks' | 'files' | 'commands'
export type LocationAuxTab = 'diff' | 'file' | 'command' | 'terminal' | null
/** Sidebar presentation: per-project tree, or the cross-project attention Queue. */
export type SidebarViewMode = 'tree' | 'queue'

const SIDEBAR_VIEW_MODE_SETTING_KEY = 'sidebar:viewMode'
const SIDEBAR_WIDTH_SETTING_KEY = 'sidebar:width'

export const SIDEBAR_DEFAULT_WIDTH = 240
const SIDEBAR_MIN_WIDTH = 180
const SIDEBAR_MAX_WIDTH = 480

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)))
}

interface UiStore {
  /** Persisted global preference; tree is the default. */
  sidebarViewMode: SidebarViewMode
  loadSidebarViewMode: () => Promise<void>
  setSidebarViewMode: (mode: SidebarViewMode) => void

  /** Expanded sidebar width in px; persisted. Drag updates state only — persist on release. */
  sidebarWidth: number
  /** True while the resize handle is being dragged (disables the width transition). */
  sidebarResizing: boolean
  loadSidebarWidth: () => Promise<void>
  setSidebarWidth: (width: number) => void
  setSidebarResizing: (resizing: boolean) => void
  persistSidebarWidth: () => void

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
  sidebarViewMode: 'tree',

  loadSidebarViewMode: async () => {
    try {
      const raw = await window.api.invoke('settings:get', SIDEBAR_VIEW_MODE_SETTING_KEY)
      if (raw === 'tree' || raw === 'queue') {
        set({ sidebarViewMode: raw })
      }
    } catch (err) {
      console.error('Failed to load sidebar view mode', err)
    }
  },

  setSidebarViewMode: (mode) => {
    set({ sidebarViewMode: mode })
    void window.api.invoke('settings:set', SIDEBAR_VIEW_MODE_SETTING_KEY, mode)
  },

  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  sidebarResizing: false,

  loadSidebarWidth: async () => {
    try {
      const raw = await window.api.invoke('settings:get', SIDEBAR_WIDTH_SETTING_KEY)
      const width = Number(raw)
      if (raw !== null && Number.isFinite(width)) {
        set({ sidebarWidth: clampSidebarWidth(width) })
      }
    } catch (err) {
      console.error('Failed to load sidebar width', err)
    }
  },

  setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),

  setSidebarResizing: (resizing) => set({ sidebarResizing: resizing }),

  persistSidebarWidth: () => {
    void window.api.invoke('settings:set', SIDEBAR_WIDTH_SETTING_KEY, String(get().sidebarWidth))
  },

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
