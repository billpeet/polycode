import { ChevronDown, ChevronRight } from 'lucide-react'
import { RepoLocation, Thread, ThreadStatus } from '../../types/ipc'
import ThreadRow from './ThreadRow'
import { ConnectionBadge } from './shared'

interface LocationSectionProps {
  projectId: string
  location: RepoLocation
  projectThreads: Thread[]
  showPoolActions?: boolean
  collapsedLocationIds: Set<string>
  pathExistsByLocation: Record<string, boolean>
  branchByLocation: Record<string, string>
  selectedThreadId: string | null
  statusMap: Record<string, ThreadStatus | undefined>
  unreadByThread: Record<string, boolean | undefined>
  onToggleLocationCollapsed: (locationId: string) => void
  onNewThread: (projectId: string, locationId: string) => void | Promise<void>
  onCheckoutLocation: (locationId: string, projectId: string) => void | Promise<void>
  onReturnLocationToPool: (locationId: string, projectId: string) => void | Promise<void>
  onSelectThread: (threadId: string) => void
  onArchiveThread: (thread: Thread, projectId: string) => void | Promise<void>
  onUnarchiveThread: (thread: Thread, projectId: string) => void | Promise<void>
}

export default function LocationSection({
  projectId,
  location,
  projectThreads,
  showPoolActions = false,
  collapsedLocationIds,
  pathExistsByLocation,
  branchByLocation,
  selectedThreadId,
  statusMap,
  unreadByThread,
  onToggleLocationCollapsed,
  onNewThread,
  onCheckoutLocation,
  onReturnLocationToPool,
  onSelectThread,
  onArchiveThread,
  onUnarchiveThread,
}: LocationSectionProps) {
  const isLocationExpanded = !collapsedLocationIds.has(location.id)
  const locationThreads = projectThreads.filter((thread) => thread.location_id === location.id)
  const isCheckedOut = !location.pool_id || location.checked_out
  const pathMissing = location.connection_type === 'local' && pathExistsByLocation[location.id] === false

  return (
    <div>
      <div className="group relative">
        <button
          onClick={() => onToggleLocationCollapsed(location.id)}
          className="flex w-full items-center pl-6 pr-2 py-0.5 text-left text-xs transition-colors min-w-0"
          style={{ color: pathMissing ? '#f87171' : 'var(--color-text-muted)' }}
          title={pathMissing ? `Directory not found: ${location.path}` : undefined}
        >
          {isLocationExpanded
            ? <ChevronDown size={10} className="mr-1 flex-shrink-0 opacity-50" />
            : <ChevronRight size={10} className="mr-1 flex-shrink-0 opacity-50" />
          }
          <span className="truncate opacity-70">{location.label}</span>
          {branchByLocation[location.id] && (
            <span className="ml-1 flex-shrink-0 text-[9px] opacity-50">
              ({branchByLocation[location.id]})
            </span>
          )}
          <ConnectionBadge connectionType={location.connection_type} />
          {location.pool_id && !isCheckedOut && (
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

        {showPoolActions && location.pool_id && (
          <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            {location.checked_out ? (
              <button
                onClick={() => onReturnLocationToPool(location.id, projectId)}
                className="rounded px-1.5 py-0.5 text-[10px] hover:bg-white/10"
                style={{ color: 'var(--color-text-muted)' }}
                title="Return to pool"
              >
                Return
              </button>
            ) : (
              <button
                onClick={() => onCheckoutLocation(location.id, projectId)}
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
          onClick={() => onNewThread(projectId, location.id)}
          className="flex w-full items-center pl-10 pr-2 py-0.5 text-left text-[10px] opacity-40 transition-opacity hover:opacity-80"
          style={{ color: 'var(--color-text-muted)' }}
        >
          + New thread
        </button>
      )}

      {isLocationExpanded && (() => {
        const currentBranch = branchByLocation[location.id]
        const currentBranchThreads = locationThreads.filter((thread) =>
          !thread.git_branch || !currentBranch || thread.git_branch === currentBranch
        )
        const otherBranchThreads = locationThreads.filter((thread) =>
          thread.git_branch && currentBranch && thread.git_branch !== currentBranch
        )

        return (
          <>
            {currentBranchThreads.map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                isArchived={false}
                projectId={projectId}
                selectedThreadId={selectedThreadId}
                statusMap={statusMap}
                unreadByThread={unreadByThread}
                branchByLocation={branchByLocation}
                onSelectThread={onSelectThread}
                onArchiveThread={onArchiveThread}
                onUnarchiveThread={onUnarchiveThread}
              />
            ))}
            {otherBranchThreads.length > 0 && (
              <>
                <div
                  className="flex items-center gap-1.5 pl-10 pr-2 py-0.5"
                  style={{ color: 'var(--color-text-muted)', opacity: 0.4 }}
                >
                  <div className="h-px flex-1" style={{ background: 'var(--color-border)' }} />
                  <span className="flex-shrink-0 text-[9px] uppercase tracking-wide">other branches</span>
                  <div className="h-px flex-1" style={{ background: 'var(--color-border)' }} />
                </div>
                {otherBranchThreads.map((thread) => (
                  <ThreadRow
                    key={thread.id}
                    thread={thread}
                    isArchived={false}
                    projectId={projectId}
                    selectedThreadId={selectedThreadId}
                    statusMap={statusMap}
                    unreadByThread={unreadByThread}
                    branchByLocation={branchByLocation}
                    onSelectThread={onSelectThread}
                    onArchiveThread={onArchiveThread}
                    onUnarchiveThread={onUnarchiveThread}
                  />
                ))}
              </>
            )}
          </>
        )
      })()}
    </div>
  )
}
