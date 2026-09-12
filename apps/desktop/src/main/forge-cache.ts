import type { SshConfig, WslConfig } from '../shared/types'

export function forgeScope(repoPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): string {
  return JSON.stringify([repoPath, ssh
    ? ['ssh', ssh.host, ssh.user, ssh.port ?? 22, ssh.keyPath ?? '']
    : wsl ? ['wsl', wsl.distro] : ['local']])
}

/** A replaced/invalidated entry can never repopulate the cache when it settles. */
export class ForgeCache {
  private entries = new Map<string, { promise: Promise<unknown>; expiresAt: number }>()

  read<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.promise as Promise<T>
    const entry = { promise: Promise.resolve().then(load), expiresAt: Infinity }
    this.entries.set(key, entry)
    entry.promise.then(() => {
      entry.expiresAt = Date.now() + ttlMs
      if (ttlMs === 0 && this.entries.get(key) === entry) this.entries.delete(key)
    }, () => {
      if (this.entries.get(key) === entry) this.entries.delete(key)
    })
    return entry.promise
  }

  clear(): void { this.entries.clear() }
}

export const repoContextCache = new ForgeCache()
export const forgeReadCache = new ForgeCache()

// Remote configuration is shared by worktrees. Remote edits are rare, so clear
// all scopes rather than spawning Git to discover their common directory.
export function invalidateForgeRemotes(): void {
  repoContextCache.clear()
  forgeReadCache.clear()
}
