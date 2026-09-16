import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, GitBranchPlus, GitPullRequest, MapPin } from 'lucide-react'
import { client } from '../../lib/client'
import { useLocationStore } from '../../stores/locations'
import { sortProjects, useProjectStore } from '../../stores/projects'
import { useThreadStore } from '../../stores/threads'
import { PullRequest, RepoLocation, Thread } from '../../types/ipc'
import ProjectFavicon from '../ProjectFavicon'

const NEW_WORKTREE_PREFIX = 'new-worktree:'
const PULL_REQUEST_PREFIX = 'pr:'

/** Active = usable for a new thread: unpooled, or checked out of its pool. */
function isActiveLocation(location: RepoLocation): boolean {
  return !location.pool_id || location.checked_out
}

/** A worktree can only be forked from a local main checkout. */
function canForkWorktree(location: RepoLocation): boolean {
  return !location.is_worktree && location.connection_type === 'local'
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

function pullRequestValue(parentLocationId: string, prId: number): string {
  return `${PULL_REQUEST_PREFIX}${parentLocationId}:${prId}`
}

function parsePullRequestValue(value: string): { parentLocationId: string; prId: number } | null {
  if (!value.startsWith(PULL_REQUEST_PREFIX)) return null
  const separator = value.lastIndexOf(':')
  const parentLocationId = value.slice(PULL_REQUEST_PREFIX.length, separator)
  const prId = Number(value.slice(separator + 1))
  return parentLocationId && Number.isInteger(prId) ? { parentLocationId, prId } : null
}

const controlStyle = {
  background: 'var(--color-surface-2)',
  border: '1px solid var(--color-border)',
  color: 'var(--color-text-muted)',
} as const

const HOVER_BG = 'rgba(255,255,255,0.06)'
const ACTIVE_BG = 'rgba(232, 123, 95, 0.14)'

/**
 * Project dropdown with favicons, alphabetical. A native `<select>` cannot
 * render images in its options, hence the custom popover.
 */
function ProjectMenu({ projectId, onSelect }: { projectId: string; onSelect: (projectId: string) => void }) {
  const projects = useProjectStore((s) => s.projects)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const options = useMemo(
    () => sortProjects(projects.filter((p) => !p.archived_at || p.id === projectId), 'alphabetical'),
    [projects, projectId]
  )
  const current = projects.find((p) => p.id === projectId)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex h-6 max-w-[150px] cursor-pointer items-center gap-1.5 rounded px-1.5 outline-none"
        style={controlStyle}
        title="Project"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <ProjectFavicon projectId={projectId} className="h-3.5 w-3.5" />
        <span className="truncate">{current?.name ?? 'Unknown project'}</span>
        <ChevronDown size={12} className="flex-shrink-0 opacity-60" aria-hidden />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Project"
          className="absolute bottom-full left-0 z-50 mb-1 max-h-72 w-56 overflow-y-auto rounded-md p-1 shadow-lg"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
        >
          {options.map((project) => {
            const selected = project.id === projectId
            return (
              <button
                key={project.id}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  setOpen(false)
                  if (!selected) onSelect(project.id)
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px]"
                style={{ background: selected ? ACTIVE_BG : undefined, color: selected ? 'var(--color-claude)' : 'var(--color-text)' }}
                onMouseEnter={(event) => { if (!selected) event.currentTarget.style.background = HOVER_BG }}
                onMouseLeave={(event) => { if (!selected) event.currentTarget.style.background = '' }}
              >
                <ProjectFavicon projectId={project.id} className="h-4 w-4" />
                <span className="truncate">{project.name}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Open Pull Requests for every local main checkout of the project, keyed by
 * parent location id. Forge failures (no remote, not signed in) simply yield
 * no PR entries; the picker stays usable without them.
 */
function useOpenPullRequests(parents: RepoLocation[]): Record<string, PullRequest[]> {
  // Keyed by id and path so a location that moves on disk refetches rather than
  // reusing the old repository's list. Stale keys are simply never read.
  const [byKey, setByKey] = useState<Record<string, PullRequest[]>>({})
  const parentsKey = parents.map((p) => `${p.id}::${p.path}`).join('|')

  useEffect(() => {
    let cancelled = false
    for (const parent of parents) {
      const key = `${parent.id}::${parent.path}`
      void client.invoke('forge:pr:list', parent.path)
        .then((prs) => {
          if (!cancelled) setByKey((prev) => ({ ...prev, [key]: prs }))
        })
        .catch(() => undefined)
    }
    return () => { cancelled = true }
    // parentsKey captures every identity the fetch depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentsKey])

  return useMemo(
    () => Object.fromEntries(parents.map((p) => [p.id, byKey[`${p.id}::${p.path}`] ?? []])),
    [parents, byKey]
  )
}

/**
 * Where the create-on-send draft will materialize: project, then
 * location/worktree — including "New worktree of …" and "PR #n", which only
 * come into existence (worktree forked, PR checked out) when the first message
 * is sent. Rendered as two minimal controls in the composer row, beside the
 * send button.
 */
export default function DestinationPicker({ draftThread }: { draftThread: Thread }) {
  const locationsByProject = useLocationStore((s) => s.byProject)
  const fetchLocations = useLocationStore((s) => s.fetch)
  const draftNewWorktree = useThreadStore((s) => s.draftNewWorktree)
  const draftPullRequest = useThreadStore((s) => s.draftPullRequest)
  const setDestination = useThreadStore((s) => s.setDraftThreadDestination)

  const projectId = draftThread.project_id
  const locations = useMemo(
    () => orderLocations((locationsByProject[projectId] ?? []).filter(isActiveLocation)),
    [locationsByProject, projectId]
  )
  const forkableParents = useMemo(() => locations.filter(canForkWorktree), [locations])
  const pullRequestsByLocation = useOpenPullRequests(forkableParents)

  useEffect(() => {
    if (!locationsByProject[projectId]) void fetchLocations(projectId)
  }, [projectId, locationsByProject, fetchLocations])

  const locationValue = draftPullRequest
    ? pullRequestValue(draftThread.location_id ?? '', draftPullRequest.id)
    : draftNewWorktree
      ? `${NEW_WORKTREE_PREFIX}${draftThread.location_id ?? ''}`
      : draftThread.location_id ?? ''

  // The selected PR may not be in the (re)fetched list yet; keep it selectable
  // so the control never silently falls back to another option.
  const selectedPullRequestListed = !!draftPullRequest && !!draftThread.location_id
    && (pullRequestsByLocation[draftThread.location_id] ?? []).some((pr) => pr.id === draftPullRequest.id)

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
    const pullRequestRef = parsePullRequestValue(value)
    if (pullRequestRef) {
      const pr = (pullRequestsByLocation[pullRequestRef.parentLocationId] ?? []).find((entry) => entry.id === pullRequestRef.prId)
      if (pr) setDestination(projectId, pullRequestRef.parentLocationId, { pullRequest: { id: pr.id, title: pr.title } })
    } else if (value.startsWith(NEW_WORKTREE_PREFIX)) {
      setDestination(projectId, value.slice(NEW_WORKTREE_PREFIX.length), { newWorktree: true })
    } else {
      setDestination(projectId, value)
    }
  }

  const title = draftPullRequest
    ? `New thread in a new worktree with PR #${draftPullRequest.id} checked out`
    : draftNewWorktree
      ? 'New thread in a new worktree'
      : 'New thread destination'

  return (
    <div
      className="flex h-9 flex-shrink-0 items-center gap-1 text-[11px]"
      style={{ color: 'var(--color-text-muted)' }}
      title={title}
    >
      {draftPullRequest
        ? <GitPullRequest size={13} className="mr-0.5 flex-shrink-0 opacity-60" />
        : draftNewWorktree
          ? <GitBranchPlus size={13} className="mr-0.5 flex-shrink-0 opacity-60" />
          : <MapPin size={13} className="mr-0.5 flex-shrink-0 opacity-60" />}
      <ProjectMenu projectId={projectId} onSelect={(next) => void handleProjectChange(next)} />
      <select
        value={locationValue}
        onChange={(e) => handleLocationChange(e.target.value)}
        className="h-6 max-w-[150px] cursor-pointer rounded px-1 outline-none"
        style={controlStyle}
        title="Location, worktree or pull request"
      >
        {locations.map((location) => (
          <option key={location.id} value={location.id}>
            {location.is_worktree ? `↳ ${location.label}` : location.label}
          </option>
        ))}
        {forkableParents.map((location) => (
          <option key={`${NEW_WORKTREE_PREFIX}${location.id}`} value={`${NEW_WORKTREE_PREFIX}${location.id}`}>
            + New worktree of {location.label}
          </option>
        ))}
        {forkableParents.map((location) => {
          const prs = pullRequestsByLocation[location.id] ?? []
          if (prs.length === 0) return null
          return (
            <optgroup key={`prs:${location.id}`} label={forkableParents.length > 1 ? `Open pull requests · ${location.label}` : 'Open pull requests'}>
              {prs.map((pr) => (
                <option key={pr.id} value={pullRequestValue(location.id, pr.id)}>
                  #{pr.id} {pr.title}
                </option>
              ))}
            </optgroup>
          )
        })}
        {draftPullRequest && !selectedPullRequestListed && (
          <option value={locationValue}>#{draftPullRequest.id} {draftPullRequest.title}</option>
        )}
        {locations.length === 0 && (
          <option value="" disabled>No locations available</option>
        )}
      </select>
    </div>
  )
}
