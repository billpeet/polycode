import { useEffect, useMemo } from 'react'
import { GitBranchPlus, MapPin } from 'lucide-react'
import { useLocationStore } from '../../stores/locations'
import { useProjectStore } from '../../stores/projects'
import { useThreadStore } from '../../stores/threads'
import { RepoLocation, Thread } from '../../types/ipc'

const NEW_WORKTREE_PREFIX = 'new-worktree:'

/** Active = usable for a new thread: unpooled, or checked out of its pool. */
function isActiveLocation(location: RepoLocation): boolean {
  return !location.pool_id || location.checked_out
}

/**
 * Orders locations parent-first with each parent's worktrees directly under
 * it, so the cascading picker reads as a shallow tree.
 */
function orderLocations(locations: RepoLocation[]): RepoLocation[] {
  const parents = locations.filter((l) => !l.is_worktree)
  const ordered: RepoLocation[] = []
  for (const parent of parents) {
    ordered.push(parent)
    for (const worktree of locations.filter((l) => l.is_worktree && l.parent_location_id === parent.id)) {
      ordered.push(worktree)
    }
  }
  // Orphaned worktrees (parent deleted) still need to be reachable.
  for (const worktree of locations.filter((l) => l.is_worktree && !parents.some((p) => p.id === l.parent_location_id))) {
    ordered.push(worktree)
  }
  return ordered
}

const selectStyle = {
  background: 'var(--color-surface-2)',
  border: '1px solid var(--color-border)',
  color: 'var(--color-text-muted)',
} as const

/**
 * Where the create-on-send draft will materialize: project, then
 * location/worktree — including "New worktree of …", which is only created
 * when the first message is sent. Rendered as two minimal selects in the
 * composer row, beside the send button.
 */
export default function DestinationPicker({ draftThread }: { draftThread: Thread }) {
  const projects = useProjectStore((s) => s.projects)
  const locationsByProject = useLocationStore((s) => s.byProject)
  const fetchLocations = useLocationStore((s) => s.fetch)
  const draftNewWorktree = useThreadStore((s) => s.draftNewWorktree)
  const setDestination = useThreadStore((s) => s.setDraftThreadDestination)

  const projectId = draftThread.project_id
  const locations = useMemo(
    () => orderLocations((locationsByProject[projectId] ?? []).filter(isActiveLocation)),
    [locationsByProject, projectId]
  )

  useEffect(() => {
    if (!locationsByProject[projectId]) void fetchLocations(projectId)
  }, [projectId, locationsByProject, fetchLocations])

  const locationValue = draftNewWorktree
    ? `${NEW_WORKTREE_PREFIX}${draftThread.location_id ?? ''}`
    : draftThread.location_id ?? ''

  async function handleProjectChange(nextProjectId: string): Promise<void> {
    const known = useLocationStore.getState().byProject[nextProjectId]
    let nextLocations = known
    if (!nextLocations) {
      await fetchLocations(nextProjectId)
      nextLocations = useLocationStore.getState().byProject[nextProjectId] ?? []
    }
    const firstActive = nextLocations.filter(isActiveLocation).find((l) => !l.is_worktree)
      ?? nextLocations.filter(isActiveLocation)[0]
    if (firstActive) {
      setDestination(nextProjectId, firstActive.id)
    }
  }

  function handleLocationChange(value: string): void {
    if (value.startsWith(NEW_WORKTREE_PREFIX)) {
      setDestination(projectId, value.slice(NEW_WORKTREE_PREFIX.length), { newWorktree: true })
    } else {
      setDestination(projectId, value)
    }
  }

  return (
    <div
      className="flex h-9 flex-shrink-0 items-center gap-1 text-[11px]"
      style={{ color: 'var(--color-text-muted)' }}
      title={draftNewWorktree ? 'New thread in a new worktree' : 'New thread destination'}
    >
      {draftNewWorktree
        ? <GitBranchPlus size={13} className="mr-0.5 flex-shrink-0 opacity-60" />
        : <MapPin size={13} className="mr-0.5 flex-shrink-0 opacity-60" />}
      <select
        value={projectId}
        onChange={(e) => void handleProjectChange(e.target.value)}
        className="h-6 max-w-[110px] cursor-pointer rounded px-1 outline-none"
        style={selectStyle}
        title="Project"
      >
        {projects.map((project) => (
          <option key={project.id} value={project.id}>{project.name}</option>
        ))}
        {!projects.some((p) => p.id === projectId) && (
          <option value={projectId}>Unknown project</option>
        )}
      </select>
      <select
        value={locationValue}
        onChange={(e) => handleLocationChange(e.target.value)}
        className="h-6 max-w-[130px] cursor-pointer rounded px-1 outline-none"
        style={selectStyle}
        title="Location or worktree"
      >
        {locations.map((location) => (
          <option key={location.id} value={location.id}>
            {location.is_worktree ? `↳ ${location.label}` : location.label}
          </option>
        ))}
        {locations.filter((l) => !l.is_worktree && l.connection_type === 'local').map((location) => (
          <option key={`${NEW_WORKTREE_PREFIX}${location.id}`} value={`${NEW_WORKTREE_PREFIX}${location.id}`}>
            + New worktree of {location.label}
          </option>
        ))}
        {locations.length === 0 && (
          <option value="" disabled>No locations available</option>
        )}
      </select>
    </div>
  )
}
