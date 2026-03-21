import { Archive, ArchiveRestore } from 'lucide-react'
import { Thread, ThreadStatus } from '../../types/ipc'
import { getThreadStatusColor, relativeTime } from './shared'

interface ThreadRowProps {
  thread: Thread
  isArchived: boolean
  projectId: string
  indent?: string
  selectedThreadId: string | null
  statusMap: Record<string, ThreadStatus | undefined>
  unreadByThread: Record<string, boolean | undefined>
  branchByLocation: Record<string, string>
  onSelectThread: (threadId: string) => void
  onArchiveThread: (thread: Thread, projectId: string) => void | Promise<void>
  onUnarchiveThread: (thread: Thread, projectId: string) => void | Promise<void>
}

export default function ThreadRow({
  thread,
  isArchived,
  projectId,
  indent = 'pl-10',
  selectedThreadId,
  statusMap,
  unreadByThread,
  branchByLocation,
  onSelectThread,
  onArchiveThread,
  onUnarchiveThread,
}: ThreadRowProps) {
  const status = statusMap[thread.id] ?? 'idle'
  const isSelected = selectedThreadId === thread.id

  return (
    <div
      className="group/thread relative"
      style={{ opacity: isArchived ? 0.6 : 1 }}
    >
      <button
        onClick={() => onSelectThread(thread.id)}
        className={`flex w-full items-center ${indent} pr-2 py-1 text-left text-xs transition-colors min-w-0`}
        style={{
          background: isSelected ? 'var(--color-border)' : 'transparent',
          color: 'var(--color-text-muted)',
        }}
      >
        {!isArchived && (status === 'running' || status === 'stopping') ? (
          <span
            className="mr-2 h-1.5 w-1.5 flex-shrink-0 status-spinner"
            style={status === 'stopping' ? { opacity: 0.5, filter: 'hue-rotate(30deg)' } : undefined}
          />
        ) : (
          <span
            className={`mr-2 h-1.5 w-1.5 rounded-full flex-shrink-0${!isArchived && (unreadByThread[thread.id] ?? !!thread.unread) ? ' status-unread' : ''}`}
            style={{ background: isArchived ? 'var(--color-text-muted)' : getThreadStatusColor(thread, statusMap, unreadByThread) }}
          />
        )}
        <span className="truncate min-w-0">{thread.name}</span>
      </button>

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

      <div
        className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover/thread:opacity-100"
        style={{ background: isSelected ? 'color-mix(in srgb, var(--color-border) 80%, transparent)' : 'color-mix(in srgb, var(--color-surface) 80%, transparent)' }}
      >
        <span
          className="px-1 text-[10px]"
          style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}
        >
          {relativeTime(thread.updated_at)}
        </span>
        {isArchived ? (
          <button
            onClick={() => onUnarchiveThread(thread, projectId)}
            className="rounded p-1 transition-colors hover:bg-white/10"
            style={{ color: 'var(--color-text-muted)' }}
            title="Unarchive thread"
          >
            <ArchiveRestore size={13} />
          </button>
        ) : (
          <button
            onClick={() => onArchiveThread(thread, projectId)}
            className="rounded p-1 transition-colors hover:bg-white/10"
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
