import { useState, useEffect, useRef } from 'react'
import { useProjectStore } from '../stores/projects'
import { useThreadStore } from '../stores/threads'
import { useLocationStore } from '../stores/locations'
import { useYouTrackStore } from '../stores/youtrack'
import { Project, Thread, RepoLocation, LocationPool, ThreadStatus } from '../types/ipc'
import ProjectDialog from './ProjectDialog'
import LocationDialog from './LocationDialog'
import YouTrackSettingsDialog from './YouTrackSettingsDialog'
import SlashCommandsDialog from './SlashCommandsDialog'
import CliHealthDialog from './CliHealthDialog'
import { useSidebar } from './ui/sidebar-context'
import { Tooltip } from './ui/tooltip'
import { PanelLeft, Plus, Activity, Slash, Settings, ChevronDown, ChevronRight, Archive, Pencil, X, ArchiveRestore } from 'lucide-react'

const EMPTY_LOCATIONS: RepoLocation[] = []
const EMPTY_POOLS: LocationPool[] = []

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

export default function Sidebar() {
  const { isCollapsed, toggle } = useSidebar()

  const projects = useProjectStore((s) => s.projects)
  const archivedProjects = useProjectStore((s) => s.archivedProjects)
  const projectsLoading = useProjectStore((s) => s.loading)
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const expandedProjectIds = useProjectStore((s) => s.expandedProjectIds)
  const selectProject = useProjectStore((s) => s.select)
  const toggleExpanded = useProjectStore((s) => s.toggleExpanded)
  const removeProject = useProjectStore((s) => s.remove)
  const archiveProject = useProjectStore((s) => s.archive)
  const unarchiveProject = useProjectStore((s) => s.unarchive)

  const byProject = useThreadStore((s) => s.byProject)
  const archivedByProject = useThreadStore((s) => s.archivedByProject)
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId)
  const statusMap = useThreadStore((s) => s.statusMap)
  const unreadByThread = useThreadStore((s) => s.unreadByThread)
  const showArchived = useThreadStore((s) => s.showArchived)
  const archivedCountByProject = useThreadStore((s) => s.archivedCountByProject)
  const fetchThreads = useThreadStore((s) => s.fetch)
  const createThread = useThreadStore((s) => s.create)
  const removeThread = useThreadStore((s) => s.remove)
  const archiveThread = useThreadStore((s) => s.archive)
  const unarchiveThread = useThreadStore((s) => s.unarchive)
  const toggleShowArchived = useThreadStore((s) => s.toggleShowArchived)
  const selectThread = useThreadStore((s) => s.select)
  const setName = useThreadStore((s) => s.setName)
  const setUnread = useThreadStore((s) => s.setUnread)

  const locationsByProject = useLocationStore((s) => s.byProject)
  const poolsByProject = useLocationStore((s) => s.poolsByProject)
  const fetchLocations = useLocationStore((s) => s.fetch)
  const fetchPools = useLocationStore((s) => s.fetchPools)
  const checkoutLocation = useLocationStore((s) => s.checkout)
  const returnLocationToPool = useLocationStore((s) => s.returnToPool)

  const fetchYouTrackServers = useYouTrackStore((s) => s.fetch)

  const [searchQuery, setSearchQuery] = useState('')
  const [youtrackDialogOpen, setYoutrackDialogOpen] = useState(false)
  const [slashCommandsDialogOpen, setSlashCommandsDialogOpen] = useState(false)
  const [cliHealthDialogOpen, setCliHealthDialogOpen] = useState(false)

  const [projectDialog, setProjectDialog] = useState<{ mode: 'create' } | { mode: 'edit'; project: Project } | null>(null)
  const [locationDialog, setLocationDialog] = useState<{ mode: 'create'; projectId: string } | { mode: 'edit'; projectId: string; location: RepoLocation } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ type: 'project' | 'thread'; id: string; name: string; projectId: string } | null>(null)
  const [collapsedLocationIds, setCollapsedLocationIds] = useState<Set<string>>(new Set())
  const [archivedSectionExpanded, setArchivedSectionExpanded] = useState(false)
  const [branchByLocation, setBranchByLocation] = useState<Record<string, string>>({})
  const [expandedAvailablePools, setExpandedAvailablePools] = useState<Set<string>>(new Set())
  const [pathExistsByLocation, setPathExistsByLocation] = useState<Record<string, boolean>>({})

  const setStatus = useThreadStore((s) => s.setStatus)

  const subsRef = useRef<Map<string, Array<() => void>>>(new Map())

  useEffect(() => {
    const allThreadIds = new Set<string>()
    for (const threads of Object.values(byProject)) {
      for (const t of threads) {
        allThreadIds.add(t.id)
      }
    }

    for (const threadId of allThreadIds) {
      if (!subsRef.current.has(threadId)) {
        const unsubTitle = window.api.on(`thread:title:${threadId}`, (...args) => {
          setName(threadId, args[0] as string)
        })
        const unsubStatus = window.api.on(`thread:status:${threadId}`, (...args) => {
          setStatus(threadId, args[0] as 'idle' | 'running' | 'stopping' | 'error' | 'stopped')
        })
        const unsubComplete = window.api.on(`thread:complete:${threadId}`, (...args) => {
          const currentStatus = useThreadStore.getState().statusMap[threadId]
          const completionStatus = args[0] as ThreadStatus | undefined
          if (currentStatus === 'running' || currentStatus === 'stopping') {
            setStatus(threadId, completionStatus ?? 'idle')
          }

          const selectedId = useThreadStore.getState().selectedThreadId
          if (selectedId !== threadId) {
            setUnread(threadId, true)
          }
        })
        subsRef.current.set(threadId, [unsubTitle, unsubStatus, unsubComplete])
      }
    }

    for (const [threadId, unsubs] of subsRef.current) {
      if (!allThreadIds.has(threadId)) {
        unsubs.forEach((fn) => fn())
        subsRef.current.delete(threadId)
      }
    }
  }, [byProject, setName, setStatus, setUnread])

  useEffect(() => {
    return () => {
      for (const unsubs of subsRef.current.values()) {
        unsubs.forEach((fn) => fn())
      }
      subsRef.current.clear()
    }
  }, [])

  useEffect(() => {
    fetchYouTrackServers()
  }, [fetchYouTrackServers])

  useEffect(() => {
    let cancelled = false

    async function refreshBranches() {
      const locationPairs: Array<{ id: string; path: string }> = []
      for (const projectId of expandedProjectIds) {
        const locations = locationsByProject[projectId] ?? []
        for (const loc of locations) {
          locationPairs.push({ id: loc.id, path: loc.path })
        }
      }

      if (locationPairs.length === 0) return

      const results = await Promise.all(
        locationPairs.map(async ({ id, path }) => {
          try {
            const branch = await window.api.invoke('git:branch', path)
            return { id, branch: branch || null }
          } catch {
            return { id, branch: null }
          }
        })
      )

      if (cancelled) return

      setBranchByLocation((prev) => {
        let changed = false
        const next = { ...prev }
        for (const { id, branch } of results) {
          if (!branch) continue
          if (next[id] === branch) continue
          next[id] = branch
          changed = true
        }
        return changed ? next : prev
      })
    }

    void refreshBranches()
    const interval = setInterval(() => { void refreshBranches() }, 10000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [expandedProjectIds, locationsByProject])

  useEffect(() => {
    for (const projectId of expandedProjectIds) {
      const locations = locationsByProject[projectId] ?? []
      for (const loc of locations) {
        if (loc.connection_type !== 'local') continue
        window.api.invoke('locations:pathExists', loc.path).then((exists) => {
          setPathExistsByLocation((prev) => {
            if (prev[loc.id] === exists) return prev
            return { ...prev, [loc.id]: exists }
          })
        }).catch(() => {})
      }
    }
  }, [expandedProjectIds, locationsByProject])

  function handleToggleProject(id: string): void {
    toggleExpanded(id)
    if (!expandedProjectIds.has(id)) {
      selectProject(id)
    }
    if (!byProject[id]) fetchThreads(id)
    if (!locationsByProject[id]) fetchLocations(id)
    if (!poolsByProject[id]) fetchPools(id)
  }

  async function handleNewThread(projectId: string, locationId: string): Promise<void> {
    await createThread(projectId, 'New thread', locationId)
    selectProject(projectId)
    window.dispatchEvent(new Event('focus-input'))
  }

  async function handleDeleteProject(id: string): Promise<void> {
    await removeProject(id)
    setConfirmDelete(null)
  }

  async function handleArchiveProject(id: string): Promise<void> {
    await archiveProject(id)
  }

  async function handleUnarchiveProject(id: string): Promise<void> {
    await unarchiveProject(id)
  }

  async function handleDeleteThread(id: string, projectId: string): Promise<void> {
    await removeThread(id, projectId)
    setConfirmDelete(null)
  }

  async function handleArchiveThread(thread: Thread, projectId: string): Promise<void> {
    await archiveThread(thread.id, projectId)

    const latestThread = (useThreadStore.getState().byProject[projectId] ?? [])
      .slice()
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0]

    if (latestThread) {
      selectThread(latestThread.id)
      return
    }

    const loadedLocations = locationsByProject[projectId] ?? []
    const loadedActiveLocations = loadedLocations.filter((loc) => !loc.pool_id || loc.checked_out)
    let locationId = loadedActiveLocations[0]?.id ?? null

    if (!locationId) {
      const fetchedLocations = await window.api.invoke('locations:list', projectId) as RepoLocation[]
      const fetchedActiveLocations = fetchedLocations.filter((loc) => !loc.pool_id || loc.checked_out)
      locationId = fetchedActiveLocations[0]?.id ?? null
    }

    if (locationId) {
      await createThread(projectId, 'New thread', locationId)
    } else {
      selectThread(null)
    }
  }

  async function handleUnarchiveThread(thread: Thread, projectId: string): Promise<void> {
    await unarchiveThread(thread.id, projectId)
  }

  function toggleLocationCollapsed(locationId: string): void {
    setCollapsedLocationIds((prev) => {
      const next = new Set(prev)
      if (next.has(locationId)) next.delete(locationId)
      else next.add(locationId)
      return next
    })
  }

  function togglePoolAvailableExpanded(poolId: string): void {
    setExpandedAvailablePools((prev) => {
      const next = new Set(prev)
      if (next.has(poolId)) next.delete(poolId)
      else next.add(poolId)
      return next
    })
  }

  function connectionBadge(connType: string) {
    if (connType === 'local') return null
    const isSSH = connType === 'ssh'
    return (
      <span
        className="ml-1 flex-shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase"
        style={{
          background: isSSH ? 'rgba(99, 179, 237, 0.15)' : 'rgba(251, 191, 36, 0.15)',
          color: isSSH ? '#63b3ed' : '#fbbf24',
        }}
      >
        {connType}
      </span>
    )
  }

  function getStatusColor(thread: Thread): string {
    const status = statusMap[thread.id] ?? 'idle'
    const isUnread = unreadByThread[thread.id] ?? !!thread.unread
    if (isUnread) return '#22c55e'
    if (status === 'running') return '#4ade80'
    if (status === 'stopping') return '#fb923c'
    if (status === 'error') return '#f87171'
    if (status === 'stopped') return '#facc15'
    return 'var(--color-text-muted)'
  }

  function renderThread(thread: Thread, isArchived: boolean, projectId: string, indent = 'pl-10') {
    const status = statusMap[thread.id] ?? 'idle'
    const isSelected = selectedThreadId === thread.id

    return (
      <div
        key={thread.id}
        className="group/thread relative"
        style={{ opacity: isArchived ? 0.6 : 1 }}
      >
        <button
          onClick={() => selectThread(thread.id)}
          className={`flex w-full items-center ${indent} pr-2 py-1 text-left text-xs transition-colors min-w-0`}
          style={{
            background: isSelected ? 'var(--color-border)' : 'transparent',
            color: 'var(--color-text-muted)'
          }}
        >
          {!isArchived && (status === 'running' || status === 'stopping') ? (
            <span
              className="mr-2 h-1.5 w-1.5 flex-shrink-0 status-spinner"
              style={status === 'stopping' ? { opacity: 0.5, filter: 'hue-rotate(30deg)' } : undefined}
            />
          ) : (
            <span
              className="mr-2 h-1.5 w-1.5 rounded-full flex-shrink-0"
              style={{ background: isArchived ? 'var(--color-text-muted)' : getStatusColor(thread) }}
            />
          )}
          <span className="truncate min-w-0">{thread.name}</span>
        </button>

        {/* Git branch mismatch warning */}
        {(() => {
          const currentBranch = thread.location_id ? branchByLocation[thread.location_id] : undefined
          if (thread.git_branch && currentBranch && thread.git_branch !== currentBranch) {
            return (
              <div
                className={`${indent} pr-2 text-[10px] leading-tight truncate -mt-0.5 pb-0.5`}
                style={{ color: '#f59e0b' }}
                title={`Started on branch '${thread.git_branch}', current branch is '${currentBranch}'`}
              >
                ⎇ {thread.git_branch}
              </div>
            )
          }
          return null
        })()}

        {/* Hover overlay: time label + archive action */}
        <div
          className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover/thread:opacity-100 transition-opacity"
          style={{ background: isSelected ? 'var(--color-border)' : 'var(--color-surface)' }}
        >
          <span
            className="px-1 text-[10px]"
            style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}
          >
            {relativeTime(thread.updated_at)}
          </span>
          {isArchived ? (
            <button
              onClick={() => handleUnarchiveThread(thread, projectId)}
              className="rounded p-1 hover:bg-white/10 transition-colors"
              style={{ color: 'var(--color-text-muted)' }}
              title="Unarchive thread"
            >
              <ArchiveRestore size={13} />
            </button>
          ) : (
            <button
              onClick={() => handleArchiveThread(thread, projectId)}
              className="rounded p-1 hover:bg-white/10 transition-colors"
              style={{ color: 'var(--color-text-muted)' }}
              title="Archive thread"
            >
              <Archive size={13} />
            </button>
          )}
        </div>
      </div>
    )
  }

  function renderLocationSection(projectId: string, loc: RepoLocation, projectThreads: Thread[], showPoolActions = false) {
    const isLocationExpanded = !collapsedLocationIds.has(loc.id)
    const locationThreads = projectThreads.filter((t) => t.location_id === loc.id)
    const isCheckedOut = !loc.pool_id || loc.checked_out
    const pathMissing = loc.connection_type === 'local' && pathExistsByLocation[loc.id] === false

    return (
      <div key={loc.id}>
        <div className="group relative">
          <button
            onClick={() => toggleLocationCollapsed(loc.id)}
            className="flex w-full items-center pl-6 pr-2 py-0.5 text-left text-xs transition-colors min-w-0"
            style={{ color: pathMissing ? '#f87171' : 'var(--color-text-muted)' }}
            title={pathMissing ? `Directory not found: ${loc.path}` : undefined}
          >
            {isLocationExpanded
              ? <ChevronDown size={10} className="mr-1 flex-shrink-0 opacity-50" />
              : <ChevronRight size={10} className="mr-1 flex-shrink-0 opacity-50" />
            }
            <span className="truncate opacity-70">{loc.label}</span>
            {branchByLocation[loc.id] && (
              <span className="ml-1 flex-shrink-0 opacity-50 text-[9px]">
                ({branchByLocation[loc.id]})
              </span>
            )}
            {connectionBadge(loc.connection_type)}
            {loc.pool_id && !isCheckedOut && (
              <span
                className="ml-1 flex-shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold"
                style={{ background: 'rgba(148, 163, 184, 0.15)', color: '#94a3b8' }}
              >
                available
              </span>
            )}
            {pathMissing && (
              <span
                className="ml-1 flex-shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase"
                style={{ background: 'rgba(248, 113, 113, 0.15)', color: '#f87171' }}
              >
                not found
              </span>
            )}
          </button>
          {showPoolActions && loc.pool_id && (
            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              {loc.checked_out ? (
                <button
                  onClick={() => returnLocationToPool(loc.id, projectId)}
                  className="rounded px-1.5 py-0.5 text-[10px] hover:bg-white/10"
                  style={{ color: 'var(--color-text-muted)' }}
                  title="Return to pool"
                >
                  Return
                </button>
              ) : (
                <button
                  onClick={() => checkoutLocation(loc.id, projectId)}
                  className="rounded px-1.5 py-0.5 text-[10px] hover:bg-white/10"
                  style={{ color: 'var(--color-text-muted)' }}
                  title="Checkout location"
                >
                  Checkout
                </button>
              )}
            </div>
          )}
        </div>

        {isLocationExpanded && isCheckedOut && (
          <button
            onClick={() => handleNewThread(projectId, loc.id)}
            className="flex w-full items-center pl-10 pr-2 py-0.5 text-left text-[10px] opacity-40 hover:opacity-80 transition-opacity"
            style={{ color: 'var(--color-text-muted)' }}
          >
            + New thread
          </button>
        )}

        {isLocationExpanded && (() => {
          const currentBranch = branchByLocation[loc.id]
          const currentBranchThreads = locationThreads.filter((t) =>
            !t.git_branch || !currentBranch || t.git_branch === currentBranch
          )
          const otherBranchThreads = locationThreads.filter((t) =>
            t.git_branch && currentBranch && t.git_branch !== currentBranch
          )
          return (
            <>
              {currentBranchThreads.map((thread) => renderThread(thread, false, projectId))}
              {otherBranchThreads.length > 0 && (
                <>
                  <div
                    className="flex items-center pl-10 pr-2 py-0.5 gap-1.5"
                    style={{ color: 'var(--color-text-muted)', opacity: 0.4 }}
                  >
                    <div className="flex-1 h-px" style={{ background: 'var(--color-border)' }} />
                    <span className="text-[9px] uppercase tracking-wide flex-shrink-0">other branches</span>
                    <div className="flex-1 h-px" style={{ background: 'var(--color-border)' }} />
                  </div>
                  {otherBranchThreads.map((thread) => renderThread(thread, false, projectId))}
                </>
              )}
            </>
          )
        })()}
      </div>
    )
  }

  // ── Collapsed sidebar ──────────────────────────────────────────────────

  if (isCollapsed) {
    // Collect running threads across all projects for status dots
    const runningProjects = projects.filter((p) => {
      const threads = byProject[p.id] ?? []
      return threads.some((t) => statusMap[t.id] === 'running' || statusMap[t.id] === 'stopping')
    })

    return (
      <aside
        className="flex flex-col items-center border-r overflow-hidden flex-shrink-0 sidebar-transition"
        style={{
          width: '48px',
          background: 'var(--color-surface)',
          borderColor: 'var(--color-border)',
        }}
      >
        {/* Toggle button */}
        <div className="flex items-center justify-center py-3 w-full flex-shrink-0 border-b" style={{ borderColor: 'var(--color-border)' }}>
          <button
            onClick={toggle}
            className="flex items-center justify-center rounded p-1.5 opacity-60 hover:opacity-100 transition-opacity"
            style={{ color: 'var(--color-text-muted)' }}
            title="Expand sidebar"
          >
            <PanelLeft size={16} />
          </button>
        </div>

        {/* Collapsed project icons */}
        <div className="flex-1 overflow-y-auto w-full py-1">
          {projects.map((project) => {
            const isActive = selectedProjectId === project.id
            const hasRunning = runningProjects.includes(project)
            const initial = project.name.charAt(0).toUpperCase()

            return (
              <Tooltip key={project.id} content={project.name}>
                <button
                  onClick={() => handleToggleProject(project.id)}
                  className="relative flex items-center justify-center w-full py-2 transition-colors"
                  style={{
                    background: isActive ? 'var(--color-surface-2)' : 'transparent',
                    color: isActive ? 'var(--color-text)' : 'var(--color-text-muted)',
                  }}
                >
                  <span className="text-xs font-semibold">{initial}</span>
                  {hasRunning && (
                    <span
                      className="absolute top-1.5 right-2.5 h-1.5 w-1.5 rounded-full"
                      style={{ background: '#4ade80' }}
                    />
                  )}
                </button>
              </Tooltip>
            )
          })}
        </div>

        {/* Bottom actions */}
        <div className="flex flex-col items-center gap-1 py-2 border-t flex-shrink-0" style={{ borderColor: 'var(--color-border)' }}>
          <Tooltip content="New project">
            <button
              onClick={() => setProjectDialog({ mode: 'create' })}
              className="flex items-center justify-center rounded p-1.5 opacity-60 hover:opacity-100 transition-opacity"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <Plus size={16} />
            </button>
          </Tooltip>
        </div>

        {/* Dialogs (shared) */}
        {renderDialogs()}
      </aside>
    )
  }

  // ── Expanded sidebar ───────────────────────────────────────────────────

  function renderDialogs() {
    return (
      <>
        {projectDialog && (
          <ProjectDialog
            mode={projectDialog.mode}
            project={projectDialog.mode === 'edit' ? projectDialog.project : undefined}
            onClose={() => setProjectDialog(null)}
          />
        )}

        {locationDialog && (
          <LocationDialog
            mode={locationDialog.mode}
            projectId={locationDialog.projectId}
            location={locationDialog.mode === 'edit' ? locationDialog.location : undefined}
            onClose={() => {
              setLocationDialog(null)
              if (locationDialog.projectId) fetchLocations(locationDialog.projectId)
            }}
          />
        )}

        {confirmDelete && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center"
            style={{ background: 'rgba(0,0,0,0.7)' }}
            onClick={() => setConfirmDelete(null)}
          >
            <div
              className="w-80 rounded-lg p-5 shadow-2xl"
              style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <p className="text-sm mb-1" style={{ color: 'var(--color-text)' }}>
                Delete {confirmDelete.type}?
              </p>
              <p className="text-xs mb-4" style={{ color: 'var(--color-text-muted)' }}>
                <span className="font-mono" style={{ color: 'var(--color-text)' }}>{confirmDelete.name}</span>
                {confirmDelete.type === 'project' && ' and all its threads will be permanently deleted.'}
                {confirmDelete.type === 'thread' && ' and all its messages will be permanently deleted.'}
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setConfirmDelete(null)}
                  className="rounded px-3 py-1.5 text-xs"
                  style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                >
                  Cancel
                </button>
                <button
                  onClick={() =>
                    confirmDelete.type === 'project'
                      ? handleDeleteProject(confirmDelete.id)
                      : handleDeleteThread(confirmDelete.id, confirmDelete.projectId)
                  }
                  className="rounded px-3 py-1.5 text-xs font-medium"
                  style={{ background: '#dc2626', color: '#fff' }}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}

        {youtrackDialogOpen && (
          <YouTrackSettingsDialog onClose={() => setYoutrackDialogOpen(false)} />
        )}

        {slashCommandsDialogOpen && (
          <SlashCommandsDialog
            projectId={selectedProjectId ?? null}
            projectName={projects.find((p) => p.id === selectedProjectId)?.name}
            onClose={() => setSlashCommandsDialogOpen(false)}
          />
        )}

        {cliHealthDialogOpen && (
          <CliHealthDialog onClose={() => setCliHealthDialogOpen(false)} />
        )}
      </>
    )
  }

  return (
    <aside
      className="flex flex-col border-r overflow-hidden flex-shrink-0 sidebar-transition"
      style={{
        width: '240px',
        background: 'var(--color-surface)',
        borderColor: 'var(--color-border)',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2 border-b flex-shrink-0"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="flex items-center gap-2">
          <button
            onClick={toggle}
            className="flex items-center justify-center rounded p-1 opacity-60 hover:opacity-100 transition-opacity"
            style={{ color: 'var(--color-text-muted)' }}
            title="Collapse sidebar"
          >
            <PanelLeft size={16} />
          </button>
          <span className="font-semibold text-sm" style={{ color: 'var(--color-claude)' }}>
            PolyCode
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setCliHealthDialogOpen(true)}
            className="flex items-center justify-center rounded p-1.5 opacity-60 hover:opacity-100 transition-opacity"
            title="CLI health &amp; updates"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <Activity size={14} />
          </button>
          <button
            onClick={() => setSlashCommandsDialogOpen(true)}
            className="flex items-center justify-center rounded p-1.5 opacity-60 hover:opacity-100 transition-opacity"
            title="Slash commands"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <Slash size={14} />
          </button>
          <button
            onClick={() => setYoutrackDialogOpen(true)}
            className="flex items-center justify-center rounded p-1.5 opacity-60 hover:opacity-100 transition-opacity"
            title="YouTrack servers"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" fill="#167dff" opacity="0.85" />
              <path d="M8 9l4 4 4-4" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M12 7v10" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
          <button
            onClick={() => setProjectDialog({ mode: 'create' })}
            className="flex items-center justify-center rounded p-1.5 opacity-60 hover:opacity-100 transition-opacity"
            style={{ color: 'var(--color-text-muted)' }}
            title="New project"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      {/* Search bar */}
      <div className="px-3 py-1.5 border-b flex-shrink-0" style={{ borderColor: 'var(--color-border)' }}>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search threads…"
          className="w-full rounded px-2 py-1 text-xs outline-none"
          style={{
            background: 'var(--color-surface-2)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text)',
          }}
        />
      </div>

      {/* Projects list */}
      <div className="flex-1 overflow-y-auto">
        {searchQuery.trim() ? (() => {
          const q = searchQuery.trim().toLowerCase()
          const results: Array<{ thread: Thread; projectName: string; projectId: string }> = []
          for (const project of projects) {
            const threads = byProject[project.id] ?? []
            for (const thread of threads) {
              if (thread.name.toLowerCase().includes(q)) {
                results.push({ thread, projectName: project.name, projectId: project.id })
              }
            }
          }
          if (results.length === 0) {
            return (
              <p className="px-4 py-6 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
                No threads match &quot;{searchQuery.trim()}&quot;
              </p>
            )
          }
          return results.map(({ thread, projectName, projectId }) => (
            <div key={thread.id} className="group/thread relative">
              <button
                onClick={() => selectThread(thread.id)}
                className="flex w-full items-center pl-4 pr-2 py-1 text-left text-xs transition-colors min-w-0"
                style={{
                  background: selectedThreadId === thread.id ? 'var(--color-border)' : 'transparent',
                  color: 'var(--color-text-muted)',
                }}
              >
                <span
                  className="mr-2 h-1.5 w-1.5 rounded-full flex-shrink-0"
                  style={{
                    background:
                      (unreadByThread[thread.id] ?? !!thread.unread) ? '#22c55e'
                      : statusMap[thread.id] === 'running' ? '#4ade80'
                      : statusMap[thread.id] === 'error' ? '#f87171'
                      : 'var(--color-text-muted)'
                  }}
                />
                <span className="truncate flex-1 min-w-0">{thread.name}</span>
                <span
                  className="ml-1 flex-shrink-0 text-[10px] opacity-0 group-hover/thread:opacity-50 transition-opacity"
                >
                  {projectName}
                </span>
              </button>
            </div>
          ))
        })() : projects.map((project) => {
          const isExpanded = expandedProjectIds.has(project.id)
          const projectThreads = byProject[project.id] ?? []
          const projectArchivedThreads = archivedByProject[project.id] ?? []
          const projectArchivedCount = archivedCountByProject[project.id] ?? 0
          const locations = locationsByProject[project.id] ?? EMPTY_LOCATIONS
          const pools = poolsByProject[project.id] ?? EMPTY_POOLS
          const runningThreads = projectThreads.filter((t) => statusMap[t.id] === 'running' || statusMap[t.id] === 'stopping')

          return (
            <div key={project.id}>
              {/* Project row */}
              <div className="group relative">
                <button
                  onClick={() => handleToggleProject(project.id)}
                  className="flex w-full items-center px-3 py-1.5 text-left text-sm transition-colors min-w-0"
                  style={{
                    background: isExpanded ? 'var(--color-surface-2)' : 'transparent',
                    color: 'var(--color-text)'
                  }}
                >
                  {isExpanded
                    ? <ChevronDown size={12} className="mr-1.5 flex-shrink-0 opacity-50" />
                    : <ChevronRight size={12} className="mr-1.5 flex-shrink-0 opacity-50" />
                  }
                  <span className="truncate">{project.name}</span>
                </button>
                <div
                  className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{ background: isExpanded ? 'var(--color-surface-2)' : 'var(--color-surface)' }}
                >
                  <button
                    onClick={() => setProjectDialog({ mode: 'edit', project })}
                    className="rounded p-1 hover:bg-white/10 transition-colors"
                    style={{ color: 'var(--color-text-muted)' }}
                    title="Edit project"
                  >
                    <Pencil size={11} />
                  </button>
                  <button
                    onClick={() => handleArchiveProject(project.id)}
                    className="rounded p-1 hover:bg-white/10 transition-colors"
                    style={{ color: 'var(--color-text-muted)' }}
                    title="Archive project"
                  >
                    <Archive size={11} />
                  </button>
                  <button
                    onClick={() => setConfirmDelete({ type: 'project', id: project.id, name: project.name, projectId: project.id })}
                    className="rounded p-1 hover:bg-white/10 transition-colors"
                    style={{ color: 'var(--color-text-muted)' }}
                    title="Delete project"
                  >
                    <X size={11} />
                  </button>
                </div>
              </div>

              {/* Collapsed: only show running threads */}
              {!isExpanded && runningThreads.length > 0 && (
                <div>
                  {runningThreads.map((thread) => renderThread(thread, false, project.id, 'pl-8'))}
                </div>
              )}

              {/* Expanded: show locations with nested threads */}
              {isExpanded && (
                <div>
                  {pools.length > 0 ? (
                    <>
                      {pools.map((pool) => {
                        const pooledLocations = locations.filter((l) => l.pool_id === pool.id)
                        const checkedOut = pooledLocations.filter((l) => l.checked_out)
                        const available = pooledLocations.filter((l) => !l.checked_out)
                        const showAvailable = expandedAvailablePools.has(pool.id)

                        return (
                          <div key={pool.id}>
                            <div
                              className="flex w-full items-center pl-6 pr-2 pt-1.5 pb-0.5 text-left text-xs"
                              style={{ color: 'var(--color-text-muted)' }}
                            >
                              <span className="truncate font-medium" style={{ color: 'var(--color-text)' }}>
                                {pool.name}
                              </span>
                              <span className="ml-2 text-[10px] opacity-50">
                                {checkedOut.length} checked out
                              </span>
                              {available.length > 0 && (
                                <button
                                  onClick={() => checkoutLocation(available[0].id, project.id)}
                                  className="ml-2 rounded px-1.5 py-0.5 text-[10px] hover:bg-white/10"
                                  style={{ color: 'var(--color-text-muted)' }}
                                  title="Checkout next available location"
                                >
                                  Checkout next
                                </button>
                              )}
                            </div>
                            {available.length > 0 && (
                              <div className="flex w-full items-center pl-8 pr-2 pb-1">
                                <button
                                  onClick={() => togglePoolAvailableExpanded(pool.id)}
                                  className="rounded px-1.5 py-0.5 text-[10px] hover:bg-white/10"
                                  style={{ color: 'var(--color-text-muted)' }}
                                >
                                  {showAvailable ? `Hide available (${available.length})` : `Show available (${available.length})`}
                                </button>
                              </div>
                            )}

                            {checkedOut.map((loc) => renderLocationSection(project.id, loc, projectThreads, true))}
                            {showAvailable && available.map((loc) => renderLocationSection(project.id, loc, projectThreads, true))}
                          </div>
                        )
                      })}

                      {locations
                        .filter((l) => !l.pool_id)
                        .map((loc) => renderLocationSection(project.id, loc, projectThreads))}
                    </>
                  ) : (
                    <>
                      {locations.map((loc) => renderLocationSection(project.id, loc, projectThreads))}
                    </>
                  )}

                  {/* Threads without a location (orphaned) */}
                  {projectThreads
                    .filter((t) => !t.location_id || !locations.some((l) => l.id === t.location_id))
                    .map((thread) => renderThread(thread, false, project.id, 'pl-8'))}

                  {/* Add location prompt when project has no locations */}
                  {locations.length === 0 && projectThreads.length === 0 && (
                    <button
                      onClick={() => setLocationDialog({ mode: 'create', projectId: project.id })}
                      className="flex w-full items-center pl-6 pr-4 py-2 text-left text-xs opacity-50 hover:opacity-80 transition-opacity"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      + Add a location to get started
                    </button>
                  )}

                  {/* Archive toggle */}
                  {(projectArchivedCount > 0 || showArchived) && (
                    <button
                      onClick={() => toggleShowArchived(project.id)}
                      className="flex w-full items-center pl-6 pr-4 py-1 text-left text-[10px] opacity-40 hover:opacity-70 transition-opacity"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      {showArchived ? (
                        <><ChevronDown size={9} className="mr-1" /> Hide archived</>
                      ) : (
                        <><ChevronRight size={9} className="mr-1" /> Archived ({projectArchivedCount})</>
                      )}
                    </button>
                  )}

                  {/* Archived threads */}
                  {showArchived && projectArchivedThreads.map((thread) => renderThread(thread, true, project.id, 'pl-8'))}
                </div>
              )}
            </div>
          )
        })}

        {!searchQuery.trim() && projectsLoading && projects.length === 0 && (
          <div className="px-4 py-6 flex flex-col items-center gap-2" style={{ color: 'var(--color-text-muted)' }}>
            <div className="status-spinner h-3 w-3" />
            <span className="text-xs">Loading…</span>
          </div>
        )}

        {!searchQuery.trim() && !projectsLoading && projects.length === 0 && archivedProjects.length === 0 && (
          <p className="px-4 py-6 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
            No projects yet.
            <br />
            Click <Plus size={10} className="inline" /> to add one.
          </p>
        )}

        {/* Archived projects section */}
        {!searchQuery.trim() && archivedProjects.length > 0 && (
          <div className="border-t mt-1" style={{ borderColor: 'var(--color-border)' }}>
            <button
              onClick={() => setArchivedSectionExpanded((v) => !v)}
              className="flex w-full items-center px-3 py-1.5 text-left text-xs transition-opacity opacity-40 hover:opacity-70"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {archivedSectionExpanded
                ? <ChevronDown size={10} className="mr-1.5 flex-shrink-0" />
                : <ChevronRight size={10} className="mr-1.5 flex-shrink-0" />
              }
              Archived ({archivedProjects.length})
            </button>

            {archivedSectionExpanded && archivedProjects.map((project) => (
              <div key={project.id} className="group relative">
                <div
                  className="flex w-full items-center px-3 py-1.5 text-sm min-w-0 opacity-40"
                  style={{ color: 'var(--color-text)' }}
                >
                  <span className="mr-1.5 flex-shrink-0 opacity-50" style={{ width: '12px' }} />
                  <span className="truncate">{project.name}</span>
                </div>
                <div
                  className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{ background: 'var(--color-surface)' }}
                >
                  <button
                    onClick={() => handleUnarchiveProject(project.id)}
                    className="rounded p-1 hover:bg-white/10 transition-colors"
                    style={{ color: 'var(--color-text-muted)' }}
                    title="Unarchive project"
                  >
                    <ArchiveRestore size={11} />
                  </button>
                  <button
                    onClick={() => setConfirmDelete({ type: 'project', id: project.id, name: project.name, projectId: project.id })}
                    className="rounded p-1 hover:bg-white/10 transition-colors"
                    style={{ color: 'var(--color-text-muted)' }}
                    title="Delete project"
                  >
                    <X size={11} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {renderDialogs()}
    </aside>
  )
}
