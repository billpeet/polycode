import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, GitBranchPlus, GitPullRequest, MapPin } from 'lucide-react'
import { client } from '../../lib/client'
import { locationDisplayName } from '../../lib/locationDisplay'
import { subscribeToSidebarBranches } from '../../lib/sidebarBranchRefresh'
import { useLocationStore } from '../../stores/locations'
import { sortProjects, useProjectStore } from '../../stores/projects'
import { useThreadStore } from '../../stores/threads'
import { PullRequest, RepoLocation, Thread } from '../../types/ipc'
import ProjectFavicon from '../ProjectFavicon'
import type { UnifiedProject, UnifiedProjectMember } from '@polycode/shared'
import { sourceKey, useUnifiedStore } from '../../stores/unified'
import { SourceBadge, sourceColor, useActiveSource } from '../SourceBadge'
import SourceProjectFavicon from '../SourceProjectFavicon'

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
 * Current branch of each worktree in the list. Worktrees are named after
 * their branch, so the picker shares the sidebar's branch sweep rather than
 * showing the opaque label they were created with.
 */
function useWorktreeBranches(locations: RepoLocation[]): Record<string, string> {
  const [branchByLocation, setBranchByLocation] = useState<Record<string, string>>({})
  const worktrees = useMemo(() => locations.filter((l) => l.is_worktree), [locations])
  useEffect(() => {
    if (worktrees.length === 0) return
    return subscribeToSidebarBranches(worktrees, (branches) => {
      setBranchByLocation((prev) => {
        let changed = false
        const next = { ...prev }
        for (const [id, branch] of branches) {
          if (!branch || next[id] === branch) continue
          next[id] = branch
          changed = true
        }
        return changed ? next : prev
      })
    })
  }, [worktrees])
  return branchByLocation
}

/**
 * Where the create-on-send draft will materialize: project, then
 * location/worktree — including "New worktree of …" and "PR #n", which only
 * come into existence (worktree forked, PR checked out) when the first message
 * is sent. Rendered as two minimal controls in the composer row, beside the
 * send button.
 */
