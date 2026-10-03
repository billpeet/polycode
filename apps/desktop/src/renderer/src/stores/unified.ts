import { create } from 'zustand'
import {
  LOCAL_SOURCE_ID,
  mergeUnifiedSources,
  replaceUnifiedSources,
  type ChannelArgs,
  type ChannelResult,
  type RemoteChannel,
  type UnifiedProject,
  type UnifiedSnapshot,
  type UnifiedSourceEvent,
} from '@polycode/shared'
import { client } from '../lib/client'
import { getPref, setPref } from '../lib/prefs'
import { playChime } from '../lib/chime'
import { useProjectStore } from './projects'
import { useThreadStore, type DraftDestinationOptions } from './threads'
import { useLocationStore } from './locations'
import { useToastStore } from './toast'
import type { QueueThread, RepoLocation, Thread, ThreadStatus } from '../types/ipc'
import { useUiStore } from './ui'

/**
 * State for the unified ("All") view: a merged, read-mostly picture of every source plus
 * the actions that work on any of them.
 *
 * Two routes reach a source. Simple mutations (archive, snooze, pool checkout, …) go
 * through `remote:invokeOnSource`, which leaves the active host alone, so you can tidy
 * another machine's threads without leaving the one you are on. Anything that needs the
 * workspace — opening a Thread, the composer, project and location dialogs — first
 * *activates* the source (switches the active host) and then uses the ordinary
 * single-source path.
 */

const SOURCE_PREF_KEY = 'sidebar:source'
/** How long to wait for `remote:active-changed` to reset the stores before selecting. */
const ACTIVE_CHANGE_WAIT_MS = 3_000
/** Live events cover status; the poll only catches structural changes nobody pushes. */
const POLL_INTERVAL_MS = 120_000
const SOURCE_REFRESH_DEBOUNCE_MS = 1_500
export const SECTION_PAGE_SIZE = 10

/** Key for anything scoped to one source: `${sourceId}:${id}`. */
export function sourceKey(sourceId: string, id: string): string {
  return `${sourceId}:${id}`
}

export type SectionKind = 'archived' | 'snoozed'

/** A Queue row from any source. `source_id`/`source_label` say whose it is. */
export interface UnifiedQueueThread extends QueueThread {
  source_id: string
  source_label: string
}

function queueActivity(thread: QueueThread): number {
  const time = new Date(thread.last_turn_completed_at ?? thread.updated_at).getTime()
  return Number.isNaN(time) ? 0 : time
}

function tagQueue(sourceId: string, label: string, rows: QueueThread[]): UnifiedQueueThread[] {
  return rows.map((row) => ({ ...row, source_id: sourceId, source_label: label }))
}

/**
 * Per-source cursors for the merged Snoozed/Archived pages. Each source is paged on its
 * own (it only knows its own offsets); a page is the union of every source's next rows,
 * newest activity first. Reset whenever a section restarts at offset 0.
 */
const collapsedCursors = new Map<string, { cursors: Record<string, number>; exhausted: Set<string> }>()

/**
 * Snoozed/Archived loader for the unified Queue: same contract as the single-source one,
 * fanned out across every reachable source. Module-level so its identity is stable.
 */
export async function loadUnifiedCollapsed(
  variant: SectionKind,
  search: string | null,
  offset: number,
  limit: number,
): Promise<{ rows: QueueThread[]; hasMore: boolean }> {
  const state = useUnifiedStore.getState()
  const sources = (state.snapshot?.sources ?? []).filter((source) => source.status === 'ok')
  const cursorKey = `${variant}:${search ?? ''}`
  let entry = collapsedCursors.get(cursorKey)
  if (offset === 0 || !entry) {
    entry = { cursors: {}, exhausted: new Set() }
    collapsedCursors.set(cursorKey, entry)
  }
  const channel = variant === 'snoozed' ? 'threads:listQueueSnoozed' : 'threads:listQueueArchived'
  const pages = await Promise.all(sources
    .filter((source) => !entry.exhausted.has(source.sourceId))
    .map(async (source) => {
      const from = entry.cursors[source.sourceId] ?? 0
      const rows = await state.invokeOn(source.sourceId, channel, search, limit, from).catch(() => [] as QueueThread[])
      entry.cursors[source.sourceId] = from + rows.length
      if (rows.length < limit) entry.exhausted.add(source.sourceId)
      return tagQueue(source.sourceId, source.label, rows)
    }))
  const rows = pages.flat().sort((a, b) => queueActivity(b) - queueActivity(a))
  return { rows, hasMore: sources.some((source) => !entry.exhausted.has(source.sourceId)) }
}

