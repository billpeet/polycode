import { useGitStore } from '../stores/git'

const STATUS_INTERVAL_MS = 10_000
const REMOTE_INTERVAL_MS = 60_000

type Subscriber = { includeRemote: boolean }
type RepositoryEntry = {
  path: string
  subscribers: Map<symbol, Subscriber>
  statusTimer: number | null
  remoteTimer: number | null
}

const repositories = new Map<string, RepositoryEntry>()

function repositoryKey(repoPath: string): string {
  const normalized = repoPath.replace(/\\/g, '/').replace(/\/+$/, '')
  return navigator.platform.startsWith('Win') ? normalized.toLowerCase() : normalized
}

function isPageVisible(): boolean {
  return document.visibilityState === 'visible'
}

function refreshStatus(entry: RepositoryEntry): void {
  if (!isPageVisible()) return
  void useGitStore.getState().fetch(entry.path)
}

function refreshRemote(entry: RepositoryEntry): void {
  if (!isPageVisible()) return
  void useGitStore.getState().refreshRemote(entry.path)
}

function updateTimers(entry: RepositoryEntry): void {
  if (entry.statusTimer === null) {
    entry.statusTimer = window.setInterval(() => refreshStatus(entry), STATUS_INTERVAL_MS)
  }

  const needsRemoteTimer = [...entry.subscribers.values()].some((subscriber) => subscriber.includeRemote)
  if (needsRemoteTimer && entry.remoteTimer === null) {
    entry.remoteTimer = window.setInterval(() => refreshRemote(entry), REMOTE_INTERVAL_MS)
  } else if (!needsRemoteTimer && entry.remoteTimer !== null) {
    window.clearInterval(entry.remoteTimer)
    entry.remoteTimer = null
  }
}

/** Subscribe a visible component to shared, per-repository git refreshes. */
export function subscribeToGitRefresh(repoPath: string, options?: { includeRemote?: boolean }): () => void {
  const key = repositoryKey(repoPath)
  const token = Symbol(key)
  let entry = repositories.get(key)

  if (!entry) {
    entry = { path: repoPath, subscribers: new Map(), statusTimer: null, remoteTimer: null }
    repositories.set(key, entry)
  }

  entry.subscribers.set(token, { includeRemote: options?.includeRemote ?? false })
  updateTimers(entry)
  refreshStatus(entry)

  return () => {
    const current = repositories.get(key)
    if (!current) return
    current.subscribers.delete(token)
    if (current.subscribers.size === 0) {
      if (current.statusTimer !== null) window.clearInterval(current.statusTimer)
      if (current.remoteTimer !== null) window.clearInterval(current.remoteTimer)
      repositories.delete(key)
      return
    }
    updateTimers(current)
  }
}

document.addEventListener('visibilitychange', () => {
  if (!isPageVisible()) return
  for (const entry of repositories.values()) refreshStatus(entry)
})
