import { create } from 'zustand'
import type { BrowserSessionConfig } from '../types/ipc'
import { useUiStore } from './ui'
import { useToastStore } from './toast'

export interface BrowserTab {
  id: string
  /** null until the first navigation — a new-tab page with no guest process. */
  url: string | null
  title: string
  faviconUrl: string | null
  loading: boolean
  error: string | null
  canGoBack: boolean
  canGoForward: boolean
}

interface BrowserStore {
  /** Open tabs per location; the panel renders one strip per location. */
  tabsByLocation: Record<string, BrowserTab[]>
  activeByLocation: Record<string, string | null>
  visibleByLocation: Record<string, boolean>
  /** Session partition + proxy info, prepared in main on first open. */
  sessionByLocation: Record<string, BrowserSessionConfig>

  open: (locationId: string, url?: string) => Promise<void>
  toggleVisible: (locationId: string) => void
  closePanel: (locationId: string) => void
  newTab: (locationId: string, url?: string | null) => Promise<void>
  closeTab: (locationId: string, tabId: string) => Promise<void>
  activateTab: (locationId: string, tabId: string) => void
  updateTab: (locationId: string, tabId: string, patch: Partial<BrowserTab>) => void
  discardLocation: (locationId: string) => void
}

let tabCounter = 0

function makeTab(url: string | null): BrowserTab {
  tabCounter += 1
  return {
    id: `btab-${Date.now()}-${tabCounter}`,
    url,
    title: url ?? 'New Tab',
    faviconUrl: null,
    loading: false,
    error: null,
    canGoBack: false,
    canGoForward: false,
  }
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

export const useBrowserStore = create<BrowserStore>((set, get) => ({
  tabsByLocation: {},
  activeByLocation: {},
  visibleByLocation: {},
  sessionByLocation: {},

  /** Show the panel; reuse a tab already at `url`, else open a new one. */
  open: async (locationId, url) => {
    const state = get()
    let session = state.sessionByLocation[locationId]
    if (!session) {
      const result = await window.api.invoke('browser:prepareSession', locationId)
      if (!result.ok) {
        get().discardLocation(locationId)
        useToastStore.getState().add({ type: 'info', message: 'That project location no longer exists.' })
        return
      }
      session = result.session
      set((s) => ({ sessionByLocation: { ...s.sessionByLocation, [locationId]: session! } }))
    }

    const tabs = state.tabsByLocation[locationId] ?? []
    if (!url) {
      // Bare open: guarantee at least one tab to show.
      if (tabs.length === 0) {
        await get().newTab(locationId, null)
      } else {
        set((s) => ({ visibleByLocation: { ...s.visibleByLocation, [locationId]: true } }))
        useUiStore.getState().setLocationAuxTab(locationId, 'browser')
      }
      return
    }

    const existing = tabs.find((tab) => tab.url === url)
    if (existing) {
      set((s) => ({
        visibleByLocation: { ...s.visibleByLocation, [locationId]: true },
        activeByLocation: { ...s.activeByLocation, [locationId]: existing.id },
      }))
      useUiStore.getState().setLocationAuxTab(locationId, 'browser')
      return
    }

    await get().newTab(locationId, url)
  },

  toggleVisible: (locationId) => {
    const visible = get().visibleByLocation[locationId] ?? false
    if (visible) {
      get().closePanel(locationId)
    } else {
      void get().open(locationId)
    }
  },

  /** Hide the panel and drop the guest pages; the partition's storage persists. */
  closePanel: (locationId) => {
    set((s) => ({ visibleByLocation: { ...s.visibleByLocation, [locationId]: false } }))
    void window.api.invoke('browser:releaseSession', locationId).catch(() => { /* ignore */ })
  },

  newTab: async (locationId, url = null) => {
    const state = get()
    let session = state.sessionByLocation[locationId]
    if (!session) {
      const result = await window.api.invoke('browser:prepareSession', locationId)
      if (!result.ok) {
        get().discardLocation(locationId)
        useToastStore.getState().add({ type: 'info', message: 'That project location no longer exists.' })
        return
      }
      session = result.session
      set((s) => ({ sessionByLocation: { ...s.sessionByLocation, [locationId]: session! } }))
    }

    const tab = makeTab(url)
    set((s) => ({
      tabsByLocation: { ...s.tabsByLocation, [locationId]: [...(s.tabsByLocation[locationId] ?? []), tab] },
      activeByLocation: { ...s.activeByLocation, [locationId]: tab.id },
      visibleByLocation: { ...s.visibleByLocation, [locationId]: true },
    }))
    useUiStore.getState().setLocationAuxTab(locationId, 'browser')
  },

  closeTab: async (locationId, tabId) => {
    const tabs = get().tabsByLocation[locationId] ?? []
    const index = tabs.findIndex((tab) => tab.id === tabId)
    if (index === -1) return

    const remaining = tabs.filter((tab) => tab.id !== tabId)
    const active = get().activeByLocation[locationId]
    const nextActive =
      active !== tabId
        ? active
        : remaining[Math.min(index, remaining.length - 1)]?.id ?? null

    set((s) => ({
      tabsByLocation: { ...s.tabsByLocation, [locationId]: remaining },
      activeByLocation: { ...s.activeByLocation, [locationId]: nextActive },
      visibleByLocation: {
        ...s.visibleByLocation,
        // Last tab closed: the panel has nothing to show and the guest
        // session (and any SSH tunnel beneath it) can go away.
        [locationId]: remaining.length > 0 && (s.visibleByLocation[locationId] ?? false),
      },
    }))

    if (remaining.length === 0) {
      void window.api.invoke('browser:releaseSession', locationId).catch(() => { /* ignore */ })
    }
  },

  activateTab: (locationId, tabId) => {
    set((s) => ({ activeByLocation: { ...s.activeByLocation, [locationId]: tabId } }))
  },

  updateTab: (locationId, tabId, patch) => {
    set((s) => {
      const tabs = s.tabsByLocation[locationId]
      if (!tabs) return s
      const index = tabs.findIndex((tab) => tab.id === tabId)
      if (index === -1) return s
      const next = tabs.slice()
      next[index] = { ...next[index], ...patch }
      return { tabsByLocation: { ...s.tabsByLocation, [locationId]: next } }
    })
  },

  discardLocation: (locationId) => {
    set((s) => ({
      tabsByLocation: withoutKey(s.tabsByLocation, locationId),
      activeByLocation: withoutKey(s.activeByLocation, locationId),
      visibleByLocation: withoutKey(s.visibleByLocation, locationId),
      sessionByLocation: withoutKey(s.sessionByLocation, locationId),
    }))
    useUiStore.getState().clearLocationAuxTab(locationId)
    void window.api.invoke('browser:releaseSession', locationId).catch(() => { /* ignore */ })
  },
}))
