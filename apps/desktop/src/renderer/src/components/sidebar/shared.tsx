import { Inbox, ListTree } from 'lucide-react'
import { SIDEBAR_DEFAULT_WIDTH, SidebarViewMode, useUiStore } from '../../stores/ui'
import { Thread, ThreadStatus } from '../../types/ipc'

/** Full-width Tree / Queue segmented switch, rendered on its own sidebar row. */
export function ViewModeSwitch({ mode, onSetMode }: { mode: SidebarViewMode; onSetMode: (mode: SidebarViewMode) => void }) {
  const options = [
    { mode: 'tree' as const, label: 'Tree', icon: <ListTree size={12} /> },
    { mode: 'queue' as const, label: 'Queue', icon: <Inbox size={12} /> },
  ]
  return (
    <div className="flex-shrink-0 border-b px-3 py-1.5" style={{ borderColor: 'var(--color-border)' }}>
      <div
        className="flex w-full rounded p-0.5"
        style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}
      >
        {options.map((option) => (
          <button
            key={option.mode}
            onClick={() => onSetMode(option.mode)}
            className="flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1 text-xs transition-colors"
            style={{
              background: mode === option.mode ? 'var(--color-border)' : 'transparent',
              color: mode === option.mode ? 'var(--color-text)' : 'var(--color-text-muted)',
            }}
            title={option.mode === 'tree' ? 'Threads by project' : 'Threads by need for attention'}
          >
            {option.icon}
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Right-edge drag handle for the expanded sidebar. Width updates live while
 * dragging and persists on release; double-click resets to the default.
 */
export function SidebarResizeHandle() {
  function handlePointerDown(e: React.PointerEvent): void {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = useUiStore.getState().sidebarWidth
    useUiStore.getState().setSidebarResizing(true)
    function onMove(event: PointerEvent): void {
      useUiStore.getState().setSidebarWidth(startWidth + (event.clientX - startX))
    }
    function onUp(): void {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      useUiStore.getState().setSidebarResizing(false)
      useUiStore.getState().persistSidebarWidth()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function handleDoubleClick(): void {
    useUiStore.getState().setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)
    useUiStore.getState().persistSidebarWidth()
  }

  return (
    <div
      onPointerDown={handlePointerDown}
      onDoubleClick={handleDoubleClick}
      className="absolute inset-y-0 right-0 z-10 w-1 cursor-col-resize transition-colors hover:bg-white/10"
      title="Drag to resize — double-click to reset"
    />
  )
}

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
