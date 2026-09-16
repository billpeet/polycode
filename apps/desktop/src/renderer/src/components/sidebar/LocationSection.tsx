import { AlertTriangle, ChevronDown, ChevronRight, Copy, FolderOpen, GitBranchPlus, SquareTerminal, Trash2 } from 'lucide-react'
import { client } from '../../lib/client'
import { writeClipboardText } from '../../lib/clipboard'
import { RepoLocation, Thread, ThreadStatus } from '../../types/ipc'
import ThreadRow from './ThreadRow'
import { ConnectionBadge } from './shared'
import { useCommandStore, EMPTY_COMMANDS, instKey } from '../../stores/commands'
import { locationDisplayName } from '../../lib/locationDisplay'

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
  onNewWorktreeThread: (projectId: string, parentLocationId: string) => void | Promise<void>
  onRemoveWorktree: (location: RepoLocation, projectId: string) => void | Promise<void>
  onCheckoutLocation: (locationId: string, projectId: string) => void | Promise<void>
  onReturnLocationToPool: (locationId: string, projectId: string) => void | Promise<void>
  onSelectThread: (threadId: string) => void
  onArchiveThread: (thread: Thread, projectId: string) => void | Promise<void>
  onUnarchiveThread: (thread: Thread, projectId: string) => void | Promise<void>
  onSnoozeThread: (thread: Thread, projectId: string, untilIso: string) => void | Promise<void>
  onWakeThread: (thread: Thread, projectId: string) => void | Promise<void>
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
  onNewWorktreeThread,
  onRemoveWorktree,
  onCheckoutLocation,
  onReturnLocationToPool,
  onSelectThread,
  onArchiveThread,
  onUnarchiveThread,
  onSnoozeThread,
  onWakeThread,
}: LocationSectionProps) {
  const isLocationExpanded = !collapsedLocationIds.has(location.id)
  const locationThreads = projectThreads.filter((thread) => thread.location_id === location.id)
  const isCheckedOut = !location.pool_id || location.checked_out
  const pathMissing = location.connection_type === 'local' && pathExistsByLocation[location.id] === false
  const invalidWorktree = location.is_worktree && location.worktree_valid === false
  // Explorer/terminal need a directory the desktop shell can reach: local or WSL, not SSH.
  const canOpenShell = client.capabilities.shell && location.connection_type !== 'ssh' && !pathMissing
  const projectCommands = useCommandStore((s) => s.byProject[projectId] ?? EMPTY_COMMANDS)
  const commandStatusMap = useCommandStore((s) => s.statusMap)
  const activeCommandCount = projectCommands.reduce((count, command) => {
    const status = commandStatusMap[instKey(command.id, location.id)] ?? 'idle'
    return status === 'running' || status === 'stopping' ? count + 1 : count
  }, 0)

  return (
    <div>
      <div className="group relative">
        <button
          onClick={() => onToggleLocationCollapsed(location.id)}
          className="mt-1 flex w-full items-center pl-6 pr-2 py-0.5 text-left text-xs font-semibold transition-colors min-w-0 hover:bg-white/5"
          style={{
            color: pathMissing || invalidWorktree ? '#f87171' : 'var(--color-text-muted)',
            background: 'color-mix(in srgb, var(--color-border) 35%, transparent)',
          }}
          title={pathMissing
            ? `Directory not found: ${location.path}`
            : invalidWorktree
              ? `Git no longer recognizes this as a valid worktree: ${location.path}`
              : undefined}
        >
          {isLocationExpanded
            ? <ChevronDown size={10} className="mr-1 flex-shrink-0 opacity-50" />
            : <ChevronRight size={10} className="mr-1 flex-shrink-0 opacity-50" />
          }
          <span
            className="truncate"
            style={pathMissing || invalidWorktree ? undefined : { color: 'var(--color-text)' }}
          >
            {locationDisplayName(location, branchByLocation[location.id])}
          </span>
          {location.is_worktree && (
            <span
              className="ml-1 flex-shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold"
              style={{ background: 'rgba(96, 165, 250, 0.15)', color: '#60a5fa' }}
            >
              worktree
            </span>
          )}
          {!location.is_worktree && branchByLocation[location.id] && (
            <span className="ml-1 flex-shrink-0 text-[9px] opacity-50">
              ({branchByLocation[location.id]})
            </span>
          )}
          {activeCommandCount > 0 && (
            <span
              className="ml-1 inline-flex h-4 min-w-4 flex-shrink-0 items-center justify-center rounded-full px-1 text-[9px] font-semibold"
              style={{
                background: 'rgba(74, 222, 128, 0.15)',
                color: '#4ade80',
                border: '1px solid rgba(74, 222, 128, 0.3)',
              }}
              title={`${activeCommandCount} command${activeCommandCount === 1 ? '' : 's'} running`}
            >
              {activeCommandCount}
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
          {invalidWorktree && !pathMissing && (
            <span
              className="ml-1 inline-flex flex-shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-semibold uppercase"
              style={{ background: 'rgba(248, 113, 113, 0.15)', color: '#f87171' }}
            >
              <AlertTriangle size={9} /> invalid
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
        <div
          className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded opacity-0 transition-opacity group-hover:opacity-100"
          style={{ background: 'color-mix(in srgb, var(--color-surface) 90%, transparent)' }}
        >
            <button
              onClick={() => void writeClipboardText(location.path)}
              className="rounded p-1 hover:bg-white/10"
              style={{ color: 'var(--color-text-muted)' }}
              title={`Copy path: ${location.path}`}
            >
              <Copy size={11} />
            </button>
            {canOpenShell && (
              <>
                <button
                  onClick={() => void client.invoke('shell:openInExplorer', location.path)}
                  className="rounded p-1 hover:bg-white/10"
                  style={{ color: 'var(--color-text-muted)' }}
                  title={`Open in Explorer: ${location.path}`}
                >
                  <FolderOpen size={11} />
                </button>
                <button
                  onClick={() => void client.invoke('shell:openInTerminal', location.path, location.connection_type === 'wsl' ? (location.wsl ?? null) : null)}
                  className="rounded p-1 hover:bg-white/10"
                  style={{ color: 'var(--color-text-muted)' }}
                  title={location.connection_type === 'wsl' ? 'Open in WSL Terminal' : 'Open in Terminal'}
                >
                  <SquareTerminal size={11} />
                </button>
              </>
            )}
            {location.is_worktree && (
              <button
                onClick={() => onRemoveWorktree(location, projectId)}
                className="rounded p-1 hover:bg-white/10"
                style={{ color: 'var(--color-text-muted)' }}
                title="Remove worktree"
              >
                <Trash2 size={11} />
              </button>
            )}
        </div>
      </div>

      {isLocationExpanded && isCheckedOut && (
        <div className="flex items-center pl-10 pr-2 py-0.5 gap-2">
          <button
            onClick={() => onNewThread(projectId, location.id)}
            className="text-left text-[11px] opacity-55 transition-opacity hover:opacity-100"
            style={{ color: 'var(--color-text)' }}
          >
            + New thread
          </button>
          {!location.is_worktree && location.connection_type === 'local' && (
            <button
              onClick={() => onNewWorktreeThread(projectId, location.id)}
              className="inline-flex items-center gap-1 text-left text-[11px] opacity-55 transition-opacity hover:opacity-100"
              style={{ color: 'var(--color-text)' }}
              title="Create a new worktree and thread"
            >
              <GitBranchPlus size={10} />
              Worktree
            </button>
          )}
        </div>
      )}

      {isLocationExpanded && locationThreads.map((thread) => (
        <ThreadRow
          key={thread.id}
          thread={thread}
          isArchived={false}
          projectId={projectId}
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
  )
}