export interface SectionState {
  open: boolean
  page: number
  threads: Thread[]
}

interface UnifiedStore {
  /** True while "All" is selected in the title-bar source switcher. */
  enabled: boolean
  snapshot: UnifiedSnapshot | null
  projects: UnifiedProject[]
  loading: boolean
  /** The source the rest of the app is currently talking to (`local` or a host id). */
  activeSourceId: string
  /** Sources whose event stream is currently down (live status may be stale). */
  disconnected: Record<string, boolean>
  /** Live overrides from the event watch, keyed by `sourceKey(source, threadId)`. */
  liveStatus: Record<string, ThreadStatus>
  liveUnread: Record<string, boolean>
  liveTitle: Record<string, string>
  /** Keyed by UnifiedProject.key. */
  expandedProjects: Record<string, boolean>
  /** Keyed by `sourceKey(source, locationId)`. */
  collapsedLocations: Record<string, boolean>
  /** Keyed by `sourceKey(source, poolId)`. */
  expandedPools: Record<string, boolean>
  /** Keyed by `${kind}:${sourceKey(source, projectId)}`. */
  sections: Record<string, SectionState | undefined>
  /** Keyed by `sourceKey(source, locationId)`. */
  branchByLocation: Record<string, string>
  pathExistsByLocation: Record<string, boolean>
  archivedProjectsOpen: boolean
  /** Each source's Queue, tagged with its source. Loaded only while the Queue is shown. */
  queueBySource: Record<string, UnifiedQueueThread[]>
  queueLoading: boolean

  load: () => Promise<void>
  refreshQueue: (sourceIds?: string[]) => Promise<void>
  setEnabled: (enabled: boolean) => void
  refresh: (sourceIds?: string[]) => Promise<void>
  scheduleRefresh: (sourceId: string) => void
  invokeOn: <C extends RemoteChannel>(sourceId: string, channel: C, ...args: ChannelArgs<C>) => Promise<ChannelResult<C>>
  /** Point the app at `sourceId` (switching host if needed) and load `projectId` into the stores. */
  activateSource: (sourceId: string, projectId?: string) => Promise<void>
  openThread: (sourceId: string, projectId: string, threadId: string) => Promise<void>
  /**
   * Re-point the create-on-send draft at a Location on any source. Another source means
   * switching host, which resets the per-host stores, so the typed text is carried across.
   */
  setDraftDestination: (sourceId: string, projectId: string, locationId: string, opts?: DraftDestinationOptions) => Promise<void>
  toggleProject: (key: string, expanded: boolean) => void
  toggleLocation: (sourceId: string, locationId: string) => void
  togglePool: (sourceId: string, poolId: string) => void
  toggleSection: (kind: SectionKind, sourceId: string, projectId: string) => Promise<void>
  setSectionPage: (kind: SectionKind, sourceId: string, projectId: string, page: number) => Promise<void>
  loadLocationFacts: (sourceId: string, locations: RepoLocation[]) => void
  setArchivedProjectsOpen: (open: boolean) => void
  handleEvent: (event: UnifiedSourceEvent) => void
}

export function sectionKey(kind: SectionKind, sourceId: string, projectId: string): string {
  return `${kind}:${sourceKey(sourceId, projectId)}`
}

function waitForActiveChange(): { promise: Promise<void>; cancel: () => void } {
  let off: () => void = () => undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<void>((resolve) => {
    off = client.on('remote:active-changed', () => resolve())
    timer = setTimeout(resolve, ACTIVE_CHANGE_WAIT_MS)
  }).finally(() => {
    off()
    clearTimeout(timer)
  })
  return { promise, cancel: () => { off(); clearTimeout(timer) } }
}

function toastError(title: string, error: unknown): void {
  useToastStore.getState().add({
    type: 'error',
    title,
    message: error instanceof Error ? error.message : String(error),
  })
}

