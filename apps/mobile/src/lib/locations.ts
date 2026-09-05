import type { RepoLocation } from '@polycode/shared'

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
