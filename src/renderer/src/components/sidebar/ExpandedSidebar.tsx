import type { ReactNode } from 'react'
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, PanelLeft, Pencil, Plus, Settings, X } from 'lucide-react'
import { LocationPool, Project, RepoLocation, Thread, ThreadStatus } from '../../types/ipc'
import LocationSection from './LocationSection'
import ThreadRow from './ThreadRow'

const EMPTY_LOCATIONS: RepoLocation[] = []
const EMPTY_POOLS: LocationPool[] = []

interface ExpandedSidebarProps {
  projects: Project[]
  archivedProjects: Project[]
  projectsLoading: boolean
  selectedThreadId: string | null
  expandedProjectIds: Set<string>
  archivedSectionExpanded: boolean
  searchQuery: string
  byProject: Record<string, Thread[] | undefined>
  archivedByProject: Record<string, Thread[] | undefined>
  archivedCountByProject: Record<string, number | undefined>
  showArchived: boolean
  statusMap: Record<string, ThreadStatus | undefined>
  unreadByThread: Record<string, boolean | undefined>
  locationsByProject: Record<string, RepoLocation[] | undefined>
  poolsByProject: Record<string, LocationPool[] | undefined>
  collapsedLocationIds: Set<string>
  expandedAvailablePools: Set<string>
  pathExistsByLocation: Record<string, boolean>
  branchByLocation: Record<string, string>
  onToggleSidebar: () => void
  onSetSearchQuery: (query: string) => void
  onOpenSettings: () => void
  onOpenProjectDialog: () => void
  onEditProject: (project: Project) => void
  onToggleProject: (projectId: string) => void
  onArchiveProject: (projectId: string) => void | Promise<void>
  onUnarchiveProject: (projectId: string) => void | Promise<void>
  onConfirmDeleteProject: (project: Project) => void
  onToggleArchivedSection: () => void
  onToggleShowArchived: (projectId: string) => void
  onOpenLocationDialog: (projectId: string) => void
  onTogglePoolAvailableExpanded: (poolId: string) => void
  onToggleLocationCollapsed: (locationId: string) => void
  onCheckoutLocation: (locationId: string, projectId: string) => void | Promise<void>
  onReturnLocationToPool: (locationId: string, projectId: string) => void | Promise<void>
  onNewThread: (projectId: string, locationId: string) => void | Promise<void>
  onSelectThread: (threadId: string) => void
  onArchiveThread: (thread: Thread, projectId: string) => void | Promise<void>
  onUnarchiveThread: (thread: Thread, projectId: string) => void | Promise<void>
  dialogs: ReactNode
}