function SingleSourceDestinationPicker({ draftThread }: { draftThread: Thread }) {
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
  const branchByLocation = useWorktreeBranches(locations)

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
            {location.is_worktree ? `↳ ${locationDisplayName(location, branchByLocation[location.id])}` : location.label}
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

/** One selectable destination in the unified picker. */
interface UnifiedDestination {
  member: UnifiedProjectMember
  locationId: string
  label: string
  kind: 'location' | 'new-worktree' | 'pull-request'
  pullRequest?: { id: number; title: string }
}

function memberLabel(member: UnifiedProjectMember, project: UnifiedProject): string {
  const sameSource = project.members.filter((m) => m.sourceId === member.sourceId).length > 1
  return sameSource ? `${member.sourceLabel} · ${member.project.name}` : member.sourceLabel
}

/** Project dropdown over merged Projects; the dots say which sources each lives on. */
function UnifiedProjectMenu({
  current,
  activeMember,
  onSelect,
}: {
  current: UnifiedProject
  activeMember: UnifiedProjectMember
  onSelect: (project: UnifiedProject) => void
}) {
  const projects = useUnifiedStore((s) => s.projects)
  const sources = useUnifiedStore((s) => s.snapshot?.sources)
  const activeSourceId = useUnifiedStore((s) => s.activeSourceId)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const options = useMemo(
    () => projects.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [projects],
  )

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
        <ProjectFavicon projectId={activeMember.project.id} className="h-3.5 w-3.5" />
        <span className="truncate">{current.name}</span>
        <ChevronDown size={12} className="flex-shrink-0 opacity-60" aria-hidden />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Project"
          className="absolute bottom-full left-0 z-50 mb-1 max-h-72 w-64 overflow-y-auto rounded-md p-1 shadow-lg"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
        >
          {options.map((project) => {
            const selected = project.key === current.key
            const lead = project.members.find((m) => m.sourceId === activeSourceId) ?? project.members[0]
            return (
              <button
                key={project.key}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  setOpen(false)
                  if (!selected) onSelect(project)
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px]"
                style={{ background: selected ? ACTIVE_BG : undefined, color: selected ? 'var(--color-claude)' : 'var(--color-text)' }}
                onMouseEnter={(event) => { if (!selected) event.currentTarget.style.background = HOVER_BG }}
                onMouseLeave={(event) => { if (!selected) event.currentTarget.style.background = '' }}
              >
                <SourceProjectFavicon
                  sourceId={lead.sourceId}
                  projectId={lead.project.id}
                  active={lead.sourceId === activeSourceId}
                  className="h-4 w-4"
                />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                <span className="flex flex-shrink-0 items-center gap-0.5">
                  {[...new Map(project.members.map((m) => [m.sourceId, m.sourceLabel]))].map(([id, label]) => (
                    <span
                      key={id}
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: sourceColor(id, sources ?? []) }}
                      title={label}
                    />
                  ))}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * The destination picker in the unified ("All") view. Same two controls, but the Project
 * menu lists merged Projects and the Location list offers that Project's Locations on
 * *every* source, grouped by source. Picking one on another source moves the draft there
 * (switching the active host and carrying the typed text across).
 */
function UnifiedDestinationPicker({
  draftThread,
  project,
  activeMember,
}: {
  draftThread: Thread
  project: UnifiedProject
  activeMember: UnifiedProjectMember
}) {
  const activeSource = useActiveSource()
  const activeSourceId = useUnifiedStore((s) => s.activeSourceId)
  const branchFacts = useUnifiedStore((s) => s.branchByLocation)
  const setDraftDestination = useUnifiedStore((s) => s.setDraftDestination)
  const loadLocationFacts = useUnifiedStore((s) => s.loadLocationFacts)
  const liveLocations = useLocationStore((s) => s.byProject[activeMember.project.id])
  const draftNewWorktree = useThreadStore((s) => s.draftNewWorktree)
  const draftPullRequest = useThreadStore((s) => s.draftPullRequest)

  // The active source's Locations come from the live store (fresher than the snapshot).
  const locationsByMember = useMemo(() => project.members.map((member) => ({
    member,
    locations: orderLocations(
      (member === activeMember ? liveLocations ?? member.locations : member.locations).filter(isActiveLocation),
    ),
  })), [project, activeMember, liveLocations])

  const activeLocations = useMemo(
    () => locationsByMember.find((entry) => entry.member === activeMember)?.locations ?? [],
    [locationsByMember, activeMember],
  )
  const activeForkable = useMemo(() => activeLocations.filter(canForkWorktree), [activeLocations])
  // Pull requests are listed for the active source only: its forge calls are already live.
  const pullRequestsByLocation = useOpenPullRequests(activeForkable)
  const activeBranches = useWorktreeBranches(activeLocations)

  useEffect(() => {
    for (const { member, locations } of locationsByMember) {
      if (member === activeMember) continue
      loadLocationFacts(member.sourceId, locations.filter((l) => l.is_worktree))
    }
  }, [locationsByMember, activeMember, loadLocationFacts])

  const groups = useMemo(() => {
    const built = locationsByMember.map(({ member, locations }) => {
    const isActive = member === activeMember
    const branchOf = (location: RepoLocation): string | undefined =>
      isActive ? activeBranches[location.id] : branchFacts[sourceKey(member.sourceId, location.id)] || undefined
    const entries: UnifiedDestination[] = locations.map((location) => ({
      member,
      locationId: location.id,
      kind: 'location',
      label: location.is_worktree ? `↳ ${locationDisplayName(location, branchOf(location))}` : location.label,
    }))
    for (const location of locations.filter(canForkWorktree)) {
      entries.push({ member, locationId: location.id, kind: 'new-worktree', label: `+ New worktree of ${location.label}` })
    }
    return { member, label: memberLabel(member, project), entries }
  })
    // `start` is each group's first index in the flat option list below.
    return built.map((group, index) => ({
      ...group,
      start: built.slice(0, index).reduce((n, g) => n + g.entries.length, 0),
    }))
  }, [locationsByMember, activeMember, activeBranches, branchFacts, project])

  const pullRequestEntries = useMemo(() => activeForkable.flatMap((location) =>
    (pullRequestsByLocation[location.id] ?? []).map((pr): UnifiedDestination => ({
      member: activeMember,
      locationId: location.id,
      kind: 'pull-request',
      label: `#${pr.id} ${pr.title}`,
      pullRequest: { id: pr.id, title: pr.title },
    }))), [activeForkable, pullRequestsByLocation, activeMember])

  // Flat list; an option's value is its index here.
  const all = useMemo(() => [...groups.flatMap((g) => g.entries), ...pullRequestEntries], [groups, pullRequestEntries])
  const currentKind: UnifiedDestination['kind'] = draftPullRequest ? 'pull-request' : draftNewWorktree ? 'new-worktree' : 'location'
  const currentIndex = all.findIndex((entry) =>
    entry.member === activeMember
    && entry.locationId === draftThread.location_id
    && entry.kind === currentKind
    && (currentKind !== 'pull-request' || entry.pullRequest?.id === draftPullRequest?.id))

  function choose(entry: UnifiedDestination): void {
    void setDraftDestination(entry.member.sourceId, entry.member.project.id, entry.locationId, {
      newWorktree: entry.kind === 'new-worktree' || undefined,
      pullRequest: entry.pullRequest,
    })
  }

  function handleProjectChange(next: UnifiedProject): void {
    // Stay on the current source when the Project lives there; otherwise follow it.
    const members = [
      ...next.members.filter((m) => m.sourceId === activeSourceId),
      ...next.members.filter((m) => m.sourceId !== activeSourceId),
    ]
    for (const member of members) {
      const usable = member.locations.filter(isActiveLocation)
      const first = usable.find((l) => !l.is_worktree) ?? usable[0]
      if (first) {
        void setDraftDestination(member.sourceId, member.project.id, first.id)
        return
      }
    }
  }

  const title = draftPullRequest
    ? `New thread in a new worktree with PR #${draftPullRequest.id} checked out`
    : draftNewWorktree
      ? 'New thread in a new worktree'
      : 'New thread destination'
  const pullRequestStart = groups.reduce((n, g) => n + g.entries.length, 0)

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
      {activeSource && <SourceBadge source={activeSource} size="sm" />}
      <UnifiedProjectMenu current={project} activeMember={activeMember} onSelect={handleProjectChange} />
      <select
        value={currentIndex >= 0 ? String(currentIndex) : ''}
        onChange={(e) => {
          const entry = all[Number(e.target.value)]
          if (entry) choose(entry)
        }}
        className="h-6 max-w-[170px] cursor-pointer rounded px-1 outline-none"
        style={{
          ...controlStyle,
          borderColor: activeSource ? `color-mix(in srgb, ${activeSource.color} 45%, var(--color-border))` : controlStyle.border,
        }}
        title="Location on any source, worktree or pull request"
      >
        {groups.map((group) => (
          <optgroup key={sourceKey(group.member.sourceId, group.member.project.id)} label={group.label}>
            {group.entries.map((entry, index) => (
              <option key={group.start + index} value={String(group.start + index)}>{entry.label}</option>
            ))}
            {group.entries.length === 0 && <option value="" disabled>No locations available</option>}
          </optgroup>
        ))}
        {pullRequestEntries.length > 0 && (
          <optgroup label={`Open pull requests · ${memberLabel(activeMember, project)}`}>
            {pullRequestEntries.map((entry, index) => (
              <option key={pullRequestStart + index} value={String(pullRequestStart + index)}>{entry.label}</option>
            ))}
          </optgroup>
        )}
        {currentIndex < 0 && (
          <option value="">
            {draftPullRequest ? `#${draftPullRequest.id} ${draftPullRequest.title}` : 'Select a location'}
          </option>
        )}
      </select>
    </div>
  )
}

function findMember(
  projects: UnifiedProject[],
  sourceId: string,
  projectId: string,
): { project: UnifiedProject; member: UnifiedProjectMember } | null {
  for (const project of projects) {
    const member = project.members.find((m) => m.sourceId === sourceId && m.project.id === projectId)
    if (member) return { project, member }
  }
  return null
}

/**
 * Where the create-on-send draft will materialize. In the unified ("All") view the
 * picker spans every source; otherwise — or until the unified snapshot knows the draft's
 * Project — it is the single-source picker.
 */
export default function DestinationPicker({ draftThread }: { draftThread: Thread }) {
  const enabled = useUnifiedStore((s) => s.enabled)
  const activeSourceId = useUnifiedStore((s) => s.activeSourceId)
  const projects = useUnifiedStore((s) => s.projects)
  const projectId = draftThread.project_id
  const found = useMemo(() => findMember(projects, activeSourceId, projectId), [projects, activeSourceId, projectId])
  const match = enabled ? found : null

  if (!match) return <SingleSourceDestinationPicker draftThread={draftThread} />
  return <UnifiedDestinationPicker draftThread={draftThread} project={match.project} activeMember={match.member} />
}

