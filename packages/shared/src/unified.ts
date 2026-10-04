import type { LocationPool, Project, QueueThread, RepoLocation, Thread } from './types'

/**
 * The unified ("All") view: every Project, Project Location and Thread from the local
 * desktop and every saved Remote Host, gathered in one pass and merged so that Projects
 * checked out against the same repository appear once.
 *
 * A source is either this desktop (`LOCAL_SOURCE_ID`) or a Remote Host (its host id).
 * Merging is a presentation concern only: each member keeps its own source, ids and
 * Locations, because a Thread can only be conducted by the instance that owns it.
 */

export const LOCAL_SOURCE_ID = 'local'

export interface UnifiedSourceProject {
  project: Project
  locations: RepoLocation[]
  pools: LocationPool[]
  /** Live (unarchived, unsnoozed) Threads; archived and snoozed ones are paged in on demand. */
  threads: Thread[]
  archivedCount: number
  snoozedCount: number
}

export interface UnifiedSource {
  /** `LOCAL_SOURCE_ID` or a Remote Host id. */
  sourceId: string
  label: string
  /** `error` means the source could not be reached; `projects` is then empty. */
  status: 'ok' | 'error'
  error: string | null
  projects: UnifiedSourceProject[]
  archivedProjects: Project[]
}

export interface UnifiedSnapshot {
  sources: UnifiedSource[]
  fetchedAt: string
}

/**
 * A live event from one source, pushed while the unified view is watching
 * (`remote:setUnifiedWatch`). `event` carries a thread-level app event exactly as the
 * source emitted it; `connection` reports the source's event stream going up or down
 * (there is no replay, so a reconnect means "refetch this source").
 */
export type UnifiedSourceEvent =
  | { sourceId: string; kind: 'event'; channel: string; args: unknown[] }
  | { sourceId: string; kind: 'connection'; connected: boolean }

/** App-event channels the unified watch forwards; everything else stays per-source. */
export function isUnifiedWatchedChannel(channel: string): boolean {
  return /^thread:(status|complete|title):/.test(channel)
    || channel === 'webhook:thread-created'
    || channel === 'routines:changed'
}

/** Replace some sources in a snapshot, keeping the others and the original order. */
export function replaceUnifiedSources(previous: UnifiedSource[], next: UnifiedSource[]): UnifiedSource[] {
  const byId = new Map(next.map((source) => [source.sourceId, source]))
  const merged = previous.map((source) => byId.get(source.sourceId) ?? source)
  for (const source of next) {
    if (!previous.some((existing) => existing.sourceId === source.sourceId)) merged.push(source)
  }
  return merged
}

/** Key for anything scoped to one source: `${sourceId}:${id}`. */
export function sourceKey(sourceId: string, id: string): string {
  return `${sourceId}:${id}`
}

/** Runs one remote-capable channel against a single source. */
export type UnifiedSourceCall = (channel: string, args: unknown[]) => Promise<unknown>

/**
 * RPCs a snapshot read keeps in flight against one source. A Remote Host refuses a ninth
 * concurrent RPC (`remote/server.ts`), and the snapshot shares those slots with whatever
 * else is talking to the host, so it takes half.
 */
export const UNIFIED_SOURCE_CONCURRENCY = 4

function limitConcurrency(call: UnifiedSourceCall, limit: number): UnifiedSourceCall {
  let active = 0
  const waiting: (() => void)[] = []
  return async (channel, args) => {
    // A finishing call hands its slot straight to the next waiter, so `active` only
    // moves when nobody is waiting; a newcomer can never slip in between the two.
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve))
    else active++
    try {
      return await call(channel, args)
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}

/**
 * Read one Remote Host's half of the snapshot: its Projects, and each Project's
 * Locations, pools, live Threads and collapsed-section counts. Rejects when the Project
 * list itself cannot be read (the source is unreachable); any other read that fails
 * falls back to empty rather than hiding the whole source. Shared by every client that
 * builds a unified view, so they cannot disagree about what a source contains.
 */
