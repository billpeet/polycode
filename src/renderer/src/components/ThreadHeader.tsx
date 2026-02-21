import { useThreadStore } from '../stores/threads'
import { useProjectStore } from '../stores/projects'

interface Props {
  threadId: string
}

export default function ThreadHeader({ threadId }: Props) {
  const byProject = useThreadStore((s) => s.byProject)
  const statusMap = useThreadStore((s) => s.statusMap)
  const start = useThreadStore((s) => s.start)
  const stop = useThreadStore((s) => s.stop)

  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const projects = useProjectStore((s) => s.projects)

  const project = projects.find((p) => p.id === selectedProjectId)
  const threads = selectedProjectId ? (byProject[selectedProjectId] ?? []) : []
  const thread = threads.find((t) => t.id === threadId)
  const status = statusMap[threadId] ?? 'idle'

  const statusColor =
    status === 'running'
      ? '#4ade80'
      : status === 'error'
        ? '#f87171'
        : status === 'stopped'
          ? '#facc15'
          : 'var(--color-text-muted)'

  async function handleToggle(): Promise<void> {
    if (!project) return
    if (status === 'running') {
      await stop(threadId)
    } else {
      await start(threadId, project.path)
    }
  }

  return (
    <div
      className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
    >
      <div className="flex items-center gap-3">
        <span
          className="h-2.5 w-2.5 rounded-full flex-shrink-0"
          style={{ background: statusColor }}
        />
        <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
          {thread?.name ?? threadId}
        </span>
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {thread?.provider ?? 'claude-code'}
        </span>
      </div>

      <button
        onClick={handleToggle}
        className="rounded px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-80"
        style={{
          background: status === 'running' ? '#f87171' : 'var(--color-claude)',
          color: '#fff'
        }}
      >
        {status === 'running' ? 'Stop' : 'Start'}
      </button>
    </div>
  )
}
