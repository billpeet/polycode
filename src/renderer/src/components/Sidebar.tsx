import { useState, useEffect, useRef } from 'react'
import { useProjectStore } from '../stores/projects'
import { useThreadStore } from '../stores/threads'
import { useLocationStore } from '../stores/locations'
import { useYouTrackStore } from '../stores/youtrack'
import { Project, Thread, RepoLocation } from '../types/ipc'
import ProjectDialog from './ProjectDialog'
import LocationDialog from './LocationDialog'
import YouTrackSettingsDialog from './YouTrackSettingsDialog'
import SlashCommandsDialog from './SlashCommandsDialog'

const EMPTY_LOCATIONS: RepoLocation[] = []

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
  const projects = useProjectStore((s) => s.projects)
  const archivedProjects = useProjectStore((s) => s.archivedProjects)
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

  const locationsByProject = useLocationStore((s) => s.byProject)
  const fetchLocations = useLocationStore((s) => s.fetch)

  const fetchYouTrackServers = useYouTrackStore((s) => s.fetch)

  const [searchQuery, setSearchQuery] = useState('')
  const [youtrackDialogOpen, setYoutrackDialogOpen] = useState(false)
  const [slashCommandsDialogOpen, setSlashCommandsDialogOpen] = useState(false)

  const [projectDialog, setProjectDialog] = useState<{ mode: 'create' } | { mode: 'edit'; project: Project } | null>(null)
  const [locationDialog, setLocationDialog] = useState<{ mode: 'create'; projectId: string } | { mode: 'edit'; projectId: string; location: RepoLocation } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ type: 'project' | 'thread'; id: string; name: string; projectId: string } | null>(null)
