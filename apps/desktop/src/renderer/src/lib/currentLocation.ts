import type { RepoLocation, Thread } from '../types/ipc'

/** Resolve the location commands should target from the thread currently in view. */
export function getCurrentLocationId(
  threads: Thread[],
  selectedThreadId: string | null,
  locations: RepoLocation[],
): string | null {
  const selectedLocationId = threads.find((thread) => thread.id === selectedThreadId)?.location_id
  if (selectedLocationId && locations.some((location) => location.id === selectedLocationId)) {
    return selectedLocationId
  }

  return locations.find((location) => !location.pool_id || location.checked_out)?.id ?? null
}
