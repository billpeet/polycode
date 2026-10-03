import type { BrowserWindow } from 'electron'
import {
  isRemoteChannel,
  isRemoteHostBusyResponse,
  isUnifiedWatchedChannel,
  LOCAL_SOURCE_ID,
  RemoteEventStream,
  RemoteHostBusyError,
  retryWhileHostBusy,
  rpcTimeoutMs,
  type RemoteChannel,
  type UnifiedSnapshot,
  type UnifiedSource,
  type UnifiedSourceEvent,
  type UnifiedSourceProject,
} from '@polycode/shared'
import {
  archivedThreadCount,
  snoozedThreadCount,
  listArchivedProjects,
  listLocationPools,
  listProjects,
  listThreads,
} from '../db/queries'
import { listSyncedLocations } from '../project-admin'
import { onAppEvent, sendToRenderer } from '../app-events'
import type { LocationPool, Project, RemoteHost, RepoLocation, Thread } from '../../shared/types'

/**
 * The unified ("All") view's main-process half: reading Projects, Locations and Threads
 * from this desktop and every saved Remote Host, running a single channel against a
 * chosen source, and watching every source's thread events.
 *
 * Remote traffic deliberately bypasses `RemoteControlClient`: that client models exactly
 * one *active* host — its circuit breaker, connection state and SSE stream all describe
 * that host — and a failed read against some other host must not flip the title-bar dot
 * or open the active host's circuit. These are plain one-shot RPCs with their own budget;
 * a host that does not answer shows as unreachable in the snapshot.
 */

const HOST_BUDGET_MS = 20_000
const SNAPSHOT_REQUEST_TIMEOUT_MS = 8_000
/** Stay under the host's admission limit (REMOTE_MAX_IN_FLIGHT) so live traffic still fits. */
const PER_HOST_CONCURRENCY = 3
/** Name of the event pushed to the renderer; carries a `UnifiedSourceEvent`. */
export const UNIFIED_EVENT_CHANNEL = 'remote:unified-event'

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

async function collectLocal(): Promise<UnifiedSource> {
  const base = { sourceId: LOCAL_SOURCE_ID, label: 'Local' }
  try {
    const projects = await mapLimited(listProjects(), 4, async (project): Promise<UnifiedSourceProject> => ({
      project,
      locations: await listSyncedLocations(project.id).catch(() => []),
      pools: safe(() => listLocationPools(project.id), []),
      threads: listThreads(project.id),
      archivedCount: safe(() => archivedThreadCount(project.id), 0),
      snoozedCount: safe(() => snoozedThreadCount(project.id), 0),
    }))
    return { ...base, status: 'ok', error: null, projects, archivedProjects: safe(listArchivedProjects, []) }
  } catch (error) {
    return { ...base, status: 'error', error: errorMessage(error), projects: [], archivedProjects: [] }
  }
}

