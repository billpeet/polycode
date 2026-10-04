import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import {
  createUnifiedCollapsedLoader,
  mergeUnifiedSources,
  readUnifiedSourceProjects,
  replaceUnifiedSources,
  sourceKey,
  tagUnifiedQueue,
  type ChannelArgs,
  type ChannelResult,
  type QueueThread,
  type Thread,
  type ThreadStatus,
  type UnifiedProject,
  type UnifiedQueueThread,
  type UnifiedSnapshot,
  type UnifiedSource,
  type UnifiedSourceEvent,
} from '@polycode/shared'
import { errorMessage, rpcRequest } from '../api/client'
import { rpc, type RpcChannel } from '../api/rpc'
import { unifiedWatch, type WatchTarget } from '../api/unified-watch'
import { useHostsStore, type HostMeta } from './hosts'

/**
 * State for the unified ("All") view: every saved host's Projects, Locations, Threads and
 * Queue, gathered into one picture, plus the actions that work on any of them.
 *
 * On the phone every source is a Remote Host — there is no local one — so the snapshot is
 * collected here, one host at a time, with the reader the desktop uses for its own remote
 * sources. As on the desktop, two routes reach a host. Simple mutations (archive, snooze,
 * rename, …) are sent straight to the host that owns the Thread and leave the active host
 * alone. Anything that needs the workspace — opening a Thread, the New-thread sheet,
 * commands — first makes that host the active one (`lib/sources.ts`) and then takes the
 * ordinary single-host path.
 */

/** Whole-host budget for one snapshot read; a host that blows it shows as unreachable. */
const HOST_BUDGET_MS = 20_000
const SNAPSHOT_REQUEST_TIMEOUT_MS = 8_000
const SOURCE_REFRESH_DEBOUNCE_MS = 1_500
/** Coalesces bursts of status events into one Queue refetch, as the single-host Queue does. */
const QUEUE_REFRESH_DEBOUNCE_MS = 400

function emptySource(host: HostMeta, error: string): UnifiedSource {
  return { sourceId: host.id, label: host.label, status: 'error', error, projects: [], archivedProjects: [] }
}

async function collectSource(host: HostMeta): Promise<UnifiedSource> {
  const connection = useHostsStore.getState().connectionFor(host.id)
  if (!connection) return emptySource(host, 'Missing token')
  const deadline = Date.now() + HOST_BUDGET_MS
  let expired = false
  try {
    const result = await readUnifiedSourceProjects((channel, args) => {
      if (Date.now() > deadline) {
        expired = true
        return Promise.reject(new Error('Timed out'))
      }
      return rpcRequest(connection, channel, args, SNAPSHOT_REQUEST_TIMEOUT_MS)
    })
    // Per-Project reads fall back to empty when refused, so a blown budget would
    // otherwise pass off a half-read host as a complete one.
    if (expired) return emptySource(host, 'Timed out')
    return { sourceId: host.id, label: host.label, status: 'ok', error: null, ...result }
  } catch (error) {
    return emptySource(host, errorMessage(error))
  }
}

function patchSources(
  sources: UnifiedSource[],
  sourceId: string,
  update: (threads: Thread[]) => Thread[],
): UnifiedSource[] {
  return sources.map((source) => {
    if (source.sourceId !== sourceId) return source
    let changed = false
    const projects = source.projects.map((entry) => {
      const threads = update(entry.threads)
      if (threads === entry.threads) return entry
      changed = true
      return { ...entry, threads }
    })
    return changed ? { ...source, projects } : source
  })
}

interface UnifiedState {
  /** True while "All" is selected in the top-bar source switcher. Persisted. */
  enabled: boolean
  snapshot: UnifiedSnapshot | null
  /** `snapshot` merged so one repository appears once, however many hosts hold it. */
  projects: UnifiedProject[]
  loading: boolean
  /** Hosts whose event stream is currently down (live status may be stale). */
  disconnected: Record<string, boolean>
  /** Each host's Queue, tagged with its source. */
  queueBySource: Record<string, UnifiedQueueThread[]>
  queueLoading: boolean
  /** Keyed by `UnifiedProject.key`. Persisted, like the single-host tree's expansion. */
  expandedProjects: Record<string, boolean>
  /**
   * `sourceKey(host, projectId)` → the merged Project's key, for every Project a snapshot
   * has shown. Only ever added to: a Queue row keeps its Project identity while its host
   * is unreachable (and so absent from `projects`), which keeps a Project filter stable.
   */
  projectKeys: Record<string, string>