let refreshSeq = 0
const pendingRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
const factsInFlight = new Set<string>()
let pollTimer: ReturnType<typeof setInterval> | null = null

function setWatching(enabled: boolean): void {
  void client.invoke('remote:setUnifiedWatch', enabled).catch(() => undefined)
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = enabled ? setInterval(() => void useUnifiedStore.getState().refresh(), POLL_INTERVAL_MS) : null
}

export const useUnifiedStore = create<UnifiedStore>((set, get) => ({
  enabled: false,
  snapshot: null,
  projects: [],
  loading: false,
  activeSourceId: LOCAL_SOURCE_ID,
  disconnected: {},
  liveStatus: {},
  liveUnread: {},
  liveTitle: {},
  expandedProjects: {},
  collapsedLocations: {},
  expandedPools: {},
  sections: {},
  branchByLocation: {},
  pathExistsByLocation: {},
  archivedProjectsOpen: false,
  queueBySource: {},
  queueLoading: false,

  refreshQueue: async (sourceIds) => {
    const sources = (get().snapshot?.sources ?? [])
      .filter((source) => source.status === 'ok' && (!sourceIds || sourceIds.includes(source.sourceId)))
    if (!sourceIds) set({ queueLoading: true })
    try {
      const results = await Promise.all(sources.map(async (source) => {
        const rows = await get().invokeOn(source.sourceId, 'threads:listQueue').catch(() => null)
        return [source.sourceId, rows ? tagQueue(source.sourceId, source.label, rows) : null] as const
      }))
      set((s) => {
        const next = sourceIds ? { ...s.queueBySource } : {}
        for (const [sourceId, rows] of results) {
          if (rows) next[sourceId] = rows
          else if (!sourceIds) next[sourceId] = s.queueBySource[sourceId] ?? []
        }
        return { queueBySource: next }
      })
    } finally {
      if (!sourceIds) set({ queueLoading: false })
    }
  },

  load: async () => {
    if (!client.capabilities.remoteHosts) return
    const [pref, active] = await Promise.all([
      getPref(SOURCE_PREF_KEY).catch(() => null),
      client.invoke('remote:getActiveHost').catch(() => null),
    ])
    set({ enabled: pref === 'all', activeSourceId: active?.id ?? LOCAL_SOURCE_ID })
    if (pref === 'all') {
      setWatching(true)
      void get().refresh()
    }
  },

  setEnabled: (enabled) => {
    if (get().enabled === enabled) return
    set({ enabled })
    void setPref(SOURCE_PREF_KEY, enabled ? 'all' : 'single')
    setWatching(enabled)
    if (enabled) void get().refresh()
  },

  refresh: async (sourceIds) => {
    const partial = Boolean(sourceIds?.length)
    const seq = partial ? refreshSeq : ++refreshSeq
    if (!partial) set({ loading: true })
    try {
      const snapshot = await client.invoke('remote:getUnifiedSnapshot', partial ? sourceIds : null)
      // A full refresh that started later wins; a partial one merges into whatever is current.
      if (seq !== refreshSeq) return
      const previous = get().snapshot
      const sources = partial && previous ? replaceUnifiedSources(previous.sources, snapshot.sources) : snapshot.sources
      const refreshed = new Set(snapshot.sources.map((source) => source.sourceId))
      // The snapshot is now authoritative for these sources; drop their live overrides.
      const prune = <T>(map: Record<string, T>): Record<string, T> =>
        Object.fromEntries(Object.entries(map).filter(([key]) => !refreshed.has(key.slice(0, key.indexOf(':')))))
      set((s) => ({
        snapshot: { sources, fetchedAt: snapshot.fetchedAt },
        projects: mergeUnifiedSources(sources),
        liveStatus: prune(s.liveStatus),
        liveUnread: prune(s.liveUnread),
        liveTitle: prune(s.liveTitle),
      }))
      if (useUiStore.getState().sidebarViewMode === 'queue') {
        void get().refreshQueue(partial ? [...refreshed] : undefined)
      }
      // Open archived/snoozed pages may have shifted too.
      for (const [key, section] of Object.entries(get().sections)) {
        if (!section?.open) continue
        const [kind, sourceId, ...rest] = key.split(':')
        if (refreshed.has(sourceId)) void get().setSectionPage(kind as SectionKind, sourceId, rest.join(':'), section.page)
      }
    } catch (error) {
      console.error('[unified] Failed to load snapshot', error)
    } finally {
      if (!partial && seq === refreshSeq) set({ loading: false })
    }
  },

  scheduleRefresh: (sourceId) => {
    clearTimeout(pendingRefreshTimers.get(sourceId))
    pendingRefreshTimers.set(sourceId, setTimeout(() => {
      pendingRefreshTimers.delete(sourceId)
      if (get().enabled) void get().refresh([sourceId])
    }, SOURCE_REFRESH_DEBOUNCE_MS))
  },

  invokeOn: (sourceId, channel, ...args) =>
    client.invoke('remote:invokeOnSource', sourceId, channel, args) as Promise<ChannelResult<typeof channel>>,

  activateSource: async (sourceId, projectId) => {
    const active = await client.invoke('remote:getActiveHost')
    if ((active?.id ?? LOCAL_SOURCE_ID) !== sourceId) {
      // App resets every per-host store on `remote:active-changed`; loading before that
      // lands would be wiped, so wait for it (with a fallback in case it never arrives).
      const change = waitForActiveChange()
      try {
        await client.invoke('remote:setActiveHost', sourceId === LOCAL_SOURCE_ID ? null : sourceId)
      } catch (error) {
        change.cancel()
        throw error
      }
      await change.promise
      set({ activeSourceId: sourceId })
      await useProjectStore.getState().fetch()
    }
    if (!projectId) return
    const projects = useProjectStore.getState()
    projects.select(projectId)
    projects.expand(projectId)
    const threads = useThreadStore.getState()
    const locations = useLocationStore.getState()
    await Promise.all([
      threads.byProject[projectId] ? null : threads.fetch(projectId),
      locations.byProject[projectId] ? null : locations.fetch(projectId),
      locations.poolsByProject[projectId] ? null : locations.fetchPools(projectId),
    ])
  },

  openThread: async (sourceId, projectId, threadId) => {
    try {
      await get().activateSource(sourceId, projectId)
      const threads = useThreadStore.getState()
      if (!threads.byProject[projectId]?.some((thread) => thread.id === threadId)) {
        await threads.fetch(projectId)
      }
      useThreadStore.getState().select(threadId)
      set((s) => ({ liveUnread: { ...s.liveUnread, [sourceKey(sourceId, threadId)]: false } }))
    } catch (error) {
      toastError('Could not open thread', error)
    }
  },

  setDraftDestination: async (sourceId, projectId, locationId, opts) => {
    const before = useThreadStore.getState()
    if (sourceId === get().activeSourceId) {
      before.setDraftThreadDestination(projectId, locationId, opts)
      return
    }
    const text = before.draftNewThreadId ? before.draftByThread[before.draftNewThreadId] : undefined
    try {
      await get().activateSource(sourceId, projectId)
      useThreadStore.getState().openDraftThread(projectId, locationId, opts)
      const draftId = useThreadStore.getState().draftNewThreadId
      if (draftId && text) useThreadStore.getState().setDraft(draftId, text)
      window.dispatchEvent(new Event('focus-input'))
    } catch (error) {
      toastError('Could not switch destination', error)
    }
  },

  toggleProject: (key, expanded) => set((s) => ({ expandedProjects: { ...s.expandedProjects, [key]: expanded } })),

  toggleLocation: (sourceId, locationId) => set((s) => {
    const key = sourceKey(sourceId, locationId)
    return { collapsedLocations: { ...s.collapsedLocations, [key]: !s.collapsedLocations[key] } }
  }),

  togglePool: (sourceId, poolId) => set((s) => {
    const key = sourceKey(sourceId, poolId)
    return { expandedPools: { ...s.expandedPools, [key]: !s.expandedPools[key] } }
  }),

  toggleSection: async (kind, sourceId, projectId) => {
    const key = sectionKey(kind, sourceId, projectId)
    const current = get().sections[key]
    if (current?.open) {
      set((s) => ({ sections: { ...s.sections, [key]: { ...current, open: false } } }))
      return
    }
    await get().setSectionPage(kind, sourceId, projectId, 0)
  },

  setSectionPage: async (kind, sourceId, projectId, page) => {
    const key = sectionKey(kind, sourceId, projectId)
    const channel = kind === 'archived' ? 'threads:listArchived' : 'threads:listSnoozed'
    try {
      const threads = await get().invokeOn(sourceId, channel, projectId, SECTION_PAGE_SIZE, page * SECTION_PAGE_SIZE)
      set((s) => ({ sections: { ...s.sections, [key]: { open: true, page, threads } } }))
    } catch (error) {
      toastError(`Could not load ${kind} threads`, error)
    }
  },

  loadLocationFacts: (sourceId, locations) => {
    const state = get()
    for (const location of locations) {
      const key = sourceKey(sourceId, location.id)
      if (factsInFlight.has(key) || key in state.branchByLocation) continue
      factsInFlight.add(key)
      void (async () => {
        try {
          const [branch, exists] = await Promise.all([
            get().invokeOn(sourceId, 'git:branch', location.path).catch(() => null),
            location.connection_type === 'local'
              ? get().invokeOn(sourceId, 'locations:pathExists', location.path).catch(() => true)
              : Promise.resolve(true),
          ])
          set((s) => ({
            branchByLocation: { ...s.branchByLocation, [key]: branch ?? '' },
            pathExistsByLocation: { ...s.pathExistsByLocation, [key]: exists },
          }))
        } finally {
          factsInFlight.delete(key)
        }
      })()
    }
  },

  setArchivedProjectsOpen: (open) => set({ archivedProjectsOpen: open }),

  handleEvent: (event) => {
    if (event.kind === 'connection') {
      set((s) => ({ disconnected: { ...s.disconnected, [event.sourceId]: !event.connected } }))
      // No replay on the stream: whatever happened while it was down needs a refetch.
      if (event.connected) get().scheduleRefresh(event.sourceId)
      return
    }
    const match = /^thread:(status|complete|title):(.+)$/.exec(event.channel)
    if (!match) {
      // webhook:thread-created / routines:changed: the source's structure changed.
      get().scheduleRefresh(event.sourceId)
      return
    }
    const [, kind, threadId] = match
    const key = sourceKey(event.sourceId, threadId)
    if (kind === 'title') {
      set((s) => ({ liveTitle: { ...s.liveTitle, [key]: String(event.args[0] ?? '') } }))
      return
    }
    if (kind === 'status') {
      set((s) => ({ liveStatus: { ...s.liveStatus, [key]: event.args[0] as ThreadStatus } }))
      return
    }
    // complete
    const { activeSourceId } = get()
    const threads = useThreadStore.getState()
    const isActive = event.sourceId === activeSourceId
    const onScreen = isActive && threads.selectedThreadId === threadId
    set((s) => ({
      liveStatus: { ...s.liveStatus, [key]: (event.args[0] as ThreadStatus | undefined) ?? 'idle' },
      liveUnread: onScreen ? s.liveUnread : { ...s.liveUnread, [key]: true },
    }))
    // The tree view already chimes for active-source Threads it has loaded.
    const sidebarChimes = isActive && Object.values(threads.byProject).some((list) => list?.some((t) => t.id === threadId))
    if (!onScreen && !sidebarChimes) playChime()
    // Ordering and previews follow updated_at; pick it up without a full poll.
    get().scheduleRefresh(event.sourceId)
  },
}))

let initialized = false

/** Seed from prefs, track the active source and route watch events. Idempotent. */
export function initUnifiedStore(): void {
  if (initialized || !client.capabilities.remoteHosts) return
  initialized = true
  void useUnifiedStore.getState().load()
  client.on('remote:active-changed', (...args) => {
    const host = args[0] as { id: string } | null | undefined
    useUnifiedStore.setState({ activeSourceId: host?.id ?? LOCAL_SOURCE_ID })
  })
  client.on('remote:hosts-changed', () => {
    if (useUnifiedStore.getState().enabled) void useUnifiedStore.getState().refresh()
  })
  client.on('remote:unified-event', (...args) => {
    const event = args[0] as UnifiedSourceEvent | undefined
    if (event && useUnifiedStore.getState().enabled) useUnifiedStore.getState().handleEvent(event)
  })
}
