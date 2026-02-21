import { useState, useRef, useEffect, KeyboardEvent } from 'react'
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
  const rename = useThreadStore((s) => s.rename)

  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const projects = useProjectStore((s) => s.projects)

  const project = projects.find((p) => p.id === selectedProjectId)
  const threads = selectedProjectId ? (byProject[selectedProjectId] ?? []) : []
  const thread = threads.find((t) => t.id === threadId)
  const status = statusMap[threadId] ?? 'idle'

  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.select()
    }
  }, [editing])

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

  function startEditing(): void {
    setEditValue(thread?.name ?? '')
    setEditing(true)
  }

  async function commitRename(): Promise<void> {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== thread?.name) {
      await rename(threadId, trimmed)
    }
    setEditing(false)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitRename()
    } else if (e.key === 'Escape') {
      setEditing(false)
    }
  }

  return (
    <div
      className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <span
          className="h-2.5 w-2.5 rounded-full flex-shrink-0"
          style={{ background: statusColor }}
        />
        {editing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={commitRename}
            className="text-sm font-medium bg-transparent border-b outline-none min-w-0"
            style={{
              color: 'var(--color-text)',
              borderColor: 'var(--color-claude)',
              width: `${Math.max(editValue.length, 8)}ch`
            }}
          />
        ) : (
          <button
            onClick={startEditing}
            className="text-sm font-medium truncate text-left hover:opacity-70 transition-opacity"
            style={{ color: 'var(--color-text)' }}
            title="Click to rename"
          >
            {thread?.name ?? threadId}
          </button>
        )}
        <span className="text-xs flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
          {thread?.provider ?? 'claude-code'}
        </span>
      </div>

      {status !== 'running' ? (
        <button
          onClick={handleToggle}
          className="flex-shrink-0 rounded px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-80"
          style={{ background: 'var(--color-claude)', color: '#fff' }}
        >
          {status === 'idle' ? 'Start' : 'Restart'}
        </button>
      ) : (
        <button
          onClick={handleToggle}
          className="flex-shrink-0 rounded px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-80"
          style={{ background: '#f87171', color: '#fff' }}
        >
          Stop
        </button>
      )}
    </div>
  )
}
