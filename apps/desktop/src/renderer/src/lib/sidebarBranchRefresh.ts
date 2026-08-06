const BRANCH_SWEEP_INTERVAL_MS = 120_000
const MAX_BRANCH_WORKERS = 2

type Location = { id: string; path: string }
type Subscriber = (branches: Map<string, string | null>) => void

const locationsBySubscriber = new Map<symbol, Location[]>()
const subscribers = new Map<symbol, Subscriber>()
const invalidatedPaths = new Set<string>()
const branchByPath = new Map<string, string | null>()
let sweep: Promise<void> | null = null
let timer: number | null = null

function repositoryKey(repoPath: string): string {
  const normalized = repoPath.replace(/\\/g, '/').replace(/\/+$/, '')
  return navigator.platform.startsWith('Win') ? normalized.toLowerCase() : normalized
}

function visibleLocations(): Location[] {
  const unique = new Map<string, Location>()
  for (const locations of locationsBySubscriber.values()) {
    for (const location of locations) unique.set(repositoryKey(location.path), location)
  }
  return [...unique.values()]
}

function notifySubscribers(): void {
  for (const [token, subscriber] of subscribers) {
    const result = new Map<string, string | null>()
    for (const location of locationsBySubscriber.get(token) ?? []) {
      const key = repositoryKey(location.path)
      if (branchByPath.has(key)) result.set(location.id, branchByPath.get(key) ?? null)
    }
    subscriber(result)
  }
}

function runSweep(forceAll = false): Promise<void> {
  // Interval ticks and invalidations coalesce into the current sweep instead of adding workers.
  if (sweep) return sweep
  if (document.visibilityState !== 'visible') return Promise.resolve()

  const locations = visibleLocations().filter((location) => {
    const key = repositoryKey(location.path)
    return forceAll || invalidatedPaths.has(key) || !branchByPath.has(key)
  })
  if (locations.length === 0) return Promise.resolve()

  const queue = [...locations]
  sweep = (async () => {
    const workers = Array.from({ length: Math.min(MAX_BRANCH_WORKERS, queue.length) }, async () => {
      while (queue.length > 0) {
        const location = queue.shift()
        if (!location) return
        const key = repositoryKey(location.path)
        invalidatedPaths.delete(key)
        try {
          const branch = await window.api.invoke('git:branch', location.path)
          branchByPath.set(key, branch || null)
        } catch {
          branchByPath.set(key, null)
        }
      }
    })
    await Promise.all(workers)
    notifySubscribers()
  })().finally(() => {
    sweep = null
    if (invalidatedPaths.size > 0) void runSweep()
  })
  return sweep
}

function updateTimer(): void {
  if (subscribers.size > 0 && timer === null) {
    timer = window.setInterval(() => void runSweep(true), BRANCH_SWEEP_INTERVAL_MS)
  } else if (subscribers.size === 0 && timer !== null) {
    window.clearInterval(timer)
    timer = null
  }
}

/** Register the locations whose branch labels are currently rendered in the expanded sidebar. */
export function subscribeToSidebarBranches(locations: Location[], subscriber: Subscriber): () => void {
  const token = Symbol('sidebar-branches')
  locationsBySubscriber.set(token, locations)
  subscribers.set(token, subscriber)
  updateTimer()
  void runSweep()

  return () => {
    locationsBySubscriber.delete(token)
    subscribers.delete(token)
    updateTimer()
  }
}

/** Refresh a branch label after an operation known to have changed repository state. */
export function invalidateSidebarBranch(repoPath: string): void {
  invalidatedPaths.add(repositoryKey(repoPath))
  void runSweep()
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void runSweep(true)
})
