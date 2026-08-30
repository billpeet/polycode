import { create } from 'zustand'

export type RightPanelTab = 'tasks' | 'files' | 'commands'
export type LocationAuxTab = 'diff' | 'file' | 'command' | 'terminal' | 'browser' | null
/** Sidebar presentation: per-project tree, or the cross-project attention Queue. */
export type SidebarViewMode = 'tree' | 'queue'
/**
 * Workspace presentation. `split` is the classic two-pane view (chat left,
 * tabbed aux panel right). `full` collapses to a single full-width tabbed
 * surface where the chat is just another tab, so a command log or terminal can
 * take the whole window.
 */
export type LayoutMode = 'split' | 'full'

const SIDEBAR_VIEW_MODE_SETTING_KEY = 'sidebar:viewMode'
const SIDEBAR_WIDTH_SETTING_KEY = 'sidebar:width'
const LAYOUT_MODE_SETTING_KEY = 'layout:mode'

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

  /** Persisted global preference; split is the default. */
  layoutMode: LayoutMode
  loadLayoutMode: () => Promise<void>
  setLayoutMode: (mode: LayoutMode) => void
  toggleLayoutMode: () => void

  /**
   * Whether the Chat tab is the active tab, per thread. Only meaningful in
   * `full` layout. View state, not a preference — deliberately not persisted.
   * Keyed per thread so switching threads never strands you on a tab that
   * thread has no content for.
   */
  chatTabActiveByThread: Record<string, boolean>
  isChatTabActive: (threadId: string) => boolean
  setChatTabActive: (threadId: string, active: boolean) => void

  /**
   * The non-chat aux tab SecondPanel is showing, per thread. Mirrored here (not
   * kept purely local to SecondPanel) so the Ctrl+Tab handler can read where the
   * cycle currently sits. SecondPanel remains the component that decides whether
   * the tab is still available.
   */
  activeAuxTabByThread: Record<string, string>
  setActiveAuxTab: (threadId: string, tab: string) => void

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

  layoutMode: 'split',

  loadLayoutMode: async () => {
    try {
      const raw = await window.api.invoke('settings:get', LAYOUT_MODE_SETTING_KEY)
      if (raw === 'split' || raw === 'full') {
        set({ layoutMode: raw })
      }
    } catch (err) {
      console.error('Failed to load layout mode', err)
    }
  },

  setLayoutMode: (mode) => {
    set({ layoutMode: mode })
    void window.api.invoke('settings:set', LAYOUT_MODE_SETTING_KEY, mode)
  },

  toggleLayoutMode: () => {
    get().setLayoutMode(get().layoutMode === 'split' ? 'full' : 'split')
  },

  chatTabActiveByThread: {},

  // Chat leads the tab bar in full mode, so it is the default active tab.
  isChatTabActive: (threadId) => get().chatTabActiveByThread[threadId] ?? true,

  setChatTabActive: (threadId, active) =>
    set((s) => ({
      chatTabActiveByThread: { ...s.chatTabActiveByThread, [threadId]: active },
    })),

  activeAuxTabByThread: {},

  setActiveAuxTab: (threadId, tab) =>
    set((s) => ({
      activeAuxTabByThread: { ...s.activeAuxTabByThread, [threadId]: tab },
    })),

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