async function rpc<T>(host: RemoteHost, channel: string, args: unknown[], signal: AbortSignal | null, timeoutMs: number): Promise<T> {
  return retryWhileHostBusy(async () => {
    const timeout = AbortSignal.timeout(timeoutMs)
    const response = await fetch(`${host.baseUrl.replace(/\/+$/, '')}/api/remote/rpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${host.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, args }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    const body = await response.json().catch(() => ({})) as { ok?: boolean; value?: unknown; error?: string }
    if (isRemoteHostBusyResponse(response.status, body)) throw new RemoteHostBusyError(body.error)
    if (!response.ok || !body.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
    return body.value as T
  }, () => signal?.aborted ?? false)
}

async function collectRemote(host: RemoteHost): Promise<UnifiedSource> {
  const controller = new AbortController()
  const budget = setTimeout(() => controller.abort(), HOST_BUDGET_MS)
  const base = { sourceId: host.id, label: host.label }
  try {
    const { signal } = controller
    const read = <T>(channel: string, args: unknown[], fallback: T): Promise<T> =>
      rpc<T>(host, channel, args, signal, SNAPSHOT_REQUEST_TIMEOUT_MS).catch(() => fallback)
    const [list, archivedProjects] = await Promise.all([
      rpc<Project[]>(host, 'projects:list', [], signal, SNAPSHOT_REQUEST_TIMEOUT_MS),
      read<Project[]>('projects:listArchived', [], []),
    ])
    const projects = await mapLimited(list, PER_HOST_CONCURRENCY, async (project): Promise<UnifiedSourceProject> => {
      const [locations, pools, threads, archivedCount, snoozedCount] = await Promise.all([
        read<RepoLocation[]>('locations:list', [project.id], []),
        read<LocationPool[]>('location-pools:list', [project.id], []),
        read<Thread[]>('threads:list', [project.id], []),
        read<number>('threads:archivedCount', [project.id], 0),
        read<number>('threads:snoozedCount', [project.id], 0),
      ])
      return { project, locations, pools, threads, archivedCount, snoozedCount }
    })
    return { ...base, status: 'ok', error: null, projects, archivedProjects }
  } catch (error) {
    const message = controller.signal.aborted ? 'Timed out' : errorMessage(error)
    return { ...base, status: 'error', error: message, projects: [], archivedProjects: [] }
  } finally {
    clearTimeout(budget)
  }
}

/** Every source, or only `sourceIds` when given (a partial refresh after a change). */
export async function collectUnifiedSnapshot(hosts: RemoteHost[], sourceIds?: string[] | null): Promise<UnifiedSnapshot> {
  const wanted = (id: string): boolean => !sourceIds || sourceIds.includes(id)
  const sources = await Promise.all([
    ...(wanted(LOCAL_SOURCE_ID) ? [collectLocal()] : []),
    ...hosts.filter((host) => wanted(host.id)).map(collectRemote),
  ])
  return { sources, fetchedAt: new Date().toISOString() }
}

/**
 * Run one remote-capable channel against a specific source without touching the active
 * host. Restricted to `{ remote: true }` channels: those are exactly the operations a
 * Remote Host already accepts from another client, so the local path is no wider.
 */
export async function invokeOnSource(
  hosts: RemoteHost[],
  sourceId: string,
  channel: string,
  args: unknown[],
  invokeLocally: (channel: RemoteChannel, args: unknown[]) => Promise<unknown>,
): Promise<unknown> {
  if (!isRemoteChannel(channel)) throw new Error(`Channel "${channel}" cannot be run on a chosen source`)
  if (sourceId === LOCAL_SOURCE_ID) return invokeLocally(channel, args)
  const host = hosts.find((candidate) => candidate.id === sourceId)
  if (!host) throw new Error('Remote host not found')
  return rpc(host, channel, args, null, rpcTimeoutMs(channel))
}

/**
 * Forwards thread lifecycle events from every source while the unified view is open:
 * the local app-event bus, plus one SSE stream per saved Remote Host. Events reach the
 * renderer tagged with their source on `UNIFIED_EVENT_CHANNEL`, never on their original
 * channel — the single-source stores keep seeing only the active source, as before.
 */
class UnifiedEventWatch {
  private streams = new Map<string, { host: RemoteHost; stream: RemoteEventStream }>()
  private offLocal: (() => void) | null = null

  constructor(
    private readonly window: BrowserWindow,
    private readonly getHosts: () => RemoteHost[],
  ) {}

  get running(): boolean {
    return this.offLocal !== null
  }

  start(): void {
    if (this.running) return
    this.offLocal = onAppEvent((event) => {
      if (event.channel === 'remote:hosts-changed') {
        this.syncHosts()
        return
      }
      if (isUnifiedWatchedChannel(event.channel)) {
        this.push({ sourceId: LOCAL_SOURCE_ID, kind: 'event', channel: event.channel, args: event.args })
      }
    })
    this.syncHosts()
  }

  stop(): void {
    this.offLocal?.()
    this.offLocal = null
    for (const { stream } of this.streams.values()) stream.stop()
    this.streams.clear()
  }

  /** (Re)dial each saved host; drop streams for removed hosts or changed credentials. */
  private syncHosts(): void {
    const hosts = this.getHosts()
    for (const [id, entry] of this.streams) {
      const current = hosts.find((host) => host.id === id)
      if (!current || current.baseUrl !== entry.host.baseUrl || current.token !== entry.host.token) {
        entry.stream.stop()
        this.streams.delete(id)
      }
    }
    for (const host of hosts) {
      if (this.streams.has(host.id)) continue
      const stream = new RemoteEventStream({
        onEvent: (event) => {
          if (isUnifiedWatchedChannel(event.channel)) {
            this.push({ sourceId: host.id, kind: 'event', channel: event.channel, args: event.args })
          }
        },
        onConnected: () => this.push({ sourceId: host.id, kind: 'connection', connected: true }),
        onDisconnected: () => this.push({ sourceId: host.id, kind: 'connection', connected: false }),
      })
      this.streams.set(host.id, { host, stream })
      stream.start({ baseUrl: host.baseUrl, token: host.token })
    }
  }

  private push(event: UnifiedSourceEvent): void {
    // sendToRenderer, not emitAppEvent: these must not loop back onto the bus that this
    // desktop's own remote-control server streams to its clients.
    sendToRenderer(this.window, UNIFIED_EVENT_CHANNEL, event)
  }
}

let watch: UnifiedEventWatch | null = null

export function setUnifiedWatch(window: BrowserWindow, getHosts: () => RemoteHost[], enabled: boolean): void {
  if (!enabled) {
    watch?.stop()
    return
  }
  if (!watch) watch = new UnifiedEventWatch(window, getHosts)
  watch.start()
}

export function stopUnifiedWatch(): void {
  watch?.stop()
  watch = null
}