export async function readUnifiedSourceProjects(
  call: UnifiedSourceCall,
  concurrency: number = UNIFIED_SOURCE_CONCURRENCY,
): Promise<Pick<UnifiedSource, 'projects' | 'archivedProjects'>> {
  const limited = limitConcurrency(call, concurrency)
  const read = <T>(channel: string, args: unknown[], fallback: T): Promise<T> =>
    (limited(channel, args) as Promise<T>).catch(() => fallback)
  const [list, archivedProjects] = await Promise.all([
    limited('projects:list', []) as Promise<Project[]>,
    read<Project[]>('projects:listArchived', [], []),
  ])
  const projects = await Promise.all(list.map(async (project): Promise<UnifiedSourceProject> => {
    const [locations, pools, threads, archivedCount, snoozedCount] = await Promise.all([
      read<RepoLocation[]>('locations:list', [project.id], []),
      read<LocationPool[]>('location-pools:list', [project.id], []),
      read<Thread[]>('threads:list', [project.id], []),
      read<number>('threads:archivedCount', [project.id], 0),
      read<number>('threads:snoozedCount', [project.id], 0),
    ])
    return { project, locations, pools, threads, archivedCount, snoozedCount }
  }))
  return { projects, archivedProjects }
}

/** A Queue row from any source. `source_id`/`source_label` say whose it is. */
export interface UnifiedQueueThread extends QueueThread {
  source_id: string
  source_label: string
}

export function tagUnifiedQueue(sourceId: string, label: string, rows: QueueThread[]): UnifiedQueueThread[] {
  return rows.map((row) => ({ ...row, source_id: sourceId, source_label: label }))
}

function queueActivity(thread: QueueThread): number {
  const time = new Date(thread.last_turn_completed_at ?? thread.updated_at).getTime()
  return Number.isNaN(time) ? 0 : time
}

export type UnifiedCollapsedVariant = 'archived' | 'snoozed'

/**
 * Builds the Snoozed/Archived loader for a unified Queue. Each source is paged on its
 * own (it only knows its own offsets), so the loader keeps a cursor per source; a page
 * is the union of every source's next rows, newest activity first, and can therefore be
 * longer than `limit`. Cursors restart whenever a section is loaded from offset 0.
 */
export function createUnifiedCollapsedLoader(
  getSources: () => Pick<UnifiedSource, 'sourceId' | 'label'>[],
  list: (
    sourceId: string,
    variant: UnifiedCollapsedVariant,
    search: string | null,
    limit: number,
    offset: number,
  ) => Promise<QueueThread[]>,
): (
  variant: UnifiedCollapsedVariant,
  search: string | null,
  offset: number,
  limit: number,
) => Promise<{ rows: UnifiedQueueThread[]; hasMore: boolean }> {
  const cursorsByQuery = new Map<string, { cursors: Record<string, number>; exhausted: Set<string> }>()
  return async (variant, search, offset, limit) => {
    const sources = getSources()
    const cursorKey = `${variant}:${search ?? ''}`
    let entry = cursorsByQuery.get(cursorKey)
    if (offset === 0 || !entry) {
      entry = { cursors: {}, exhausted: new Set() }
      cursorsByQuery.set(cursorKey, entry)
    }
    const { cursors, exhausted } = entry
    const pages = await Promise.all(sources
      .filter((source) => !exhausted.has(source.sourceId))
      .map(async (source) => {
        const from = cursors[source.sourceId] ?? 0
        const rows = await list(source.sourceId, variant, search, limit, from).catch(() => [] as QueueThread[])
        cursors[source.sourceId] = from + rows.length
        if (rows.length < limit) exhausted.add(source.sourceId)
        return tagUnifiedQueue(source.sourceId, source.label, rows)
      }))
    const rows = pages.flat().sort((a, b) => queueActivity(b) - queueActivity(a))
    return { rows, hasMore: sources.some((source) => !exhausted.has(source.sourceId)) }
  }
}

/** One source's copy of a merged Project. */
export interface UnifiedProjectMember extends UnifiedSourceProject {
  sourceId: string
  sourceLabel: string
}