/** Track collapsed locations (all expanded by default) */
  const [collapsedLocationIds, setCollapsedLocationIds] = useState<Set<string>>(new Set())
  /** Whether the archived projects section is expanded */
  const [archivedSectionExpanded, setArchivedSectionExpanded] = useState(false)
  /** Git branch name per location id */
  const [branchByLocation, setBranchByLocation] = useState<Record<string, string>>({})

  const setStatus = useThreadStore((s) => s.setStatus)

  // Track IPC subscriptions for all known threads (title + status)
  const subsRef = useRef<Map<string, Array<() => void>>>(new Map())

  // Subscribe to title and status updates for all threads in byProject
  useEffect(() => {
    const allThreadIds = new Set<string>()
    for (const threads of Object.values(byProject)) {
      for (const t of threads) {
        allThreadIds.add(t.id)
      }
    }

    // Subscribe to new threads
    for (const threadId of allThreadIds) {
      if (!subsRef.current.has(threadId)) {
        const unsubTitle = window.api.on(`thread:title:${threadId}`, (...args) => {
          setName(threadId, args[0] as string)
        })
        const unsubStatus = window.api.on(`thread:status:${threadId}`, (...args) => {
          setStatus(threadId, args[0] as 'idle' | 'running' | 'error' | 'stopped')
        })
        // Safety net: reset status to idle on complete if still running
        const unsubComplete = window.api.on(`thread:complete:${threadId}`, () => {
          const currentStatus = useThreadStore.getState().statusMap[threadId]
          if (currentStatus === 'running') {
            setStatus(threadId, 'idle')
          }
        })
        subsRef.current.set(threadId, [unsubTitle, unsubStatus, unsubComplete])
      }
    }

    // Unsubscribe from removed threads
    for (const [threadId, unsubs] of subsRef.current) {
      if (!allThreadIds.has(threadId)) {
        unsubs.forEach((fn) => fn())
        subsRef.current.delete(threadId)
      }
    }
  }, [byProject, setName, setStatus])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const unsubs of subsRef.current.values()) {
        unsubs.forEach((fn) => fn())
      }
      subsRef.current.clear()
    }
  }, [])

  // Fetch YouTrack servers on mount
  useEffect(() => {
    fetchYouTrackServers()
  }, [fetchYouTrackServers])

  // Fetch git branch for each location in expanded projects
  useEffect(() => {
    function refreshBranches() {
      for (const projectId of expandedProjectIds) {
        const locations = locationsByProject[projectId] ?? []
        for (const loc of locations) {
          window.api.invoke('git:branch', loc.path).then((branch) => {
            if (branch) {
              setBranchByLocation((prev) => ({ ...prev, [loc.id]: branch }))
            }
          }).catch(() => {/* not a git repo */})
        }
      }
    }
    refreshBranches()
    const interval = setInterval(refreshBranches, 10000)
    return () => clearInterval(interval)
  }, [expandedProjectIds, locationsByProject])

  function handleToggleProject(id: string): void {
    toggleExpanded(id)
    // Also select this project when expanding (so new thread button works)
    if (!expandedProjectIds.has(id)) {
      selectProject(id)
    }
    // Fetch threads and locations if not already loaded
    if (!byProject[id]) fetchThreads(id)
    if (!locationsByProject[id]) fetchLocations(id)
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

  function renderThread(thread: Thread, isArchived: boolean, projectId: string, indent = 'pl-10') {
    const status = statusMap[thread.id] ?? 'idle'
    const statusColor =
      status === 'running' ? '#4ade80'
      : status === 'error' ? '#f87171'
      : status === 'stopped' ? '#facc15'
      : 'var(--color-text-muted)'

    return (
      <div
        key={thread.id}
        className="group relative"
        style={{ opacity: isArchived ? 0.6 : 1 }}
      >
        <button
          onClick={() => selectThread(thread.id)}
          className={`flex w-full items-center ${indent} pr-2 py-1.5 text-left text-xs transition-colors min-w-0`}
          style={{
            background: selectedThreadId === thread.id ? 'var(--color-border)' : 'transparent',
            color: 'var(--color-text-muted)'
          }}
        >
          {!isArchived && status === 'running' ? (
            <span
              className="mr-2 h-1.5 w-1.5 flex-shrink-0 status-spinner"
            />
          ) : (
            <span
              className="mr-2 h-1.5 w-1.5 rounded-full flex-shrink-0"
              style={{ background: isArchived ? 'var(--color-text-muted)' : statusColor }}
            />
          )}
          <span className="flex flex-col min-w-0">
            <span className="truncate">{thread.name}</span>
            <span
              className="text-[10px] leading-tight"
              style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}
            >
              {relativeTime(thread.updated_at)}
            </span>
            {(() => {
              const currentBranch = thread.location_id ? branchByLocation[thread.location_id] : undefined
              if (thread.git_branch && currentBranch && thread.git_branch !== currentBranch) {
                return (
                  <span
                    className="text-[10px] leading-tight truncate"
                    style={{ color: '#f59e0b' }}
                    title={`Started on branch '${thread.git_branch}', current branch is '${currentBranch}'`}
                  >
                    ⎇ {thread.git_branch}
                  </span>
                )
              }
              return null
            })()}
          </span>
        </button>

        {/* Thread actions — absolutely positioned, overlay on hover */}
        <div
          className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ background: selectedThreadId === thread.id ? 'var(--color-border)' : 'var(--color-surface)' }}
        >
          {isArchived ? (
            <button
              onClick={() => handleUnarchiveThread(thread, projectId)}
              className="rounded p-1 hover:bg-white/10 transition-colors"
              style={{ color: 'var(--color-text-muted)' }}
              title="Unarchive thread"
            >
              {/* Unarchive: box with up arrow */}
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1" y="7" width="14" height="8" rx="1" />
                <path d="M1 7l2-4h10l2 4" />
                <path d="M8 11V4M5.5 6.5L8 4l2.5 2.5" />
              </svg>
            </button>
          ) : (
            <button
              onClick={() => handleArchiveThread(thread, projectId)}
              className="rounded p-1 hover:bg-white/10 transition-colors"
              style={{ color: 'var(--color-text-muted)' }}
              title="Archive thread"
            >
              {/* Archive: box with down arrow */}
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1" y="7" width="14" height="8" rx="1" />
                <path d="M1 7l2-4h10l2 4" />
                <path d="M8 9v6M5.5 12.5L8 15l2.5-2.5" />
              </svg>
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <aside
      className="flex w-60 flex-shrink-0 flex-col border-r overflow-hidden"
      style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <span className="font-semibold text-sm" style={{ color: 'var(--color-claude)' }}>
          PolyCode
        </span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setSlashCommandsDialogOpen(true)}
            className="flex items-center justify-center rounded p-1.5 opacity-60 hover:opacity-100 transition-opacity"
            title="Slash commands"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="16" y1="4" x2="8" y2="20" />
            </svg>
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
            className="text-xs px-2 py-1 rounded opacity-70 hover:opacity-100 transition-opacity"
            style={{ background: 'var(--color-surface-2)', color: 'var(--color-text)' }}
            title="New project"
          >
            + Project
          </button>
        </div>
      </div>

      {/* Search bar */}
      <div className="px-3 py-2 border-b flex-shrink-0" style={{ borderColor: 'var(--color-border)' }}>
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
            <div key={thread.id} className="group relative">
              <button
                onClick={() => selectThread(thread.id)}
                className="flex w-full items-center pl-4 pr-2 py-1.5 text-left text-xs transition-colors min-w-0"
                style={{
                  background: selectedThreadId === thread.id ? 'var(--color-border)' : 'transparent',
                  color: 'var(--color-text-muted)',
                }}
              >
                <span
                  className="mr-2 h-1.5 w-1.5 rounded-full flex-shrink-0"
                  style={{ background: statusMap[thread.id] === 'running' ? '#4ade80' : statusMap[thread.id] === 'error' ? '#f87171' : 'var(--color-text-muted)' }}
                />
                <span className="flex flex-col min-w-0">
                  <span className="truncate">{thread.name}</span>
                  <span className="text-[10px] leading-tight opacity-50">{projectName}</span>
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
          const runningThreads = projectThreads.filter((t) => statusMap[t.id] === 'running')

          return (
            <div key={project.id}>
              {/* Project row */}
              <div className="group relative">
                <button
                  onClick={() => handleToggleProject(project.id)}
                  className="flex w-full items-center px-4 py-2 text-left text-sm transition-colors min-w-0"
                  style={{
                    background: isExpanded ? 'var(--color-surface-2)' : 'transparent',
                    color: 'var(--color-text)'
                  }}
                >
                  <span className="mr-1.5 text-[10px] flex-shrink-0 opacity-50" style={{ width: '10px' }}>
                    {isExpanded ? '▾' : '▸'}
                  </span>
                  <span className="truncate">{project.name}</span>
                </button>
                {/* Project actions — absolutely positioned, overlay on hover */}
                <div
                  className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{ background: isExpanded ? 'var(--color-surface-2)' : 'var(--color-surface)' }}
                >
                  <button
                    onClick={() => setProjectDialog({ mode: 'edit', project })}
                    className="rounded p-1 text-xs hover:bg-white/10 transition-colors"
                    style={{ color: 'var(--color-text-muted)' }}
                    title="Edit project"
                  >
                    ✎
                  </button>
                  <button
                    onClick={() => handleArchiveProject(project.id)}
                    className="rounded p-1 hover:bg-white/10 transition-colors"
                    style={{ color: 'var(--color-text-muted)' }}
                    title="Archive project"
                  >
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="1" y="7" width="14" height="8" rx="1" />
                      <path d="M1 7l2-4h10l2 4" />
                      <path d="M8 9v6M5.5 12.5L8 15l2.5-2.5" />
                    </svg>
                  </button>
                  <button
                    onClick={() => setConfirmDelete({ type: 'project', id: project.id, name: project.name, projectId: project.id })}
                    className="rounded p-1 text-xs hover:bg-white/10 transition-colors"
                    style={{ color: 'var(--color-text-muted)' }}
                    title="Delete project"
                  >
                    ✕
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
                  {locations.map((loc) => {
                    const isLocationExpanded = !collapsedLocationIds.has(loc.id)
                    const locationThreads = projectThreads.filter((t) => t.location_id === loc.id)

                    return (
                      <div key={loc.id}>
                        {/* Location subheader */}
                        <div className="group relative">
                          <button
                            onClick={() => toggleLocationCollapsed(loc.id)}
                            className="flex w-full items-center pl-6 pr-2 py-1 text-left text-xs transition-colors min-w-0"
                            style={{ color: 'var(--color-text-muted)' }}
                          >
                            <span className="mr-1 text-[9px] flex-shrink-0 opacity-50" style={{ width: '8px' }}>
                              {isLocationExpanded ? '▾' : '▸'}
                            </span>
                            <span className="truncate opacity-70">{loc.label}</span>
                            {branchByLocation[loc.id] && (
                              <span className="ml-1 flex-shrink-0 opacity-50 text-[9px]">
                                ({branchByLocation[loc.id]})
                              </span>
                            )}
                            {connectionBadge(loc.connection_type)}
                          </button>
                        </div>

                        {/* New thread link */}
                        {isLocationExpanded && (
                          <button
                            onClick={() => handleNewThread(project.id, loc.id)}
                            className="flex w-full items-center pl-10 pr-2 py-0.5 text-left text-[10px] opacity-40 hover:opacity-80 transition-opacity"
                            style={{ color: 'var(--color-text-muted)' }}
                          >
                            + New thread
                          </button>
                        )}

                        {/* Threads under this location */}
                        {isLocationExpanded && locationThreads.map((thread) => renderThread(thread, false, project.id))}
                      </div>
                    )
                  })}

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
                      {showArchived ? `▾ Hide archived` : `▸ Archived (${projectArchivedCount})`}
                    </button>
                  )}

                  {/* Archived threads */}
                  {showArchived && projectArchivedThreads.map((thread) => renderThread(thread, true, project.id, 'pl-8'))}
                </div>
              )}
            </div>
          )
        })}

        {!searchQuery.trim() && projects.length === 0 && archivedProjects.length === 0 && (
          <p className="px-4 py-6 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
            No projects yet.
            <br />
            Click &quot;+ Project&quot; to add one.
          </p>
        )}

        {/* Archived projects section */}
        {!searchQuery.trim() && archivedProjects.length > 0 && (
          <div className="border-t mt-1" style={{ borderColor: 'var(--color-border)' }}>
            <button
              onClick={() => setArchivedSectionExpanded((v) => !v)}
              className="flex w-full items-center px-4 py-2 text-left text-xs transition-opacity opacity-40 hover:opacity-70"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <span className="mr-1.5 text-[10px] flex-shrink-0" style={{ width: '10px' }}>
                {archivedSectionExpanded ? '▾' : '▸'}
              </span>
              Archived ({archivedProjects.length})
            </button>

            {archivedSectionExpanded && archivedProjects.map((project) => (
              <div key={project.id} className="group relative">
                <div
                  className="flex w-full items-center px-4 py-2 text-sm min-w-0 opacity-40"
                  style={{ color: 'var(--color-text)' }}
                >
                  <span className="mr-1.5 flex-shrink-0 opacity-50" style={{ width: '10px' }} />
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
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="1" y="7" width="14" height="8" rx="1" />
                      <path d="M1 7l2-4h10l2 4" />
                      <path d="M8 11V4M5.5 6.5L8 4l2.5 2.5" />
                    </svg>
                  </button>
                  <button
                    onClick={() => setConfirmDelete({ type: 'project', id: project.id, name: project.name, projectId: project.id })}
                    className="rounded p-1 text-xs hover:bg-white/10 transition-colors"
                    style={{ color: 'var(--color-text-muted)' }}
                    title="Delete project"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Project create/edit dialog */}
      {projectDialog && (
        <ProjectDialog
          mode={projectDialog.mode}
          project={projectDialog.mode === 'edit' ? projectDialog.project : undefined}
          onClose={() => setProjectDialog(null)}
        />
      )}

      {/* Location create/edit dialog */}
      {locationDialog && (
        <LocationDialog
          mode={locationDialog.mode}
          projectId={locationDialog.projectId}
          location={locationDialog.mode === 'edit' ? locationDialog.location : undefined}
          onClose={() => {
            setLocationDialog(null)
            // Refresh locations after create/edit
            if (locationDialog.projectId) fetchLocations(locationDialog.projectId)
          }}
        />
      )}

      {/* Delete confirmation */}
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

      {/* YouTrack settings dialog */}
      {youtrackDialogOpen && (
        <YouTrackSettingsDialog onClose={() => setYoutrackDialogOpen(false)} />
      )}

      {/* Slash commands dialog */}
      {slashCommandsDialogOpen && (
        <SlashCommandsDialog
          projectId={selectedProjectId ?? null}
          projectName={projects.find((p) => p.id === selectedProjectId)?.name}
          onClose={() => setSlashCommandsDialogOpen(false)}
        />
      )}
    </aside>
  )
}
