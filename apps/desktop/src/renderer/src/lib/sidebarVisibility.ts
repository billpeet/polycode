import type { RepoLocation } from '../types/ipc'

export interface CommandInstance {
  key: string
  projectId: string
  commandId: string
  locationId: string
}

/**
 * Every Project Location under an expanded Project, in sidebar order.
 *
 * The location store replaces `byProject` by identity on every write (create, remove,
 * worktree add/remove, checkout…), so effects that depended on the object re-ran their
 * whole IPC sweep — command statuses × locations, `pathExists` × locations, branch
 * subscriptions — on every unrelated mutation. Grafana caught a worktree removal firing
 * 27 `commands:getStatus` + 4 `pathExists` at once and a 2s renderer long task behind it.
 * Callers pair this with `visibleLocationsKey` so effects only re-run when the *visible set*
 * actually changes.
 */
export function collectVisibleLocations(
  expandedProjectIds: Iterable<string>,
  locationsByProject: Record<string, RepoLocation[] | undefined>,
): RepoLocation[] {
  const result: RepoLocation[] = []
  for (const projectId of expandedProjectIds) {
    for (const location of locationsByProject[projectId] ?? []) result.push(location)
  }
  return result
}

/** Identity-free fingerprint of a visible location set: same set → same string. */
export function visibleLocationsKey(locations: RepoLocation[]): string {
  return locations.map((l) => `${l.id}\u0000${l.connection_type}\u0000${l.path}`).join('\u0001')
}

export function collectCommandInstances(
  expandedProjectIds: Iterable<string>,
  commandByProject: Record<string, Array<{ id: string }> | undefined>,
  locationsByProject: Record<string, RepoLocation[] | undefined>,
  instKey: (commandId: string, locationId: string) => string,
): CommandInstance[] {
  const result: CommandInstance[] = []
  for (const projectId of expandedProjectIds) {
    const commands = commandByProject[projectId] ?? []
    const locations = locationsByProject[projectId] ?? []
    if (commands.length === 0 || locations.length === 0) continue
    for (const location of locations) {
      for (const command of commands) {
        result.push({ key: instKey(command.id, location.id), projectId, commandId: command.id, locationId: location.id })
      }
    }
  }
  return result
}

export function commandInstancesKey(instances: CommandInstance[]): string {
  return instances.map((i) => i.key).join('\u0001')
}