  setEnabled: (enabled: boolean) => void
  /** Point the event watch at the saved hosts and (re)load everything. */
  sync: () => void
  /** Reload the snapshot and Queue: every host, or only `sourceIds` after a change. */
  refresh: (sourceIds?: string[]) => Promise<void>
  refreshQueue: (sourceIds?: string[]) => Promise<void>
  scheduleRefresh: (sourceId: string) => void
  invokeOn: <C extends RpcChannel>(sourceId: string, channel: C, ...args: ChannelArgs<C>) => Promise<ChannelResult<C>>
  toggleProject: (key: string) => void
  handleEvent: (event: UnifiedSourceEvent) => void

  archiveThread: (sourceId: string, threadId: string) => Promise<void>
  unarchiveThread: (sourceId: string, threadId: string) => Promise<void>
  snoozeThread: (sourceId: string, threadId: string, untilIso: string) => Promise<void>
  wakeThread: (sourceId: string, threadId: string) => Promise<void>
  renameThread: (sourceId: string, threadId: string, name: string) => Promise<void>
  resetThread: (sourceId: string, threadId: string) => Promise<void>
  deleteThread: (sourceId: string, threadId: string) => Promise<void>
  /** Apply a patch to a Thread wherever it appears: the snapshot and its host's Queue. */
  patchThread: (sourceId: string, threadId: string, patch: Partial<Thread>) => void
}

/**
 * Latest read started per host, for the snapshot and for the Queue. Hosts answer at very
 * different speeds, and a full refresh, a partial one and a status-driven Queue refetch
 * can all be in flight for the same host; only the most recently started may land.
 */
const snapshotSeq = new Map<string, number>()
const queueSeq = new Map<string, number>()
/** Full refreshes in flight; the pull-to-refresh spinners show while any is. */
let fullSnapshotRefreshes = 0
let fullQueueRefreshes = 0

function nextSeq(seqs: Map<string, number>, sourceId: string): number {
  const seq = (seqs.get(sourceId) ?? 0) + 1
  seqs.set(sourceId, seq)
  return seq
}
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
const queueTimers = new Map<string, ReturnType<typeof setTimeout>>()

function clearTimers(timers: Map<string, ReturnType<typeof setTimeout>>): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
}

function savedHosts(sourceIds?: string[]): HostMeta[] {
  const { hosts } = useHostsStore.getState()
  return sourceIds ? hosts.filter((host) => sourceIds.includes(host.id)) : hosts
}

/** Keep only entries whose host is still saved. */
function forSavedHosts<T>(map: Record<string, T>): Record<string, T> {
  const ids = new Set(useHostsStore.getState().hosts.map((host) => host.id))
  return Object.fromEntries(Object.entries(map).filter(([id]) => ids.has(id)))
}

