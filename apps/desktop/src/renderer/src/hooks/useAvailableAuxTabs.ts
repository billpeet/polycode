import { useFilesStore } from '../stores/files'
import { useTerminalStore } from '../stores/terminal'
import { useBrowserStore, type BrowserTab } from '../stores/browser'
import { useCommandStore } from '../stores/commands'
import { useThreadStore } from '../stores/threads'
import { usePlanStore } from '../stores/plans'
import { useUiStore } from '../stores/ui'
import type { LocationAuxTab } from '../stores/ui'

/**
 * A pane in the auxiliary panel. `chat` only appears in `full` layout, where
 * the transcript becomes a tab alongside the others.
 */
export type AuxTab = 'chat' | 'diff' | 'file' | 'terminal' | 'commands' | 'plan' | 'browser'

export const AUX_TAB_LABELS: Record<AuxTab, string> = {
  chat: 'Chat',
  plan: 'Plan',
  diff: 'Git Diff',
  file: 'File Preview',
  terminal: 'Terminal',
  commands: 'Command Logs',
  browser: 'Browser',
}

// Stable reference for absent browser tabs: an inline `[]` in a selector
// allocates a fresh array per getSnapshot call, which useSyncExternalStore
// reads as "the store changed" — an infinite re-render loop.
const EMPTY_BROWSER_TABS: BrowserTab[] = []

/** Bridges the store's tab vocabulary to the panel's. */
export function toPanelTab(tab: LocationAuxTab): AuxTab | null {
  if (tab === 'command') return 'commands'
  return tab
}

export interface AvailableAuxTabs {
  /** Tabs with content right now, in display order. Includes `chat` in full layout. */
  tabs: AuxTab[]
  /** Location owning the aux panes, or null when the thread has no location. */
  locationId: string | null
  /** Per-pane availability, so callers can guard their bodies. */
  has: Record<Exclude<AuxTab, 'chat'>, boolean>
  /** The tab a store last asked to be shown, and a counter that bumps per request. */
  requestedTab: AuxTab | null
  requestedTabVersion: number
}

/**
 * Derives which aux panes currently have content. Tabs are not stored — each
 * one exists exactly as long as its underlying store has something to show.
 *
 * Shared by SecondPanel (which renders them) and the Ctrl+Tab handler in App
 * (which cycles them), so the two can never disagree about what is open.
 */
export function useAvailableAuxTabs(threadId: string): AvailableAuxTabs {
  const layoutMode = useUiStore((s) => s.layoutMode)

  const locationId = useThreadStore((s) => {
    if (!s.selectedThreadId) return null
    for (const threads of Object.values(s.byProject)) {
      const t = threads.find((t) => t.id === s.selectedThreadId)
      if (t) return t.location_id ?? null
    }
    return null
  })

  const selectedFilePath = useFilesStore((s) => locationId ? (s.selectedFilePathByLocation[locationId] ?? null) : s.selectedFilePath)
  const diffView = useFilesStore((s) => locationId ? (s.diffViewByLocation[locationId] ?? null) : s.diffView)
  const loadingDiff = useFilesStore((s) => locationId ? (s.loadingDiffByLocation[locationId] ?? false) : s.loadingDiff)

  const isTerminalOpen = useTerminalStore((s) =>
    locationId ? (s.visibleByLocation[locationId] ?? false) : false
  )

  const browserTabs = useBrowserStore((s) =>
    locationId ? (s.tabsByLocation[locationId] ?? EMPTY_BROWSER_TABS) : EMPTY_BROWSER_TABS
  )
  const isBrowserOpen = useBrowserStore((s) =>
    locationId ? (s.visibleByLocation[locationId] ?? false) : false
  )

  const selectedInstance = useCommandStore((s) =>
    locationId ? (s.selectedInstanceByLocation[locationId] ?? null) : null
  )
  const hasPinnedCommands = useCommandStore((s) =>
    locationId ? ((s.pinnedInstancesByLocation[locationId] ?? []).length > 0) : false
  )

  const planVisible = usePlanStore((s) => s.visibleByThread[threadId] ?? false)
  const hasPlan = usePlanStore((s) => !!s.planByThread[threadId])

  const requestedAuxTab = useUiStore((s) =>
    locationId ? (s.locationAuxTabByLocation[locationId] ?? null) : null
  )
  const requestedTabVersion = useUiStore((s) =>
    locationId ? (s.locationAuxTabRequestByLocation[locationId] ?? 0) : 0
  )

  const has = {
    diff: !!(diffView || loadingDiff),
    file: !!selectedFilePath,
    terminal: isTerminalOpen,
    commands: !!(selectedInstance || hasPinnedCommands),
    plan: planVisible && hasPlan,
    browser: isBrowserOpen && browserTabs.length > 0,
  }

  const tabs: AuxTab[] = []
  // Chat leads the bar so its position is stable as other panes come and go.
  if (layoutMode === 'full') tabs.push('chat')
  if (has.plan) tabs.push('plan')
  if (has.diff) tabs.push('diff')
  if (has.file) tabs.push('file')
  if (has.terminal) tabs.push('terminal')
  if (has.commands) tabs.push('commands')
  if (has.browser) tabs.push('browser')

  return {
    tabs,
    locationId,
    has,
    requestedTab: toPanelTab(requestedAuxTab),
    requestedTabVersion,
  }
}