export default function ExpandedSidebar({
  projects,
  archivedProjects,
  projectsLoading,
  selectedThreadId,
  expandedProjectIds,
  archivedSectionExpanded,
  searchQuery,
  byProject,
  archivedByProject,
  archivedCountByProject,
  showArchived,
  statusMap,
  unreadByThread,
  locationsByProject,
  poolsByProject,
  collapsedLocationIds,
  expandedAvailablePools,
  pathExistsByLocation,
  branchByLocation,
  onToggleSidebar,
  onSetSearchQuery,
  onOpenSettings,
  onOpenProjectDialog,
  onEditProject,
  onToggleProject,
  onArchiveProject,
  onUnarchiveProject,
  onConfirmDeleteProject,
  onToggleArchivedSection,
  onToggleShowArchived,
  onOpenLocationDialog,
  onTogglePoolAvailableExpanded,
  onToggleLocationCollapsed,
  onCheckoutLocation,
  onReturnLocationToPool,
  onNewThread,
  onSelectThread,
  onArchiveThread,
  onUnarchiveThread,
  dialogs,
}: ExpandedSidebarProps) {
  return (
    <aside
      className="sidebar-transition flex flex-shrink-0 flex-col overflow-hidden border-r"
      style={{
        width: '240px',
        background: 'var(--color-surface)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div
        className="flex flex-shrink-0 items-center justify-between border-b px-3 py-2"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="flex items-center gap-2">
          <button
            onClick={onToggleSidebar}
            className="flex items-center justify-center rounded p-1 opacity-60 transition-opacity hover:opacity-100"
            style={{ color: 'var(--color-text-muted)' }}
            title="Collapse sidebar"
          >
            <PanelLeft size={16} />
          </button>
          <span className="text-sm font-semibold" style={{ color: 'var(--color-claude)' }}>
            PolyCode
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={onOpenSettings}
            className="flex items-center justify-center rounded p-1.5 opacity-60 transition-opacity hover:opacity-100"
            title="Settings"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <Settings size={14} />
          </button>
          <button
            onClick={onOpenProjectDialog}
            className="flex items-center justify-center rounded p-1.5 opacity-60 transition-opacity hover:opacity-100"
            style={{ color: 'var(--color-text-muted)' }}
            title="New project"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      <div className="border-b px-3 py-1.5 flex-shrink-0" style={{ borderColor: 'var(--color-border)' }}>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSetSearchQuery(e.target.value)}
          placeholder="Search threads…"
          className="w-full rounded px-2 py-1 text-xs outline-none"
          style={{
            background: 'var(--color-surface-2)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text)',
          }}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {searchQuery.trim() ? (() => {
          const query = searchQuery.trim().toLowerCase()
          const results: Array<{ thread: Thread; projectName: string }> = []

          for (const project of projects) {
            const threads = byProject[project.id] ?? []
            for (const thread of threads) {
              if (thread.name.toLowerCase().includes(query)) {
                results.push({ thread, projectName: project.name })
              }
            }
          }

          if (results.length === 0) {
            return (
              <p className="px-4 py-6 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
                No threads match &quot;{searchQuery.trim()}&quot;
              </p>
            )
          }

          return results.map(({ thread, projectName }) => (
            <div key={thread.id} className="group/thread relative">
              <button
                onClick={() => onSelectThread(thread.id)}
                className="flex w-full min-w-0 items-center pl-4 pr-2 py-1 text-left text-xs transition-colors"
                style={{
                  background: selectedThreadId === thread.id ? 'var(--color-border)' : 'transparent',
                  color: 'var(--color-text-muted)',
                }}
              >
                <span
                  className="mr-2 h-1.5 w-1.5 flex-shrink-0 rounded-full"
                  style={{
                    background:
                      (unreadByThread[thread.id] ?? !!thread.unread) ? '#22c55e'
                        : statusMap[thread.id] === 'running' ? '#4ade80'
                          : statusMap[thread.id] === 'error' ? '#f87171'
                            : 'var(--color-text-muted)',
                  }}
                />
                <span className="min-w-0 flex-1 truncate">{thread.name}</span>
                <span className="ml-1 flex-shrink-0 text-[10px] opacity-0 transition-opacity group-hover/thread:opacity-50">
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
          const runningThreads = projectThreads.filter((thread) => statusMap[thread.id] === 'running' || statusMap[thread.id] === 'stopping')

          return (
            <div key={project.id}>
              <div className="group relative">
                <button
                  onClick={() => onToggleProject(project.id)}
                  className="flex w-full min-w-0 items-center px-3 py-1.5 text-left text-sm transition-colors"
                  style={{
                    background: isExpanded ? 'var(--color-surface-2)' : 'transparent',
                    color: 'var(--color-text)',
                  }}
                >
                  {isExpanded
                    ? <ChevronDown size={12} className="mr-1.5 flex-shrink-0 opacity-50" />
                    : <ChevronRight size={12} className="mr-1.5 flex-shrink-0 opacity-50" />
                  }
                  <span className="truncate">{project.name}</span>
                </button>
                <div
                  className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                  style={{ background: isExpanded ? 'var(--color-surface-2)' : 'var(--color-surface)' }}
                >
                  <button
                    onClick={() => onEditProject(project)}
                    className="rounded p-1 transition-colors hover:bg-white/10"
                    style={{ color: 'var(--color-text-muted)' }}
                    title="Edit project"
                  >
                    <Pencil size={11} />
                  </button>
                  <button
                    onClick={() => onArchiveProject(project.id)}
                    className="rounded p-1 transition-colors hover:bg-white/10"
                    style={{ color: 'var(--color-text-muted)' }}
                    title="Archive project"
                  >
                    <Archive size={11} />
                  </button>
                  <button
                    onClick={() => onConfirmDeleteProject(project)}
                    className="rounded p-1 transition-colors hover:bg-white/10"
                    style={{ color: 'var(--color-text-muted)' }}
                    title="Delete project"
                  >
                    <X size={11} />
                  </button>
                </div>
              </div>

              {!isExpanded && runningThreads.length > 0 && (
                <div>
                  {runningThreads.map((thread) => (
                    <ThreadRow
                      key={thread.id}
                      thread={thread}
                      isArchived={false}
                      projectId={project.id}
                      indent="pl-8"
                      selectedThreadId={selectedThreadId}
                      statusMap={statusMap}
                      unreadByThread={unreadByThread}
                      branchByLocation={branchByLocation}
                      onSelectThread={onSelectThread}
                      onArchiveThread={onArchiveThread}
                      onUnarchiveThread={onUnarchiveThread}
                    />
                  ))}
                </div>
              )}

              {isExpanded && (
                <div>
                  {pools.length > 0 ? (
                    <>
                      {pools.map((pool) => {
                        const pooledLocations = locations.filter((location) => location.pool_id === pool.id)
                        const checkedOut = pooledLocations.filter((location) => location.checked_out)
                        const available = pooledLocations.filter((location) => !location.checked_out)
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
                                  onClick={() => onCheckoutLocation(available[0].id, project.id)}
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
                                  onClick={() => onTogglePoolAvailableExpanded(pool.id)}
                                  className="rounded px-1.5 py-0.5 text-[10px] hover:bg-white/10"
                                  style={{ color: 'var(--color-text-muted)' }}
                                >
                                  {showAvailable ? `Hide available (${available.length})` : `Show available (${available.length})`}
                                </button>
                              </div>
                            )}

                            {checkedOut.map((location) => (
                              <LocationSection
                                key={location.id}
                                projectId={project.id}
                                location={location}
                                projectThreads={projectThreads}
                                showPoolActions
                                collapsedLocationIds={collapsedLocationIds}
                                pathExistsByLocation={pathExistsByLocation}
                                branchByLocation={branchByLocation}
                                selectedThreadId={selectedThreadId}
                                statusMap={statusMap}
                                unreadByThread={unreadByThread}
                                onToggleLocationCollapsed={onToggleLocationCollapsed}
                                onNewThread={onNewThread}
                                onCheckoutLocation={onCheckoutLocation}
                                onReturnLocationToPool={onReturnLocationToPool}
                                onSelectThread={onSelectThread}
                                onArchiveThread={onArchiveThread}
                                onUnarchiveThread={onUnarchiveThread}
                              />
                            ))}

                            {showAvailable && available.map((location) => (
                              <LocationSection
                                key={location.id}
                                projectId={project.id}
                                location={location}
                                projectThreads={projectThreads}
                                showPoolActions
                                collapsedLocationIds={collapsedLocationIds}
                                pathExistsByLocation={pathExistsByLocation}
                                branchByLocation={branchByLocation}
                                selectedThreadId={selectedThreadId}
                                statusMap={statusMap}
                                unreadByThread={unreadByThread}
                                onToggleLocationCollapsed={onToggleLocationCollapsed}
                                onNewThread={onNewThread}
                                onCheckoutLocation={onCheckoutLocation}
                                onReturnLocationToPool={onReturnLocationToPool}
                                onSelectThread={onSelectThread}
                                onArchiveThread={onArchiveThread}
                                onUnarchiveThread={onUnarchiveThread}
                              />
                            ))}
                          </div>
                        )
                      })}

                      {locations
                        .filter((location) => !location.pool_id)
                        .map((location) => (
                          <LocationSection
                            key={location.id}
                            projectId={project.id}
                            location={location}
                            projectThreads={projectThreads}
                            collapsedLocationIds={collapsedLocationIds}
                            pathExistsByLocation={pathExistsByLocation}
                            branchByLocation={branchByLocation}
                            selectedThreadId={selectedThreadId}
                            statusMap={statusMap}
                            unreadByThread={unreadByThread}
                            onToggleLocationCollapsed={onToggleLocationCollapsed}
                            onNewThread={onNewThread}
                            onCheckoutLocation={onCheckoutLocation}
                            onReturnLocationToPool={onReturnLocationToPool}
                            onSelectThread={onSelectThread}
                            onArchiveThread={onArchiveThread}
                            onUnarchiveThread={onUnarchiveThread}
                          />
                        ))}
                    </>
                  ) : (
                    <>
                      {locations.map((location) => (
                        <LocationSection
                          key={location.id}
                          projectId={project.id}
                          location={location}
                          projectThreads={projectThreads}
                          collapsedLocationIds={collapsedLocationIds}
                          pathExistsByLocation={pathExistsByLocation}
                          branchByLocation={branchByLocation}
                          selectedThreadId={selectedThreadId}
                          statusMap={statusMap}
                          unreadByThread={unreadByThread}
                          onToggleLocationCollapsed={onToggleLocationCollapsed}
                          onNewThread={onNewThread}
                          onCheckoutLocation={onCheckoutLocation}
                          onReturnLocationToPool={onReturnLocationToPool}
                          onSelectThread={onSelectThread}
                          onArchiveThread={onArchiveThread}
                          onUnarchiveThread={onUnarchiveThread}
                        />
                      ))}
                    </>
                  )}

                  {projectThreads
                    .filter((thread) => !thread.location_id || !locations.some((location) => location.id === thread.location_id))
                    .map((thread) => (
                      <ThreadRow
                        key={thread.id}
                        thread={thread}
                        isArchived={false}
                        projectId={project.id}
                        indent="pl-8"
                        selectedThreadId={selectedThreadId}
                        statusMap={statusMap}
                        unreadByThread={unreadByThread}
                        branchByLocation={branchByLocation}
                        onSelectThread={onSelectThread}
                        onArchiveThread={onArchiveThread}
                        onUnarchiveThread={onUnarchiveThread}
                      />
                    ))}

                  {locations.length === 0 && projectThreads.length === 0 && (
                    <button
                      onClick={() => onOpenLocationDialog(project.id)}
                      className="flex w-full items-center pl-6 pr-4 py-2 text-left text-xs opacity-50 transition-opacity hover:opacity-80"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      + Add a location to get started
                    </button>
                  )}

                  {(projectArchivedCount > 0 || showArchived) && (
                    <button
                      onClick={() => onToggleShowArchived(project.id)}
                      className="flex w-full items-center pl-6 pr-4 py-1 text-left text-[10px] opacity-40 transition-opacity hover:opacity-70"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      {showArchived ? (
                        <><ChevronDown size={9} className="mr-1" /> Hide archived</>
                      ) : (
                        <><ChevronRight size={9} className="mr-1" /> Archived ({projectArchivedCount})</>
                      )}
                    </button>
                  )}

                  {showArchived && projectArchivedThreads.map((thread) => (
                    <ThreadRow
                      key={thread.id}
                      thread={thread}
                      isArchived
                      projectId={project.id}
                      indent="pl-8"
                      selectedThreadId={selectedThreadId}
                      statusMap={statusMap}
                      unreadByThread={unreadByThread}
                      branchByLocation={branchByLocation}
                      onSelectThread={onSelectThread}
                      onArchiveThread={onArchiveThread}
                      onUnarchiveThread={onUnarchiveThread}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}

        {!searchQuery.trim() && projectsLoading && projects.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-6" style={{ color: 'var(--color-text-muted)' }}>
            <div className="status-spinner h-3 w-3" />
            <span className="text-xs">Loading…</span>
          </div>
        )}

        {!searchQuery.trim() && !projectsLoading && projects.length === 0 && archivedProjects.length === 0 && (
          <p className="px-4 py-6 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
            No projects yet.
            <br />
            Click <Plus size={10} className="inline" /> to add one.
          </p>
        )}

        {!searchQuery.trim() && archivedProjects.length > 0 && (
          <div className="mt-1 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <button
              onClick={onToggleArchivedSection}
              className="flex w-full items-center px-3 py-1.5 text-left text-xs opacity-40 transition-opacity hover:opacity-70"
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
                  className="flex w-full min-w-0 items-center px-3 py-1.5 text-sm opacity-40"
                  style={{ color: 'var(--color-text)' }}
                >
                  <span className="mr-1.5 flex-shrink-0 opacity-50" style={{ width: '12px' }} />
                  <span className="truncate">{project.name}</span>
                </div>
                <div
                  className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                  style={{ background: 'var(--color-surface)' }}
                >
                  <button
                    onClick={() => onUnarchiveProject(project.id)}
                    className="rounded p-1 transition-colors hover:bg-white/10"
                    style={{ color: 'var(--color-text-muted)' }}
                    title="Unarchive project"
                  >
                    <ArchiveRestore size={11} />
                  </button>
                  <button
                    onClick={() => onConfirmDeleteProject(project)}
                    className="rounded p-1 transition-colors hover:bg-white/10"
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

      {dialogs}
    </aside>
  )
}
