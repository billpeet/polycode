/**
 * RunWorktrees adapter over project-admin's worktree provisioning and the
 * locations table. Owns the "directory the session actually runs in"
 * translation (WSL paths) so the lifecycle never sees transport details.
 */
import { RepoLocation } from '../../../shared/types'
import { getLocationById } from '../../db/queries'
import { createLocalWorktree, removeWorktreeLocation } from '../../project-admin'
import { windowsPathToWsl } from '../../path-utils'
import { RunWorktrees, WorktreeInfo } from '../types'

function toInfo(location: RepoLocation): WorktreeInfo {
  let effectiveDir = location.path
  if (location.connection_type === 'wsl' && /^[A-Za-z]:[/\\]/.test(effectiveDir)) {
    effectiveDir = windowsPathToWsl(effectiveDir)
  }
  return {
    locationId: location.id,
    path: location.path,
    effectiveDir,
    ssh: location.ssh ?? null,
    wsl: location.wsl ?? null,
  }
}

export function createRunWorktrees(): RunWorktrees {
  return {
    parent(locationId) {
      const location = getLocationById(locationId)
      return location ? { path: location.path, connectionType: location.connection_type } : null
    },

    async create(parentLocationId, label, baseRef) {
      return toInfo(await createLocalWorktree(parentLocationId, label, baseRef))
    },

    get(locationId) {
      const location = getLocationById(locationId)
      return location?.is_worktree ? toInfo(location) : null
    },

    remove(locationId) {
      return removeWorktreeLocation(locationId)
    },
  }
}
