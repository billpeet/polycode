import type { RepoLocation, Thread } from '@polycode/shared'

/** Tree/list label for a Project Location: `⎇` marks worktrees, `⚠` a worktree whose directory is gone. */
export function locationLabel(location: RepoLocation): string {
  const warning = location.is_worktree && location.worktree_valid === false ? '⚠ ' : ''
  return `${warning}${location.is_worktree ? '⎇ ' : ''}${location.label || location.path}`
}

/**
 * The location a new worktree is branched from: the first local, non-worktree
 * checkout. Worktrees can only be created from a local repo the host can
 * reach directly, so remote (SSH/WSL) locations never qualify.
 */
export function worktreeParent(locations: RepoLocation[]): RepoLocation | undefined {
  return locations.find((l) => l.connection_type === 'local' && !l.is_worktree)
}

export interface LocationThreads {
  /** Null collects Threads whose Location is unknown or gone. */
  location: RepoLocation | null
  threads: Thread[]
}

/**
 * Desktop parity for the tree: with several Locations (e.g. worktrees), Threads are
 * grouped under Location headers instead of one flat list. Returns null when there is
 * nothing to group by; empty Locations are left out.
 */
export function groupThreadsByLocation(locations: RepoLocation[] | undefined, threads: Thread[]): LocationThreads[] | null {
  if (!locations || locations.length <= 1) return null
  const byLocation = new Map<string, Thread[]>()
  const orphans: Thread[] = []
  for (const thread of threads) {
    if (thread.location_id && locations.some((l) => l.id === thread.location_id)) {
      const list = byLocation.get(thread.location_id) ?? []
      list.push(thread)
      byLocation.set(thread.location_id, list)
    } else {
      orphans.push(thread)
    }
  }
  const sections: LocationThreads[] = []
  for (const location of locations) {
    const list = byLocation.get(location.id)
    if (list && list.length > 0) sections.push({ location, threads: list })
  }
  if (orphans.length > 0) sections.push({ location: null, threads: orphans })
  return sections
}
