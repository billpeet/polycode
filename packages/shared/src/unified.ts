import type { LocationPool, Project, RepoLocation, Thread } from './types'

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
