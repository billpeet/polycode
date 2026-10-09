import type { LocalChannel } from '@polycode/shared'
import { isRemoteTransportError } from './remoteErrors'

// Explicitly opt in reads: channel names alone do not prove an operation is safe.
const REFRESH_CHANNELS = [
  'projects:list', 'projects:listArchived', 'locations:list', 'location-pools:list',
  'threads:list', 'threads:listQueue', 'threads:listArchived', 'threads:listSnoozed',
  'threads:archivedCount', 'threads:snoozedCount', 'sessions:list',
  'messages:list', 'messages:listBySession', 'slash-commands:list', 'skills:list',
  'youtrack:servers:list', 'commands:list', 'commands:getStatus', 'commands:getLogs',
  'commands:getPorts', 'commands:getPid', 'cli:health', 'subscription-usage:get',
  'threads:backgroundTerminals:list', 'routines:list', 'routines:listRuns',
] as const satisfies readonly LocalChannel[]

export type RefreshChannel = typeof REFRESH_CHANNELS[number]

const CLEANUP_CHANNELS = new Set<LocalChannel>([
  'git:watchStop', 'files:watchStop', 'browser:releaseSession',
])

/** Never swallow or retry a mutation: a timeout may have completed on the host. */
export function invokeWithTransportPolicy<T>(channel: LocalChannel, operation: () => Promise<T>): Promise<T> {
  // Keep the original promise/timing for normal invokes (watch coordinators depend on it).
  if (!CLEANUP_CHANNELS.has(channel)) return operation()
  const failed = (error: unknown): T => {
    // Cleanup cannot recover locally; leave a breadcrumb without an unhandled rejection.
    console.warn('IPC cleanup failed', { channel, outcome: isRemoteTransportError(error) ? 'remote-transport' : 'unexpected', error })
    return undefined as T // Cleanup contracts all return void.
  }
  try {
    return operation().catch(failed)
  } catch (error) {
    return Promise.resolve(failed(error))
  }
}

/** Only background reads may settle a transport failure; callers retain their cache. */
export async function refreshWithTransportPolicy<T>(channel: RefreshChannel, operation: () => Promise<T>): Promise<T | undefined> {
  if (!REFRESH_CHANNELS.includes(channel)) throw new Error(`Channel is not a background read: ${channel}`)
  try {
    return await operation()
  } catch (error) {
    if (isRemoteTransportError(error)) return undefined
    throw error
  }
}