export const useUnifiedStore = create<UnifiedState>()(
  persist(
    (set, get) => {
      const removeThread = (sourceId: string, threadId: string): void => {
        set((s) => {
          const sources = s.snapshot
            ? patchSources(s.snapshot.sources, sourceId, (threads) =>
                threads.some((t) => t.id === threadId) ? threads.filter((t) => t.id !== threadId) : threads,
              )
            : null
          const queue = s.queueBySource[sourceId]
          return {
            ...(s.snapshot && sources
              ? { snapshot: { ...s.snapshot, sources }, projects: mergeUnifiedSources(sources) }
              : {}),
            queueBySource: queue
              ? { ...s.queueBySource, [sourceId]: queue.filter((t) => t.id !== threadId) }
              : s.queueBySource,
          }
        })
      }

      return {
        enabled: false,
        snapshot: null,
        projects: [],
        loading: false,
        disconnected: {},
        queueBySource: {},
        queueLoading: false,
        expandedProjects: {},
        projectKeys: {},

        setEnabled: (enabled) => {
          if (get().enabled !== enabled) set({ enabled })
        },

        sync: () => {
          if (!get().enabled) {
            unifiedWatch.sync([])
            clearTimers(refreshTimers)
            clearTimers(queueTimers)
            return
          }
          const hosts = useHostsStore.getState()
          // The view spans every host, but the New-thread sheet and anything else that
          // needs the workspace go through the active one — so there has to be one.
          if (hosts.hosts.length > 0 && !hosts.hosts.some((host) => host.id === hosts.activeHostId)) {
            hosts.setActiveHost(hosts.hosts[0].id)
          }
          const targets: WatchTarget[] = []
          for (const host of hosts.hosts) {
            const connection = hosts.connectionFor(host.id)
            if (connection) targets.push({ sourceId: host.id, ...connection })
          }
          unifiedWatch.sync(targets)
          void get().refresh()
        },

        /**
         * Each host is committed as soon as it answers, so one that is asleep holds up
         * only itself rather than every other host's rows for its whole timeout.
         */
        refresh: async (sourceIds) => {
          const partial = Boolean(sourceIds?.length)
          if (!partial && fullSnapshotRefreshes++ === 0) set({ loading: true })
          try {
            await Promise.all([
              // The Queue is one RPC per host against the snapshot's five per Project, and
              // it is the tab the app opens on, so it does not wait for the snapshot.
              get().refreshQueue(sourceIds),
              ...savedHosts(sourceIds).map(async (host) => {
                const seq = nextSeq(snapshotSeq, host.id)
                const source = await collectSource(host)
                if (snapshotSeq.get(host.id) !== seq) return
                set((s) => {
                  // Saved-host order, whatever order the answers came in: it decides the
                  // order of a merged Project's members.
                  const order = useHostsStore.getState().hosts.map((saved) => saved.id)
                  const sources = replaceUnifiedSources(s.snapshot?.sources ?? [], [source])
                    .filter((entry) => order.includes(entry.sourceId))
                    .sort((a, b) => order.indexOf(a.sourceId) - order.indexOf(b.sourceId))
                  const projects = mergeUnifiedSources(sources)
                  const projectKeys = { ...s.projectKeys }
                  for (const project of projects) {
                    for (const member of project.members) {
                      projectKeys[sourceKey(member.sourceId, member.project.id)] = project.key
                    }
                  }
                  return { snapshot: { sources, fetchedAt: new Date().toISOString() }, projects, projectKeys }
                })
              }),
            ])
            // A host removed since the last read has nobody left to commit over it.
            const saved = new Set(useHostsStore.getState().hosts.map((host) => host.id))
            const snapshot = get().snapshot
            if (snapshot?.sources.some((source) => !saved.has(source.sourceId))) {
              const sources = snapshot.sources.filter((source) => saved.has(source.sourceId))
              set({
                snapshot: { ...snapshot, sources },
                projects: mergeUnifiedSources(sources),
                queueBySource: forSavedHosts(get().queueBySource),
              })
            }
          } finally {
            if (!partial && --fullSnapshotRefreshes === 0) set({ loading: false })
          }
        },

        /**
         * Does not clear a host's rows first, and keeps them when the host cannot be
         * reached: this runs on every status event and on resume, and blanking the list
         * mid-read would make the Queue flicker.
         */
        refreshQueue: async (sourceIds) => {
          const partial = Boolean(sourceIds?.length)
          if (!partial && fullQueueRefreshes++ === 0) set({ queueLoading: true })
          try {
            await Promise.all(
              savedHosts(sourceIds).map(async (host) => {
                const connection = useHostsStore.getState().connectionFor(host.id)
                if (!connection) return
                const seq = nextSeq(queueSeq, host.id)
                const rows = await (
                  rpcRequest(connection, 'threads:listQueue', [], SNAPSHOT_REQUEST_TIMEOUT_MS) as Promise<QueueThread[]>
                ).catch(() => null)
                if (!rows || queueSeq.get(host.id) !== seq) return
                set((s) => ({
                  queueBySource: forSavedHosts({
                    ...s.queueBySource,
                    [host.id]: tagUnifiedQueue(host.id, host.label, rows),
                  }),
                }))
              }),
            )
          } finally {
            if (!partial && --fullQueueRefreshes === 0) set({ queueLoading: false })
          }
        },

        scheduleRefresh: (sourceId) => {
          clearTimeout(refreshTimers.get(sourceId))
          refreshTimers.set(
            sourceId,
            setTimeout(() => {
              refreshTimers.delete(sourceId)
              if (get().enabled) void get().refresh([sourceId])
            }, SOURCE_REFRESH_DEBOUNCE_MS),
          )
        },

        invokeOn: (sourceId, channel, ...args) => {
          const connection = useHostsStore.getState().connectionFor(sourceId)
          if (!connection) return Promise.reject(new Error('Host not found'))
          return rpc(connection, channel, ...args)
        },

        toggleProject: (key) =>
          set((s) => ({ expandedProjects: { ...s.expandedProjects, [key]: !s.expandedProjects[key] } })),

        handleEvent: (event) => {
          const { sourceId } = event
          if (event.kind === 'connection') {
            const wasDown = get().disconnected[sourceId] === true
            set((s) => ({ disconnected: forSavedHosts({ ...s.disconnected, [sourceId]: !event.connected }) }))
            // No replay on the stream: whatever happened while it was down needs a refetch.
            // The first connect is not a reconnect — `sync` has already loaded everything.
            if (event.connected && wasDown) get().scheduleRefresh(sourceId)
            return
          }
          const match = /^thread:(status|complete|title):(.+)$/.exec(event.channel)
          if (!match) {
            // webhook:thread-created / routines:changed: the host's structure changed.
            get().scheduleRefresh(sourceId)
            return
          }
          const [, kind, threadId] = match
          if (kind === 'title') {
            if (typeof event.args[0] === 'string') get().patchThread(sourceId, threadId, { name: event.args[0] })
            return
          }
          const status = event.args[0] as ThreadStatus | undefined
          if (status) get().patchThread(sourceId, threadId, { status })
          if (kind === 'complete') {
            // A finished Turn moves the Thread between Queue sections and changes its
            // unread flag, preview and ordering; pick all of that up from the host.
            get().scheduleRefresh(sourceId)
            return
          }
          clearTimeout(queueTimers.get(sourceId))
          queueTimers.set(
            sourceId,
            setTimeout(() => {
              queueTimers.delete(sourceId)
              if (get().enabled) void get().refreshQueue([sourceId])
            }, QUEUE_REFRESH_DEBOUNCE_MS),
          )
        },

        archiveThread: async (sourceId, threadId) => {
          await get().invokeOn(sourceId, 'threads:archive', threadId)
          removeThread(sourceId, threadId)
          get().scheduleRefresh(sourceId)
        },

        unarchiveThread: async (sourceId, threadId) => {
          await get().invokeOn(sourceId, 'threads:unarchive', threadId)
          // Not awaited: callers reload their own list as soon as the host has done it.
          void get().refresh([sourceId])
        },

        /**
         * As in the single-host store: a snoozed Thread leaves both the tree and the
         * Queue, and nothing about its session is torn down.
         */
        snoozeThread: async (sourceId, threadId, untilIso) => {
          await get().invokeOn(sourceId, 'threads:snooze', threadId, untilIso)
          removeThread(sourceId, threadId)
          get().scheduleRefresh(sourceId)
        },

        wakeThread: async (sourceId, threadId) => {
          await get().invokeOn(sourceId, 'threads:unsnooze', threadId)
          void get().refresh([sourceId])
        },

        renameThread: async (sourceId, threadId, name) => {
          await get().invokeOn(sourceId, 'threads:updateName', threadId, name)
          get().patchThread(sourceId, threadId, { name })
        },

        resetThread: async (sourceId, threadId) => {
          await get().invokeOn(sourceId, 'threads:reset', threadId)
        },

        deleteThread: async (sourceId, threadId) => {
          await get().invokeOn(sourceId, 'threads:delete', threadId)
          removeThread(sourceId, threadId)
          get().scheduleRefresh(sourceId)
        },

        patchThread: (sourceId, threadId, patch) =>
          set((s) => {
            const previous = s.snapshot?.sources
            const sources = previous
              ? patchSources(previous, sourceId, (threads) =>
                  threads.some((t) => t.id === threadId)
                    ? threads.map((t) => (t.id === threadId ? { ...t, ...patch } : t))
                    : threads,
                )
              : null
            const inSnapshot = Boolean(sources && previous && sources.some((source, i) => source !== previous[i]))
            const queue = s.queueBySource[sourceId]
            const inQueue = queue?.some((t) => t.id === threadId)
            // Slices the Thread is not in keep their identity, so an event for a Thread
            // that is not on screen re-renders nothing.
            return {
              ...(s.snapshot && sources && inSnapshot
                ? { snapshot: { ...s.snapshot, sources }, projects: mergeUnifiedSources(sources) }
                : {}),
              ...(queue && inQueue
                ? {
                    queueBySource: {
                      ...s.queueBySource,
                      [sourceId]: queue.map((t) => (t.id === threadId ? { ...t, ...patch } : t)),
                    },
                  }
                : {}),
            }
          }),
      }
    },
    {
      name: 'polycode.unified',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ enabled: s.enabled, expandedProjects: s.expandedProjects }),
    },
  ),
)

