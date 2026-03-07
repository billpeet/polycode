import { useEffect, useRef, useState } from 'react'
import { useLocationStore } from '../stores/locations'
import { useProjectStore } from '../stores/projects'
import { useThreadStore } from '../stores/threads'
import { useYouTrackStore } from '../stores/youtrack'
import { Project, RepoLocation, Thread, ThreadStatus } from '../types/ipc'
import CollapsedSidebar from './sidebar/CollapsedSidebar'
import ExpandedSidebar from './sidebar/ExpandedSidebar'
import SidebarDialogs, {
  SidebarConfirmDeleteState,
  SidebarLocationDialogState,
  SidebarProjectDialogState,
} from './sidebar/SidebarDialogs'
import { useSidebar } from './ui/sidebar-context'

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
  const setStatus = useThreadStore((s) => s.setStatus)

  const locationsByProject = useLocationStore((s) => s.byProject)
  const poolsByProject = useLocationStore((s) => s.poolsByProject)
  const fetchLocations = useLocationStore((s) => s.fetch)
  const fetchPools = useLocationStore((s) => s.fetchPools)
  const checkoutLocation = useLocationStore((s) => s.checkout)
  const returnLocationToPool = useLocationStore((s) => s.returnToPool)

  const fetchYouTrackServers = useYouTrackStore((s) => s.fetch)

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

  useEffect(() => {
    const allThreadIds = new Set<string>()
    for (const threads of Object.values(byProject)) {
      for (const thread of threads) {
        allThreadIds.add(thread.id)
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
        unsubs.forEach((unsubscribe) => unsubscribe())
        subsRef.current.delete(threadId)
      }
    }
  }, [byProject, setName, setStatus, setUnread])

  useEffect(() => {
    return () => {
      for (const unsubs of subsRef.current.values()) {
        unsubs.forEach((unsubscribe) => unsubscribe())
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
        for (const location of locations) {
          locationPairs.push({ id: location.id, path: location.path })
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
    const interval = setInterval(() => {
      void refreshBranches()
    }, 10000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
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

  async function handleNewThread(projectId: string, locationId: string): Promise<void> {
    await createThread(projectId, 'New thread', locationId)
    selectProject(projectId)
    window.dispatchEvent(new Event('focus-input'))
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
    await archiveThread(thread.id, projectId)

    const latestThread = (useThreadStore.getState().byProject[projectId] ?? [])
      .slice()
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0]

    if (latestThread) {
      selectThread(latestThread.id)
      return
    }

    const loadedLocations = locationsByProject[projectId] ?? []
    const loadedActiveLocations = loadedLocations.filter((location) => !location.pool_id || location.checked_out)
    let locationId = loadedActiveLocations[0]?.id ?? null

    if (!locationId) {
      const fetchedLocations = await window.api.invoke('locations:list', projectId) as RepoLocation[]
      const fetchedActiveLocations = fetchedLocations.filter((location) => !location.pool_id || location.checked_out)
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

  const dialogs = (
    <SidebarDialogs
      projectDialog={projectDialog}
      locationDialog={locationDialog}
      confirmDelete={confirmDelete}
      settingsOpen={settingsOpen}
      selectedProjectId={selectedProjectId}
      selectedProjectName={projects.find((project) => project.id === selectedProjectId)?.name}
      onCloseProjectDialog={() => setProjectDialog(null)}
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
      projects={projects}
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

  return (
    <ExpandedSidebar
      projects={projects}
      archivedProjects={archivedProjects}
      projectsLoading={projectsLoading}
      selectedThreadId={selectedThreadId}
      expandedProjectIds={expandedProjectIds}
      archivedSectionExpanded={archivedSectionExpanded}
      searchQuery={searchQuery}
      byProject={byProject}
      archivedByProject={archivedByProject}
      archivedCountByProject={archivedCountByProject}
      showArchived={showArchived}
      statusMap={statusMap}
      unreadByThread={unreadByThread}
      locationsByProject={locationsByProject}
      poolsByProject={poolsByProject}
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
      onOpenLocationDialog={(projectId) => setLocationDialog({ mode: 'create', projectId })}
      onTogglePoolAvailableExpanded={togglePoolAvailableExpanded}
      onToggleLocationCollapsed={toggleLocationCollapsed}
      onCheckoutLocation={checkoutLocation}
      onReturnLocationToPool={returnLocationToPool}
      onNewThread={handleNewThread}
      onSelectThread={selectThread}
      onArchiveThread={handleArchiveThread}
      onUnarchiveThread={handleUnarchiveThread}
      dialogs={dialogs}
    />
  )
}
