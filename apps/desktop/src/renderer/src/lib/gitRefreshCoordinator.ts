import { useGitStore } from '../stores/git'

const STATUS_FALLBACK_INTERVAL_MS = 5 * 60_000
const REMOTE_INTERVAL_MS = 60_000
const REMOTE_STAGGER_MS = 30_000
const WATCH_DEBOUNCE_MS = 750

type Subscriber = { includeRemote: boolean }
type RepositoryEntry = {
  path: string
  subscribers: Map<symbol, Subscriber>
  statusTimer: number | null
  remoteTimer: number | null
  remoteStartTimer: number | null
  watchDebounceTimer: number | null
  watching: boolean
}

const repositories = new Map<string, RepositoryEntry>()
let activeRepositoryKey: string | null = null

function repositoryKey(repoPath: string): string {
  const normalized = repoPath.replace(/\\/g, '/').replace(/\/+$/, '')
  return navigator.platform.startsWith('Win') ? normalized.toLowerCase() : normalized
}

function isPageVisible(): boolean {
  return document.visibilityState === 'visible'
}

function isActive(entry: RepositoryEntry): boolean {
  return activeRepositoryKey === repositoryKey(entry.path) && entry.subscribers.size > 0
}

function refreshStatus(entry: RepositoryEntry): void {
  if (!isPageVisible() || !isActive(entry)) return
  void useGitStore.getState().fetch(entry.path)
}

async function refreshRemote(entry: RepositoryEntry): Promise<void> {
  if (!isPageVisible() || !isActive(entry)) return
  // refreshRemote fetches status after the network operation, keeping the two expensive jobs serial.
  await useGitStore.getState().refreshRemote(entry.path)
}

function clearEntryTimers(entry: RepositoryEntry): void {
  if (entry.statusTimer !== null) window.clearInterval(entry.statusTimer)
  if (entry.remoteTimer !== null) window.clearInterval(entry.remoteTimer)
  if (entry.remoteStartTimer !== null) window.clearTimeout(entry.remoteStartTimer)
  if (entry.watchDebounceTimer !== null) window.clearTimeout(entry.watchDebounceTimer)
  entry.statusTimer = null
  entry.remoteTimer = null
  entry.remoteStartTimer = null
  entry.watchDebounceTimer = null
}

function updateTimers(entry: RepositoryEntry): void {
  clearEntryTimers(entry)
  if (!isActive(entry)) return

  entry.statusTimer = window.setInterval(() => refreshStatus(entry), STATUS_FALLBACK_INTERVAL_MS)
  const needsRemote = [...entry.subscribers.values()].some((subscriber) => subscriber.includeRemote)
  if (needsRemote) {
    entry.remoteStartTimer = window.setTimeout(() => {
      entry.remoteStartTimer = null
      void refreshRemote(entry)
      entry.remoteTimer = window.setInterval(() => void refreshRemote(entry), REMOTE_INTERVAL_MS)
    }, REMOTE_STAGGER_MS)
  }
}

async function startWatch(entry: RepositoryEntry): Promise<void> {
  try {
    entry.watching = await window.api.invoke('git:watchStart', entry.path)
  } catch {
    entry.watching = false
  }
}

function stopWatch(entry: RepositoryEntry): void {
  if (!entry.watching) return
  entry.watching = false
  void window.api.invoke('git:watchStop', entry.path)
}

function activate(key: string): void {
  if (activeRepositoryKey === key) return
  const previous = activeRepositoryKey ? repositories.get(activeRepositoryKey) : null
  activeRepositoryKey = key
  if (previous) {
    clearEntryTimers(previous)
    stopWatch(previous)
  }
  const entry = repositories.get(key)
  if (!entry) return
  updateTimers(entry)
  void startWatch(entry)
  refreshStatus(entry)
}

/** Subscribe the currently selected repository to shared status and optional remote refreshes. */
export function subscribeToGitRefresh(repoPath: string, options?: { includeRemote?: boolean }): () => void {
  const key = repositoryKey(repoPath)
  const token = Symbol(key)
  let entry = repositories.get(key)

  if (!entry) {
    entry = {
      path: repoPath,
      subscribers: new Map(),
      statusTimer: null,
      remoteTimer: null,
      remoteStartTimer: null,
      watchDebounceTimer: null,
      watching: false,
    }
    repositories.set(key, entry)
  }

  entry.subscribers.set(token, { includeRemote: options?.includeRemote ?? false })
  if (activeRepositoryKey === key) updateTimers(entry)
  else activate(key)

  return () => {
    const current = repositories.get(key)
    if (!current) return
    current.subscribers.delete(token)
    if (current.subscribers.size > 0) {
      if (activeRepositoryKey === key) updateTimers(current)
      return
    }
    clearEntryTimers(current)
    stopWatch(current)
    repositories.delete(key)
    if (activeRepositoryKey === key) activeRepositoryKey = null
  }
}

window.api.on('git:repoChanged', (...args) => {
  const event = args[0] as { path?: string }
  if (!event.path) return
  const entry = repositories.get(repositoryKey(event.path))
  if (!entry || !isActive(entry)) return
  if (entry.watchDebounceTimer !== null) window.clearTimeout(entry.watchDebounceTimer)
  entry.watchDebounceTimer = window.setTimeout(() => {
    entry.watchDebounceTimer = null
    refreshStatus(entry)
  }, WATCH_DEBOUNCE_MS)
})

document.addEventListener('visibilitychange', () => {
  if (!isPageVisible() || !activeRepositoryKey) return
  const entry = repositories.get(activeRepositoryKey)
  if (entry) refreshStatus(entry)
})