unifiedWatch.setListener((event) => {
  const state = useUnifiedStore.getState()
  if (state.enabled) state.handleEvent(event)
})

/**
 * Snoozed/Archived loader for the unified Queue, fanned out across every saved host.
 * Module-level so its identity is stable across renders.
 */
export const loadUnifiedCollapsed = createUnifiedCollapsedLoader(
  () => useHostsStore.getState().hosts.map((host) => ({ sourceId: host.id, label: host.label })),
  (sourceId, variant, search, limit, offset) => {
    const { invokeOn } = useUnifiedStore.getState()
    return variant === 'snoozed'
      ? invokeOn(sourceId, 'threads:listQueueSnoozed', search, limit, offset)
      : invokeOn(sourceId, 'threads:listQueueArchived', search, limit, offset)
  },
)

/**
 * How the unified view is doing as a whole, for the top-bar dot: `connected` when every
 * host answered and is streaming, `disconnected` when none is, `connecting` in between
 * (including before the first snapshot lands).
 */
export function unifiedConnectionState(
  state: Pick<UnifiedState, 'snapshot' | 'disconnected'>,
): 'connected' | 'connecting' | 'disconnected' {
  const sources = state.snapshot?.sources
  if (!sources || sources.length === 0) return 'connecting'
  const healthy = sources.filter((source) => source.status === 'ok' && !state.disconnected[source.sourceId])
  if (healthy.length === sources.length) return 'connected'
  return healthy.length === 0 ? 'disconnected' : 'connecting'
}
