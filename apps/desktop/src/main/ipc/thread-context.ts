/**
 * Resolving a Thread or a repo path to the context a handler needs:
 * which host it runs on (SSH / WSL / local), where its working directory is,
 * and the two policy checks that guard destructive work.
 *
 * Both transport adapters (`ipc/handlers.ts` and `control/control-rpc.ts`) previously
 * carried byte-identical private copies of every function here. They are shared so the
 * two paths cannot drift.
 */
import { existsSync } from 'fs'
import { getLocationForThread, getLocationByPath, getProjectById, getThreadWsl } from '../db/queries'
import { getCachedGitStatus, invalidateGitCache } from '../git'
import { windowsPathToWsl } from '../path-utils'
import type { SshConfig, WslConfig } from '../../shared/types'

export { windowsPathToWsl }

/** Get SSH config from the thread's linked repo location. */
export function getSshConfigForThread(threadId: string): SshConfig | null {
  const location = getLocationForThread(threadId)
  return location?.ssh ?? null
}

/** Get WSL config from the thread's linked repo location, or thread-level WSL override for local locations. */
export function getWslConfigForThread(threadId: string): WslConfig | null {
  const location = getLocationForThread(threadId)
  // If the location is local and the thread has use_wsl enabled, use thread-level WSL config
  if (location && location.connection_type === 'local') {
    const threadWsl = getThreadWsl(threadId)
    if (threadWsl.use_wsl && threadWsl.wsl_distro) {
      return { distro: threadWsl.wsl_distro }
    }
  }
  return location?.wsl ?? null
}

/** Get the working directory from the thread's linked repo location. */
export function getWorkingDirForThread(threadId: string): string | null {
  const location = getLocationForThread(threadId)
  return location?.path ?? null
}

/**
 * Return the effective working directory for a thread.
 * For WSL locations with a Windows-style path, convert to /mnt/... format.
 */
export function getEffectiveWorkingDir(threadId: string): string {
  const location = getLocationForThread(threadId)
  if (!location) return ''
  if (location.connection_type === 'wsl' && /^[A-Za-z]:[/\\]/.test(location.path)) {
    return windowsPathToWsl(location.path)
  }
  // Thread-level WSL override for local locations: convert Windows path to /mnt/...
  if (location.connection_type === 'local' && /^[A-Za-z]:[/\\]/.test(location.path)) {
    const threadWsl = getThreadWsl(threadId)
    if (threadWsl.use_wsl) {
      return windowsPathToWsl(location.path)
    }
  }
  return location.path
}

/**
 * Returns an error message if the thread's local working directory doesn't exist,
 * or null if it's fine (or is SSH/WSL where we can't check locally).
 *
 * Policy, not plumbing: this is the precondition before starting or sending to a session.
 */
export function getLocalPathError(threadId: string): string | null {
  const location = getLocationForThread(threadId)
  if (!location) return null
  if (location.connection_type !== 'local') return null
  if (!existsSync(location.path)) {
    return `Directory not found: "${location.path}". Update the location path or restore the directory.`
  }
  return null
}

/** Look up SSH/WSL config for a given path by searching repo_locations. */
export function getConfigForPath(path: string): { ssh: SshConfig | null; wsl: WslConfig | null } {
  const location = getLocationByPath(path)
  return { ssh: location?.ssh ?? null, wsl: location?.wsl ?? null }
}

/**
 * Invalidate a repo's git cache when all you have is its path.
 *
 * It used to be the trailing line of 24 `git:*` handlers; every `git.ts` mutation now
 * invalidates its own scope, so three consumers are left, and all three genuinely lack the
 * `ssh`/`wsl` pair that this function's `getLocationByPath` recovers:
 *
 * - `git:watchStart` passes it as a **callback** to `startRepoGitWatch`. The watcher fires it
 *   on every filesystem change it sees, from outside any git operation, so there is no call
 *   site that could hold a host config. This is the reason the helper still exists.
 * - `forge:pr:checkout` — the mutation is a forge adapter method, not a `git.ts` function.
 * - `git:publishBranch`'s `finally` — a composite whose steps each self-invalidate; see the
 *   note on that handler for why the belt-and-braces call is kept.
 */
export function invalidateRepoGitCache(repoPath: string): void {
  const { ssh, wsl } = getConfigForPath(repoPath)
  invalidateGitCache(repoPath, ssh, wsl)
}

/**
 * Policy, not plumbing: blocks commits on `main`/`master` unless the project opts in.
 */
export async function assertMainBranchCommitAllowed(repoPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<void> {
  const location = getLocationByPath(repoPath)
  if (!location) return
  const project = getProjectById(location.project_id)
  if (!project || project.allow_main_branch_commits) return

  const status = await getCachedGitStatus(repoPath, ssh, wsl)
  if (status?.branch === 'main' || status?.branch === 'master') {
    throw new Error(`Commits are disabled on ${status.branch} for this project`)
  }
}