export interface UnifiedProject {
  /** Stable key: the normalized Git URL, or `source:projectId` for Projects without one. */
  key: string
  name: string
  /** Normalized repository identity shared by every member; null when ungrouped. */
  repoKey: string | null
  gitUrl: string | null
  members: UnifiedProjectMember[]
  /** Latest Thread or Project activity across members (ISO). */
  lastActivityAt: string
}

/**
 * Strip leading and trailing slashes by scanning, not with a regex: `/\/+$/` backtracks
 * quadratically on a long run of slashes that is not at the end, and this input is a
 * Git URL that may come from another machine.
 */
function trimSlashes(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && value.charCodeAt(start) === 47) start++
  while (end > start && value.charCodeAt(end - 1) === 47) end--
  return value.slice(start, end)
}

/**
 * Reduce a Git remote URL to a comparable repository identity, so the HTTPS, SSH and
 * scp-style spellings of one repository agree:
 *
 *   https://github.com/Org/Repo.git   → github.com/org/repo
 *   git@github.com:Org/Repo.git       → github.com/org/repo
 *   ssh://git@github.com:22/Org/Repo  → github.com/org/repo
 *
 * Azure DevOps SSH remotes (`git@ssh.dev.azure.com:v3/org/project/repo`) are mapped onto
 * the HTTPS shape (`dev.azure.com/org/project/_git/repo`). The whole key is lowercased:
 * the common Forges treat repository paths case-insensitively.
 */
export function normalizeGitUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  let value = raw.trim()
  if (!value) return null

  let host: string
  let path: string
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(value)
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && scp) {
    host = scp[1]
    path = scp[2]
  } else {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`
    try {
      const url = new URL(value)
      host = url.hostname
      path = url.pathname
    } catch {
      return value.toLowerCase()
    }
  }

  host = host.toLowerCase()
  path = trimSlashes(path)
  if (path.toLowerCase().endsWith('.git')) path = path.slice(0, -'.git'.length)
  path = path.toLowerCase()

  if (host === 'ssh.dev.azure.com' && path.startsWith('v3/')) {
    const [, org, project, repo] = path.split('/')
    if (org && project && repo) return `dev.azure.com/${org}/${project}/_git/${repo}`
  }
  // https://org@dev.azure.com/org/project/_git/repo carries the org as userinfo; URL drops it.
  if (host.endsWith('.visualstudio.com')) {
    const org = host.slice(0, -'.visualstudio.com'.length)
    return `dev.azure.com/${org}/${path.replace(/^defaultcollection\//, '')}`
  }

  return path ? `${host}/${path}` : host
}

function latest(a: string, b: string | undefined): string {
  if (!b) return a
  return new Date(b).getTime() > new Date(a).getTime() ? b : a
}

function memberActivity(member: UnifiedSourceProject): string {
  let value = member.project.last_activity_at ?? member.project.updated_at
  for (const thread of member.threads) value = latest(value, thread.updated_at)
  return value
}

/**
 * Merge every reachable source's Projects into one list. Projects whose normalized Git
 * URLs match become one `UnifiedProject` with a member per source (and, should one source
 * hold two Projects for the same repository, a member for each). Projects without a Git
 * URL are never merged. Members follow source order; the list is sorted by latest
 * activity, most recent first.
 */
export function mergeUnifiedSources(sources: UnifiedSource[]): UnifiedProject[] {
  const byKey = new Map<string, UnifiedProject>()

  for (const source of sources) {
    if (source.status !== 'ok') continue
    for (const entry of source.projects) {
      const repoKey = normalizeGitUrl(entry.project.git_url)
      const key = repoKey ?? `${source.sourceId}:${entry.project.id}`
      const member: UnifiedProjectMember = { ...entry, sourceId: source.sourceId, sourceLabel: source.label }
      const activity = memberActivity(entry)
      const existing = byKey.get(key)
      if (existing) {
        existing.members.push(member)
        existing.lastActivityAt = latest(existing.lastActivityAt, activity)
      } else {
        byKey.set(key, {
          key,
          name: entry.project.name,
          repoKey,
          gitUrl: entry.project.git_url,
          members: [member],
          lastActivityAt: activity,
        })
      }
    }
  }

  return [...byKey.values()].sort((a, b) =>
    new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()
    || a.name.localeCompare(b.name))
}
