import type { ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { LocationPool, RepoLocation, Thread, ThreadStatus } from '../../types/ipc'
import LocationSection from './LocationSection'
import RoutinesSection from './RoutinesSection'
import ThreadRow from './ThreadRow'

/**
 * One Project's tree under its header row: the running/unread preview while collapsed,
 * and when expanded its pools and Locations (each with its Threads), orphan Threads,
 * Routines, and the paged Snoozed and Archived sections.
 *
 * Shared by the single-source tree and the unified ("All") view, which renders one of
 * these per source a merged Project lives on. Everything is passed in, so the caller
 * decides which source's data and actions it is wired to.
 */
export interface ProjectTreeBodyProps {
  projectId: string
  isExpanded: boolean
  projectThreads: Thread[]
  locations: RepoLocation[]
  pools: LocationPool[]
  deletingWorktreeCount: number
  isSnoozedExpanded: boolean
  projectSnoozedThreads: Thread[]
  projectSnoozedCount: number
  snoozedPage: number
  isArchivedExpanded: boolean
  projectArchivedThreads: Thread[]
  projectArchivedCount: number
  archivedPage: number
  /** Routines read the active source's stores, so only that source's members show them. */
  showRoutines: boolean
  /** Rendered on every Location row; the unified view uses it for the source pill. */
  locationBadge?: ReactNode
  /** Whether Explorer/terminal actions may target these paths from this desktop. */
  shellAvailable?: boolean
  collapsedLocationIds: Set<string>
  expandedAvailablePools: Set<string>
  pathExistsByLocation: Record<string, boolean>
  branchByLocation: Record<string, string>
  selectedThreadId: string | null
  statusMap: Record<string, ThreadStatus | undefined>
  unreadByThread: Record<string, boolean | undefined>
  onToggleShowSnoozed: (projectId: string) => void
  onSetSnoozedPage: (projectId: string, page: number) => void | Promise<void>
  onToggleShowArchived: (projectId: string) => void
  onSetArchivedPage: (projectId: string, page: number) => void | Promise<void>
  onOpenLocationDialog: (projectId: string) => void
  onTogglePoolAvailableExpanded: (poolId: string) => void
  onToggleLocationCollapsed: (locationId: string) => void
  onCheckoutLocation: (locationId: string, projectId: string) => void | Promise<void>
  onReturnLocationToPool: (locationId: string, projectId: string) => void | Promise<void>
  onNewThread: (projectId: string, locationId: string) => void | Promise<void>
  onNewWorktreeThread: (projectId: string, parentLocationId: string) => void | Promise<void>
  onRemoveWorktree: (location: RepoLocation, projectId: string) => void | Promise<void>
  onSelectThread: (threadId: string) => void
  onArchiveThread: (thread: Thread, projectId: string) => void | Promise<void>
  onUnarchiveThread: (thread: Thread, projectId: string) => void | Promise<void>
  onSnoozeThread: (thread: Thread, projectId: string, untilIso: string) => void | Promise<void>
  onWakeThread: (thread: Thread, projectId: string) => void | Promise<void>
}

export default function ProjectTreeBody({
  projectId,
  isExpanded,
  projectThreads,
  locations,
  pools,
  deletingWorktreeCount,
  isSnoozedExpanded,
  projectSnoozedThreads,
  projectSnoozedCount,
  snoozedPage,
  isArchivedExpanded,
  projectArchivedThreads,
  projectArchivedCount,
  archivedPage,
  showRoutines,
  locationBadge,
  shellAvailable,
  collapsedLocationIds,
  expandedAvailablePools,
  pathExistsByLocation,
  branchByLocation,
  selectedThreadId,
  statusMap,
  unreadByThread,
  onToggleShowSnoozed,
  onSetSnoozedPage,
  onToggleShowArchived,
  onSetArchivedPage,
  onOpenLocationDialog,
  onTogglePoolAvailableExpanded,
  onToggleLocationCollapsed,
  onCheckoutLocation,
  onReturnLocationToPool,
  onNewThread,
  onNewWorktreeThread,
  onRemoveWorktree,
  onSelectThread,
  onArchiveThread,
  onUnarchiveThread,
  onSnoozeThread,
  onWakeThread,
}: ProjectTreeBodyProps) {
  const archivedPageCount = Math.ceil(projectArchivedCount / 10)
  const snoozedPageCount = Math.ceil(projectSnoozedCount / 10)
  const runningThreads = projectThreads.filter((thread) => statusMap[thread.id] === 'running' || statusMap[thread.id] === 'stopping')
  const unreadThreads = projectThreads.filter((thread) => (unreadByThread[thread.id] ?? !!thread.unread) && statusMap[thread.id] !== 'running' && statusMap[thread.id] !== 'stopping')

  return (
    <>
      {!isExpanded && (runningThreads.length > 0 || unreadThreads.length > 0) && (
        <div>
          {runningThreads.map((thread) => (
            <ThreadRow
              key={thread.id}
              thread={thread}
              isArchived={false}
              projectId={projectId}
              indent="pl-8"
              selectedThreadId={selectedThreadId}
              statusMap={statusMap}
              unreadByThread={unreadByThread}
              onSelectThread={onSelectThread}
              onArchiveThread={onArchiveThread}
              onUnarchiveThread={onUnarchiveThread}
              onSnoozeThread={onSnoozeThread}
              onWakeThread={onWakeThread}
            />
          ))}
          {unreadThreads.map((thread) => (
            <ThreadRow
              key={thread.id}
              thread={thread}
              isArchived={false}
              projectId={projectId}
              indent="pl-8"
              selectedThreadId={selectedThreadId}
              statusMap={statusMap}
              unreadByThread={unreadByThread}
              onSelectThread={onSelectThread}
              onArchiveThread={onArchiveThread}
              onUnarchiveThread={onUnarchiveThread}
              onSnoozeThread={onSnoozeThread}
              onWakeThread={onWakeThread}
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
                          onClick={() => onCheckoutLocation(available[0].id, projectId)}
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
    badge={locationBadge}
    shellAvailable={shellAvailable}
                        key={location.id}
                        projectId={projectId}
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
                        onNewWorktreeThread={onNewWorktreeThread}
                        onRemoveWorktree={onRemoveWorktree}
                        onCheckoutLocation={onCheckoutLocation}
                        onReturnLocationToPool={onReturnLocationToPool}
                        onSelectThread={onSelectThread}
                        onArchiveThread={onArchiveThread}
                        onUnarchiveThread={onUnarchiveThread}
                        onSnoozeThread={onSnoozeThread}
                        onWakeThread={onWakeThread}
                      />
                    ))}

                    {showAvailable && available.map((location) => (
                      <LocationSection
    badge={locationBadge}
    shellAvailable={shellAvailable}
                        key={location.id}
                        projectId={projectId}
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
                        onNewWorktreeThread={onNewWorktreeThread}
                        onRemoveWorktree={onRemoveWorktree}
                        onCheckoutLocation={onCheckoutLocation}
                        onReturnLocationToPool={onReturnLocationToPool}
                        onSelectThread={onSelectThread}
                        onArchiveThread={onArchiveThread}
                        onUnarchiveThread={onUnarchiveThread}
                        onSnoozeThread={onSnoozeThread}
                        onWakeThread={onWakeThread}
                      />
                    ))}
                  </div>
                )
              })}

              {locations
                .filter((location) => !location.pool_id)
                .map((location) => (
                  <LocationSection
    badge={locationBadge}
    shellAvailable={shellAvailable}
                    key={location.id}
                    projectId={projectId}
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
                    onNewWorktreeThread={onNewWorktreeThread}
                    onRemoveWorktree={onRemoveWorktree}
                    onCheckoutLocation={onCheckoutLocation}
                    onReturnLocationToPool={onReturnLocationToPool}
                    onSelectThread={onSelectThread}
                    onArchiveThread={onArchiveThread}
                    onUnarchiveThread={onUnarchiveThread}
                    onSnoozeThread={onSnoozeThread}
                    onWakeThread={onWakeThread}
                  />
                ))}
            </>
          ) : (
            <>
              {locations.map((location) => (
                <LocationSection
    badge={locationBadge}
    shellAvailable={shellAvailable}
                  key={location.id}
                  projectId={projectId}
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
                  onNewWorktreeThread={onNewWorktreeThread}
                  onRemoveWorktree={onRemoveWorktree}
                  onCheckoutLocation={onCheckoutLocation}
                  onReturnLocationToPool={onReturnLocationToPool}
                  onSelectThread={onSelectThread}
                  onArchiveThread={onArchiveThread}
                  onUnarchiveThread={onUnarchiveThread}
                  onSnoozeThread={onSnoozeThread}
                  onWakeThread={onWakeThread}
                />
              ))}
            </>
          )}

          {deletingWorktreeCount > 0 && (
            <div className="flex items-center gap-2 pl-6 pr-4 py-1 text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
              <div className="status-spinner h-2.5 w-2.5 flex-shrink-0" />
              <span className="truncate">
                Deleting {deletingWorktreeCount} worktree{deletingWorktreeCount === 1 ? '' : 's'}...
              </span>
            </div>
          )}

          {projectThreads
            .filter((thread) => !thread.location_id || !locations.some((location) => location.id === thread.location_id))
            .map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                isArchived={false}
                projectId={projectId}
                indent="pl-8"
                selectedThreadId={selectedThreadId}
                statusMap={statusMap}
                unreadByThread={unreadByThread}
                onSelectThread={onSelectThread}
                onArchiveThread={onArchiveThread}
                onUnarchiveThread={onUnarchiveThread}
                onSnoozeThread={onSnoozeThread}
                onWakeThread={onWakeThread}
              />
            ))}

          {locations.length === 0 && projectThreads.length === 0 && (
            <button
              onClick={() => onOpenLocationDialog(projectId)}
              className="flex w-full items-center pl-6 pr-4 py-2 text-left text-xs opacity-50 transition-opacity hover:opacity-80"
              style={{ color: 'var(--color-text-muted)' }}
            >
              + Add a location to get started
            </button>
          )}

          {showRoutines && <RoutinesSection projectId={projectId} onSelectThread={onSelectThread} />}

          {/*
            Snoozed sits above Archived: a snooze is temporary and
            returning, so it belongs closer to the live list than the
            terminal Archived section. There is deliberately no woken
            marker here — the tree has no attention ordering to lead, so
            a woken thread simply reappears in its location's list.
          */}
          {(projectSnoozedCount > 0 || isSnoozedExpanded) && (
            <button
              onClick={() => onToggleShowSnoozed(projectId)}
              className="flex w-full items-center pl-6 pr-4 py-1 text-left text-[10px] opacity-40 transition-opacity hover:opacity-70"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {isSnoozedExpanded ? (
                <><ChevronDown size={9} className="mr-1" /> Hide snoozed</>
              ) : (
                <><ChevronRight size={9} className="mr-1" /> Snoozed ({projectSnoozedCount})</>
              )}
            </button>
          )}

          {isSnoozedExpanded && (
            <>
              {projectSnoozedThreads.map((thread) => (
                <ThreadRow
                  key={thread.id}
                  thread={thread}
                  isArchived={false}
                  isSnoozed
                  projectId={projectId}
                  indent="pl-8"
                  selectedThreadId={selectedThreadId}
                  statusMap={statusMap}
                  unreadByThread={unreadByThread}
                  onSelectThread={onSelectThread}
                  onArchiveThread={onArchiveThread}
                  onUnarchiveThread={onUnarchiveThread}
                  onSnoozeThread={onSnoozeThread}
                  onWakeThread={onWakeThread}
                />
              ))}

              {snoozedPageCount > 1 && (
                <div
                  className="flex items-center justify-between pl-8 pr-4 py-1 text-[10px]"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  <button
                    onClick={() => onSetSnoozedPage(projectId, snoozedPage - 1)}
                    className="transition-opacity hover:opacity-70 disabled:cursor-default disabled:opacity-30"
                    disabled={snoozedPage === 0}
                  >
                    Back
                  </button>
                  <span>{snoozedPage + 1} / {snoozedPageCount}</span>
                  <button
                    onClick={() => onSetSnoozedPage(projectId, snoozedPage + 1)}
                    className="transition-opacity hover:opacity-70 disabled:cursor-default disabled:opacity-30"
                    disabled={snoozedPage >= snoozedPageCount - 1}
                  >
                    Forward
                  </button>
                </div>
              )}
            </>
          )}

          {(projectArchivedCount > 0 || isArchivedExpanded) && (
            <button
              onClick={() => onToggleShowArchived(projectId)}
              className="flex w-full items-center pl-6 pr-4 py-1 text-left text-[10px] opacity-40 transition-opacity hover:opacity-70"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {isArchivedExpanded ? (
                <><ChevronDown size={9} className="mr-1" /> Hide archived</>
              ) : (
                <><ChevronRight size={9} className="mr-1" /> Archived ({projectArchivedCount})</>
              )}
            </button>
          )}

          {isArchivedExpanded && (
            <>
              {projectArchivedThreads.map((thread) => (
                <ThreadRow
                  key={thread.id}
                  thread={thread}
                  isArchived
                  projectId={projectId}
                  indent="pl-8"
                  selectedThreadId={selectedThreadId}
                  statusMap={statusMap}
                  unreadByThread={unreadByThread}
                  onSelectThread={onSelectThread}
                  onArchiveThread={onArchiveThread}
                  onUnarchiveThread={onUnarchiveThread}
                  onSnoozeThread={onSnoozeThread}
                  onWakeThread={onWakeThread}
                />
              ))}

              {archivedPageCount > 1 && (
                <div
                  className="flex items-center justify-between pl-8 pr-4 py-1 text-[10px]"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  <button
                    onClick={() => onSetArchivedPage(projectId, archivedPage - 1)}
                    className="transition-opacity hover:opacity-70 disabled:cursor-default disabled:opacity-30"
                    disabled={archivedPage === 0}
                  >
                    Back
                  </button>
                  <span>{archivedPage + 1} / {archivedPageCount}</span>
                  <button
                    onClick={() => onSetArchivedPage(projectId, archivedPage + 1)}
                    className="transition-opacity hover:opacity-70 disabled:cursor-default disabled:opacity-30"
                    disabled={archivedPage >= archivedPageCount - 1}
                  >
                    Forward
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </>
  )
}
