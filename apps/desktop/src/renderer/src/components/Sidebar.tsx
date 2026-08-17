import { useEffect, useMemo, useRef, useState } from 'react'
import { useCommandStore, instKey } from '../stores/commands'
import { useLocationStore } from '../stores/locations'
import { useProjectStore, sortProjects } from '../stores/projects'
import { useThreadStore } from '../stores/threads'
import { useToastStore } from '../stores/toast'
import { useUiStore } from '../stores/ui'
import { useYouTrackStore } from '../stores/youtrack'
import { Project, QueueThread, RepoLocation, Thread, ThreadStatus } from '../types/ipc'
import { formatErrorDetails } from '../lib/errorDetails'
import { subscribeToSidebarBranches } from '../lib/sidebarBranchRefresh'
import CollapsedSidebar from './sidebar/CollapsedSidebar'
import ExpandedSidebar from './sidebar/ExpandedSidebar'
import QueueSidebar from './sidebar/QueueSidebar'
import SidebarDialogs, {
  SidebarConfirmDeleteState,
  SidebarLocationDialogState,
  SidebarProjectDialogState,
} from './sidebar/SidebarDialogs'
import { useSidebar } from './ui/sidebar-context'

function playChime() {
  try {
    const ctx = new AudioContext()
    const now = ctx.currentTime

    // Two-tone chime: C5 then E5
    for (const [freq, start] of [[523.25, 0], [659.25, 0.12]] as const) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.18, now + start)
      gain.gain.exponentialRampToValueAtTime(0.001, now + start + 0.35)
      osc.connect(gain).connect(ctx.destination)
      osc.start(now + start)
      osc.stop(now + start + 0.35)
    }

    // Clean up context after sounds finish
    setTimeout(() => ctx.close(), 600)
  } catch {
    // Audio not available — silently ignore
  }
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
  const expandProject = useProjectStore((s) => s.expand)
  const removeProject = useProjectStore((s) => s.remove)
  const archiveProject = useProjectStore((s) => s.archive)
  const unarchiveProject = useProjectStore((s) => s.unarchive)
  const sortMode = useProjectStore((s) => s.sortMode)
  const setSortMode = useProjectStore((s) => s.setSortMode)
  const loadSortMode = useProjectStore((s) => s.loadSortMode)
  const touchProject = useProjectStore((s) => s.touch)

  const byProject = useThreadStore((s) => s.byProject)
  const archivedByProject = useThreadStore((s) => s.archivedByProject)
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId)
  const statusMap = useThreadStore((s) => s.statusMap)
  const unreadByThread = useThreadStore((s) => s.unreadByThread)
  const expandedArchivedProjectId = useThreadStore((s) => s.expandedArchivedProjectId)
  const archivedCountByProject = useThreadStore((s) => s.archivedCountByProject)
  const archivedPageByProject = useThreadStore((s) => s.archivedPageByProject)
  const fetchThreads = useThreadStore((s) => s.fetch)
  const openDraftThread = useThreadStore((s) => s.openDraftThread)
  const removeThread = useThreadStore((s) => s.remove)
  const archiveThread = useThreadStore((s) => s.archive)
  const unarchiveThread = useThreadStore((s) => s.unarchive)
  const toggleShowArchived = useThreadStore((s) => s.toggleShowArchived)
  const addToast = useToastStore((s) => s.add)
  const setArchivedPage = useThreadStore((s) => s.setArchivedPage)
  const selectThread = useThreadStore((s) => s.select)
  const setName = useThreadStore((s) => s.setName)
  const setUnread = useThreadStore((s) => s.setUnread)
  const setStatus = useThreadStore((s) => s.setStatus)
  const queueThreads = useThreadStore((s) => s.queueThreads)
  const fetchQueue = useThreadStore((s) => s.fetchQueue)

  const sidebarViewMode = useUiStore((s) => s.sidebarViewMode)
  const setSidebarViewMode = useUiStore((s) => s.setSidebarViewMode)
  const loadSidebarViewMode = useUiStore((s) => s.loadSidebarViewMode)
  const sidebarWidth = useUiStore((s) => s.sidebarWidth)
  const sidebarResizing = useUiStore((s) => s.sidebarResizing)
  const loadSidebarWidth = useUiStore((s) => s.loadSidebarWidth)

  const locationsByProject = useLocationStore((s) => s.byProject)
  const poolsByProject = useLocationStore((s) => s.poolsByProject)
  const deletingWorktreesByProject = useLocationStore((s) => s.deletingWorktreesByProject)
  const fetchLocations = useLocationStore((s) => s.fetch)
  const fetchPools = useLocationStore((s) => s.fetchPools)
  const checkoutLocation = useLocationStore((s) => s.checkout)
  const returnLocationToPool = useLocationStore((s) => s.returnToPool)
  const removeWorktreeLocation = useLocationStore((s) => s.removeWorktree)

  const fetchYouTrackServers = useYouTrackStore((s) => s.fetch)
  const commandByProject = useCommandStore((s) => s.byProject)
  const fetchCommands = useCommandStore((s) => s.fetch)
  const fetchCommandStatuses = useCommandStore((s) => s.fetchStatuses)
  const setCommandStatus = useCommandStore((s) => s.setStatus)

  const sortedProjects = useMemo(() => {
    // Latest thread activity per project from already-loaded threads — keeps the
    // order correct live, on top of the DB-computed last_activity_at.
    const activityByProject: Record<string, number> = {}
    for (const [projectId, threads] of Object.entries(byProject)) {
      for (const thread of threads) {
        const time = new Date(thread.updated_at).getTime()
        if (!Number.isNaN(time) && time > (activityByProject[projectId] ?? 0)) {
          activityByProject[projectId] = time
        }
      }
    }
    return sortProjects(projects, sortMode, activityByProject)
  }, [projects, sortMode, byProject])

  const [searchQuery, setSearchQuery] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [projectDialog, setProjectDialog] = useState<SidebarProjectDialogState | null>(null)
  const [locationDialog, setLocationDialog] = useState<SidebarLocationDialogState | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<SidebarConfirmDeleteState | null>(null)
  const [collapsedLocationIds, setCollapsedLocationIds] = useState<Set<string>>(new Set())
  const [archivedSectionExpanded, setArchivedSectionExpanded] = useState(false)
  const [branchByLocation, setBranchByLocation] = useState<Record<string, string>>({})
  const [expandedAvailablePools, setExpandedAvailablePools] = useState<Set<string>>(new Set())
  const [pathExistsByLocation, setPathExistsByLocation] = useState<Record<string, boolean>>({})

  const subsRef = useRef<Map<string, Array<() => void>>>(new Map())
  const commandSubsRef = useRef<Map<string, () => void>>(new Map())

  useEffect(() => {
    const projectByThread = new Map<string, string>()
    for (const [projectId, threads] of Object.entries(byProject)) {
      for (const thread of threads) {
        projectByThread.set(thread.id, projectId)
      }
    }
    // Queue threads span projects that may not be loaded into byProject —
    // subscribe to their events too so the Queue stays live.
    for (const thread of queueThreads) {
      if (!projectByThread.has(thread.id)) {
        projectByThread.set(thread.id, thread.project_id)
      }
    }

    const refreshQueueIfActive = () => {
      if (useUiStore.getState().sidebarViewMode === 'queue') {
        void useThreadStore.getState().fetchQueue()
      }
    }

    for (const [threadId, projectId] of projectByThread) {
      if (!subsRef.current.has(threadId)) {
        const unsubTitle = window.api.on(`thread:title:${threadId}`, (...args) => {
          setName(threadId, args[0] as string)
        })
        const unsubStatus = window.api.on(`thread:status:${threadId}`, (...args) => {
          const status = args[0] as 'idle' | 'running' | 'stopping' | 'error' | 'stopped'
          setStatus(threadId, status)
          if (status === 'running') touchProject(projectId)
          refreshQueueIfActive()
        })
        const unsubComplete = window.api.on(`thread:complete:${threadId}`, (...args) => {
          const currentStatus = useThreadStore.getState().statusMap[threadId]
          const completionStatus = args[0] as ThreadStatus | undefined
          if (currentStatus === 'running' || currentStatus === 'stopping') {
            setStatus(threadId, completionStatus ?? 'idle')
          }
          touchProject(projectId)

          const selectedId = useThreadStore.getState().selectedThreadId
          if (selectedId !== threadId) {
            setUnread(threadId, true)
            playChime()
          }
          refreshQueueIfActive()
        })
        subsRef.current.set(threadId, [unsubTitle, unsubStatus, unsubComplete])
      }
    }

    for (const [threadId, unsubs] of subsRef.current) {
      if (!projectByThread.has(threadId)) {
        unsubs.forEach((unsubscribe) => unsubscribe())
        subsRef.current.delete(threadId)
      }
    }
  }, [byProject, queueThreads, setName, setStatus, setUnread, touchProject])

  useEffect(() => {
    const threadSubscriptions = subsRef.current
    const commandSubscriptions = commandSubsRef.current
    return () => {
      for (const unsubs of threadSubscriptions.values()) {
        unsubs.forEach((unsubscribe) => unsubscribe())
      }
      threadSubscriptions.clear()
      for (const unsubscribe of commandSubscriptions.values()) {
        unsubscribe()
      }
      commandSubscriptions.clear()
    }
  }, [])

  useEffect(() => {
    const expandedProjectList = Array.from(expandedProjectIds)
    for (const projectId of expandedProjectList) {
      if (!commandByProject[projectId]) {
        void fetchCommands(projectId)
      }
    }
  }, [commandByProject, expandedProjectIds, fetchCommands])

  useEffect(() => {
    const activeKeys = new Set<string>()

    for (const projectId of expandedProjectIds) {
      const commands = commandByProject[projectId] ?? []
      const locations = locationsByProject[projectId] ?? []
      if (commands.length === 0 || locations.length === 0) continue

      for (const location of locations) {
        void fetchCommandStatuses(projectId, location.id)
        for (const command of commands) {
          const key = instKey(command.id, location.id)
          activeKeys.add(key)
          if (!commandSubsRef.current.has(key)) {
            const unsubscribe = window.api.on(`command:status:${key}`, (status) => {
              setCommandStatus(key, status as 'idle' | 'running' | 'stopping' | 'error' | 'stopped')
            })
            commandSubsRef.current.set(key, unsubscribe)
          }
        }
      }
    }

    for (const [key, unsubscribe] of commandSubsRef.current) {
      if (activeKeys.has(key)) continue
      unsubscribe()
      commandSubsRef.current.delete(key)
    }
  }, [commandByProject, expandedProjectIds, fetchCommandStatuses, locationsByProject, setCommandStatus])

  useEffect(() => {
    fetchYouTrackServers()
  }, [fetchYouTrackServers])

  useEffect(() => {
    void loadSortMode()
    void loadSidebarViewMode()
    void loadSidebarWidth()
  }, [loadSortMode, loadSidebarViewMode, loadSidebarWidth])

  // The Queue needs its cross-project list whenever the queue view is active.
  useEffect(() => {
    if (sidebarViewMode === 'queue') void fetchQueue()
  }, [sidebarViewMode, fetchQueue])

  // Refresh thread list when a webhook creates a thread in this project
  useEffect(() => {
    const unsub = window.api.on('webhook:thread-created', (...args) => {
      const { projectId } = args[0] as { projectId: string; threadId: string }
      fetchThreads(projectId)
      touchProject(projectId)
      if (useUiStore.getState().sidebarViewMode === 'queue') void fetchQueue()
    })
    return unsub
  }, [fetchThreads, fetchQueue, touchProject])

  useEffect(() => {
    const visibleLocations = Array.from(expandedProjectIds).flatMap(
      (projectId) => locationsByProject[projectId] ?? [],
    )
    return subscribeToSidebarBranches(visibleLocations, (branches) => {
      setBranchByLocation((prev) => {
        let changed = false
        const next = { ...prev }
        for (const [id, branch] of branches) {
          if (!branch) continue
          if (next[id] === branch) continue
          next[id] = branch
          changed = true
        }
        return changed ? next : prev
      })
    })
  }, [expandedProjectIds, locationsByProject])

  useEffect(() => {
    for (const projectId of expandedProjectIds) {
      const locations = locationsByProject[projectId] ?? []
      for (const location of locations) {
        if (location.connection_type !== 'local') continue
        window.api.invoke('locations:pathExists', location.path).then((exists) => {
          setPathExistsByLocation((prev) => {
            if (prev[location.id] === exists) return prev
            return { ...prev, [location.id]: exists }
          })
        }).catch(() => {})
      }
    }
  }, [expandedProjectIds, locationsByProject])

  function handleToggleProject(projectId: string): void {
    toggleExpanded(projectId)
    if (!expandedProjectIds.has(projectId)) {
      selectProject(projectId)
    }
    if (!byProject[projectId]) fetchThreads(projectId)
    if (!locationsByProject[projectId]) fetchLocations(projectId)
    if (!poolsByProject[projectId]) fetchPools(projectId)
  }

  /**
   * Opens the create-on-send composer prefilled with this destination. The
   * Thread only materializes when the first message is sent.
   */
  function handleNewThread(projectId: string, locationId: string): void {
    openDraftThread(projectId, locationId)
    selectProject(projectId)
    window.dispatchEvent(new Event('focus-input'))
  }

  /** Queue rows select like tree rows, loading the project's data on demand. */
  function handleQueueSelectThread(thread: QueueThread): void {
    selectProject(thread.project_id)
    if (!byProject[thread.project_id]) fetchThreads(thread.project_id)
    if (!locationsByProject[thread.project_id]) fetchLocations(thread.project_id)
    if (!poolsByProject[thread.project_id]) fetchPools(thread.project_id)
    selectThread(thread.id)
  }

  /** Archiving is the Queue's "done with it" gesture. */
  async function handleQueueArchiveThread(thread: QueueThread): Promise<void> {
    if (useThreadStore.getState().selectedThreadId === thread.id) {
      selectThread(null)
    }
    await archiveThread(thread.id, thread.project_id)
    void fetchQueue()
  }

  async function handleQueueUnarchiveThread(thread: QueueThread): Promise<void> {
    await unarchiveThread(thread.id, thread.project_id)
    // The tree's per-project list only learns about the revived thread on refetch.
    if (byProject[thread.project_id]) void fetchThreads(thread.project_id)
    void fetchQueue()
  }

  /**
   * Opens the new-thread composer from anywhere, defaulting to the most
   * relevant destination: the selected thread's, else the newest Queue
   * thread's, else the first project's first active location.
   */
  async function handleOpenNewThreadComposer(): Promise<void> {
    const threadState = useThreadStore.getState()
    const selectedThread = Object.values(threadState.byProject).flat()
      .find((t) => t.id === threadState.selectedThreadId)
    const seed = selectedThread?.location_id
      ? selectedThread
      : threadState.queueThreads.find((t) => t.location_id)
    if (seed?.location_id) {
      handleNewThread(seed.project_id, seed.location_id)
      return
    }

    const project = sortedProjects[0]
    if (!project) {
      setProjectDialog({ mode: 'create' })
      return
    }
    const locations = locationsByProject[project.id]
      ?? await window.api.invoke('locations:list', project.id) as RepoLocation[]
    const activeLocation = locations.find((location) => !location.pool_id || location.checked_out)
    if (activeLocation) {
      handleNewThread(project.id, activeLocation.id)
    }
  }

  // After a project is created, reveal it and drop the user straight into a fresh thread.
  async function handleProjectCreated(project: Project): Promise<void> {
    setProjectDialog(null)
    selectProject(project.id)
    expandProject(project.id)
    await Promise.all([fetchThreads(project.id), fetchLocations(project.id), fetchPools(project.id)])
    const locations = await window.api.invoke('locations:list', project.id) as RepoLocation[]
    const activeLocation = locations.find((location) => !location.pool_id || location.checked_out)
    if (!activeLocation) return
    handleNewThread(project.id, activeLocation.id)
  }

  /**
   * Opens the composer with "new worktree of this location" intent. The
   * worktree, like the Thread, is only created when the first message is sent.
   */
  function handleNewWorktreeThread(projectId: string, parentLocationId: string): void {
    openDraftThread(projectId, parentLocationId, { newWorktree: true })
    selectProject(projectId)
    window.dispatchEvent(new Event('focus-input'))
  }

  async function handleRemoveWorktree(location: RepoLocation, projectId: string): Promise<void> {
    const projectThreads = useThreadStore.getState().byProject[projectId] ?? []
    const hasRunningThread = projectThreads.some((thread) =>
      thread.location_id === location.id &&
      (useThreadStore.getState().statusMap[thread.id] === 'running' || useThreadStore.getState().statusMap[thread.id] === 'stopping')
    )
    if (hasRunningThread) return
    if (!window.confirm(`Remove worktree "${location.label}"?\n\n${location.path}`)) return
    try {
      await removeWorktreeLocation(location.id, projectId)
      await fetchThreads(projectId)
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Remove Worktree Failed',
        message: err instanceof Error ? err.message : 'Failed to remove worktree',
        details: formatErrorDetails({ action: 'locations:removeWorktree', projectId, location }, err),
        duration: 0,
      })
    }
  }

  async function handleDeleteProject(projectId: string): Promise<void> {
    await removeProject(projectId)
    setConfirmDelete(null)
  }

  async function handleArchiveProject(projectId: string): Promise<void> {
    await archiveProject(projectId)
  }

  async function handleUnarchiveProject(projectId: string): Promise<void> {
    await unarchiveProject(projectId)
  }

  async function handleDeleteThread(threadId: string, projectId: string): Promise<void> {
    await removeThread(threadId, projectId)
    setConfirmDelete(null)
  }

  async function handleArchiveThread(thread: Thread, projectId: string): Promise<void> {
    // The create-on-send draft has no DB row — archiving it just discards it.
    if (thread.is_pending) {
      useThreadStore.getState().discardDraftThread()
      return
    }

    const currentThreads = useThreadStore.getState().byProject[projectId] ?? []
    const remainingThreads = currentThreads.filter((candidate) => candidate.id !== thread.id)
    const latestThreadInLocation = thread.location_id
      ? remainingThreads
        .filter((candidate) => candidate.location_id === thread.location_id)
        .slice()
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0]
      : null

    if (latestThreadInLocation) {
      selectThread(latestThreadInLocation.id)
    } else if (thread.location_id) {
      openDraftThread(projectId, thread.location_id)
    } else {
      const latestThread = remainingThreads
        .slice()
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0]

      if (latestThread) {
        selectThread(latestThread.id)
      } else {
        const loadedLocations = locationsByProject[projectId] ?? []
        const loadedActiveLocations = loadedLocations.filter((location) => !location.pool_id || location.checked_out)
        let locationId = loadedActiveLocations[0]?.id ?? null

        if (!locationId) {
          const fetchedLocations = await window.api.invoke('locations:list', projectId) as RepoLocation[]
          const fetchedActiveLocations = fetchedLocations.filter((location) => !location.pool_id || location.checked_out)
          locationId = fetchedActiveLocations[0]?.id ?? null
        }

        if (locationId) {
          openDraftThread(projectId, locationId)
        } else {
          selectThread(null)
        }
      }
    }

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

  function togglePoolAvailableExpanded(poolId: string): void {
    setExpandedAvailablePools((prev) => {
      const next = new Set(prev)
      if (next.has(poolId)) next.delete(poolId)
      else next.add(poolId)
      return next
    })
  }

  const dialogs = (
    <SidebarDialogs
      projectDialog={projectDialog}
      locationDialog={locationDialog}
      confirmDelete={confirmDelete}
      settingsOpen={settingsOpen}
      selectedProjectId={selectedProjectId}
      selectedProjectName={projects.find((project) => project.id === selectedProjectId)?.name}
      onCloseProjectDialog={() => setProjectDialog(null)}
      onProjectCreated={handleProjectCreated}
      onCloseLocationDialog={(projectId) => {
        setLocationDialog(null)
        fetchLocations(projectId)
      }}
      onCloseConfirmDelete={() => setConfirmDelete(null)}
      onDeleteProject={handleDeleteProject}
      onDeleteThread={handleDeleteThread}
      onCloseSettings={() => setSettingsOpen(false)}
    />
  )

  if (isCollapsed) {
    return (
      <CollapsedSidebar
      projects={sortedProjects}
      byProject={byProject}
      statusMap={statusMap}
      selectedProjectId={selectedProjectId}
        onToggleSidebar={toggle}
        onToggleProject={handleToggleProject}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenProjectDialog={() => setProjectDialog({ mode: 'create' })}
        dialogs={dialogs}
      />
    )
  }

  if (sidebarViewMode === 'queue') {
    return (
      <QueueSidebar
        queueThreads={queueThreads}
        statusMap={statusMap}
        unreadByThread={unreadByThread}
        selectedThreadId={selectedThreadId}
        sidebarWidth={sidebarWidth}
        sidebarResizing={sidebarResizing}
        onToggleSidebar={toggle}
        onSetViewMode={setSidebarViewMode}
        onOpenSettings={() => setSettingsOpen(true)}
        onNewThread={handleOpenNewThreadComposer}
        onSelectThread={handleQueueSelectThread}
        onArchiveThread={handleQueueArchiveThread}
        onUnarchiveThread={handleQueueUnarchiveThread}
        dialogs={dialogs}
      />
    )
  }

  return (
    <ExpandedSidebar
      projects={sortedProjects}
      archivedProjects={archivedProjects}
      projectsLoading={projectsLoading}
      sortMode={sortMode}
      onToggleSortMode={() => setSortMode(sortMode === 'alphabetical' ? 'lastMessage' : 'alphabetical')}
      onSetViewMode={setSidebarViewMode}
      sidebarWidth={sidebarWidth}
      sidebarResizing={sidebarResizing}
      selectedThreadId={selectedThreadId}
      expandedProjectIds={expandedProjectIds}
      archivedSectionExpanded={archivedSectionExpanded}
      searchQuery={searchQuery}
      byProject={byProject}
      archivedByProject={archivedByProject}
      archivedCountByProject={archivedCountByProject}
      expandedArchivedProjectId={expandedArchivedProjectId}
      archivedPageByProject={archivedPageByProject}
      statusMap={statusMap}
      unreadByThread={unreadByThread}
      locationsByProject={locationsByProject}
      poolsByProject={poolsByProject}
      deletingWorktreesByProject={deletingWorktreesByProject}
      collapsedLocationIds={collapsedLocationIds}
      expandedAvailablePools={expandedAvailablePools}
      pathExistsByLocation={pathExistsByLocation}
      branchByLocation={branchByLocation}
      onToggleSidebar={toggle}
      onSetSearchQuery={setSearchQuery}
      onOpenSettings={() => setSettingsOpen(true)}
      onOpenProjectDialog={() => setProjectDialog({ mode: 'create' })}
      onEditProject={(project: Project) => setProjectDialog({ mode: 'edit', project })}
      onToggleProject={handleToggleProject}
      onArchiveProject={handleArchiveProject}
      onUnarchiveProject={handleUnarchiveProject}
      onConfirmDeleteProject={(project) => setConfirmDelete({ type: 'project', id: project.id, name: project.name, projectId: project.id })}
      onToggleArchivedSection={() => setArchivedSectionExpanded((value) => !value)}
      onToggleShowArchived={toggleShowArchived}
      onSetArchivedPage={setArchivedPage}
      onOpenLocationDialog={(projectId) => setLocationDialog({ mode: 'create', projectId })}
      onTogglePoolAvailableExpanded={togglePoolAvailableExpanded}
      onToggleLocationCollapsed={toggleLocationCollapsed}
      onCheckoutLocation={checkoutLocation}
      onReturnLocationToPool={returnLocationToPool}
      onNewThread={handleNewThread}
      onNewWorktreeThread={handleNewWorktreeThread}
      onRemoveWorktree={handleRemoveWorktree}
      onSelectThread={selectThread}
      onArchiveThread={handleArchiveThread}
      onUnarchiveThread={handleUnarchiveThread}
      dialogs={dialogs}
    />
  )
}
