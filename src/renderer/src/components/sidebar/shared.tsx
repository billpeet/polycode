import { Thread, ThreadStatus } from '../../types/ipc'

export function relativeTime(iso: string): string {
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

export function ConnectionBadge({ connectionType }: { connectionType: string }) {
  if (connectionType === 'local') return null

  const isSSH = connectionType === 'ssh'

  return (
    <span
      className="ml-1 flex-shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase"
      style={{
        background: isSSH ? 'rgba(99, 179, 237, 0.15)' : 'rgba(251, 191, 36, 0.15)',
        color: isSSH ? '#63b3ed' : '#fbbf24',
      }}
    >
      {connectionType}
    </span>
  )
}

export function getThreadStatusColor(
  thread: Thread,
  statusMap: Record<string, ThreadStatus | undefined>,
  unreadByThread: Record<string, boolean | undefined>
): string {
  const status = statusMap[thread.id] ?? 'idle'
  const isUnread = unreadByThread[thread.id] ?? !!thread.unread

  if (isUnread) return '#22c55e'
  if (status === 'running') return '#4ade80'
  if (status === 'stopping') return '#fb923c'
  if (status === 'error') return '#f87171'
  if (status === 'stopped') return '#facc15'
  return 'var(--color-text-muted)'
}
