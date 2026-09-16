import type { RepoLocation } from '../types/ipc'

/**
 * The name a Project Location is shown under. A worktree is named after its
 * *current* branch: its stored label is only the opaque id it was created
 * with (or a user-supplied hint), and agents routinely move it off the
 * PolyCode-generated branch. Ordinary checkouts keep their configured label.
 */
export function locationDisplayName(location: RepoLocation, currentBranch?: string | null): string {
  if (location.is_worktree && currentBranch) return currentBranch
  return location.label
}
