import { useState, useRef, useEffect, KeyboardEvent } from 'react'
import { useThreadStore } from '../stores/threads'
import { useProjectStore } from '../stores/projects'
import { useTodoStore, Todo } from '../stores/todos'
import { useUiStore } from '../stores/ui'
import { useGitStore } from '../stores/git'
import { ANTHROPIC_MODELS } from '../types/ipc'

const EMPTY_TODOS: Todo[] = []

interface Props {
  threadId: string
}

export default function ThreadHeader({ threadId }: Props) {
  const byProject = useThreadStore((s) => s.byProject)
  const statusMap = useThreadStore((s) => s.statusMap)
  const rename = useThreadStore((s) => s.rename)
  const setModel = useThreadStore((s) => s.setModel)

  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const projects = useProjectStore((s) => s.projects)

  const project = projects.find((p) => p.id === selectedProjectId)
  const threads = selectedProjectId ? (byProject[selectedProjectId] ?? []) : []
  const thread = threads.find((t) => t.id === threadId)
  const status = statusMap[threadId] ?? 'idle'

  const todos = useTodoStore((s) => s.todosByThread[threadId] ?? EMPTY_TODOS)
  const todoTotal = todos.length
  const todoCompleted = todos.filter((t) => t.status === 'completed').length
  const hasInProgress = todos.some((t) => t.status === 'in_progress')
  const isPanelOpen = useUiStore((s) => s.todoPanelOpenByThread[threadId] ?? false)
  const togglePanel = useUiStore((s) => s.toggleTodoPanel)

  const fetchGit = useGitStore((s) => s.fetch)
  const gitStatus = useGitStore((s) =>
    project?.path ? (s.statusByPath[project.path] ?? null) : null
  )

  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.select()
    }
  }, [editing])

  // Poll git status when a project is selected
  useEffect(() => {
    if (!project?.path) return
    fetchGit(project.path)
    const interval = setInterval(() => fetchGit(project.path), 10_000)
    return () => clearInterval(interval)
  }, [project?.path, fetchGit])

  const statusColor =
    status === 'running'
      ? '#4ade80'
      : status === 'error'
        ? '#f87171'
        : status === 'stopped'
          ? '#facc15'
          : 'var(--color-text-muted)'

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
            {thread?.name ?? 'New thread'}
          </button>
        )}
        <select
          value={thread?.model ?? 'claude-opus-4-5'}
          onChange={(e) => setModel(threadId, e.target.value)}
          disabled={status === 'running'}
          className="text-xs flex-shrink-0 bg-transparent border rounded px-1.5 py-0.5 outline-none cursor-pointer"
          style={{
            color: 'var(--color-text-muted)',
            borderColor: 'var(--color-border)',
            background: 'var(--color-surface)',
            opacity: status === 'running' ? 0.4 : 1,
          }}
          title="Select model"
        >
          {ANTHROPIC_MODELS.map((m) => (
            <option key={m.id} value={m.id} style={{ background: 'var(--color-surface)', color: 'var(--color-text)' }}>
              {m.label}
            </option>
          ))}
        </select>

        {/* Git branch + diff stats */}
        {gitStatus && (
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Branch pill */}
            <span
              className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded"
              style={{
                background: 'var(--color-surface-2)',
                color: 'var(--color-text-muted)',
                border: '1px solid var(--color-border)',
                fontFamily: 'monospace',
              }}
              title={`Branch: ${gitStatus.branch}${gitStatus.ahead > 0 ? ` ↑${gitStatus.ahead}` : ''}${gitStatus.behind > 0 ? ` ↓${gitStatus.behind}` : ''}`}
            >
              {/* Branch icon */}
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                <path d="M11.75 2.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0zm.75 2.25a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5zM4.25 13.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0zM5 15.75a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5zM4.25 2.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0zM5 4.75a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5zM5.75 8.75v-4h-1.5v4a4.25 4.25 0 0 0 3 4.04v-1.55a2.75 2.75 0 0 1-1.5-2.49zm5.5-3.54A4.25 4.25 0 0 0 8 1.16v1.55a2.75 2.75 0 0 1 1.75 2.56v2.32A2.75 2.75 0 0 1 8 10.14v1.55a4.25 4.25 0 0 0 3.25-4.14V5.21z" />
              </svg>
              <span className="max-w-[100px] truncate">{gitStatus.branch}</span>
              {gitStatus.ahead > 0 && (
                <span style={{ color: '#4ade80' }}>↑{gitStatus.ahead}</span>
              )}
              {gitStatus.behind > 0 && (
                <span style={{ color: '#f87171' }}>↓{gitStatus.behind}</span>
              )}
            </span>

            {/* Additions / deletions */}
            {(gitStatus.additions > 0 || gitStatus.deletions > 0) && (
              <span className="flex items-center gap-1 text-xs" style={{ fontFamily: 'monospace' }}>
                {gitStatus.additions > 0 && (
                  <span style={{ color: '#4ade80' }}>+{gitStatus.additions}</span>
                )}
                {gitStatus.deletions > 0 && (
                  <span style={{ color: '#f87171' }}>-{gitStatus.deletions}</span>
                )}
              </span>
            )}
          </div>
        )}
      </div>

      <button
        onClick={() => togglePanel(threadId)}
        className="flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors"
        style={{
          color: isPanelOpen ? 'var(--color-claude)' : 'var(--color-text-muted)',
          background: isPanelOpen ? 'rgba(232, 123, 95, 0.1)' : 'transparent',
          border: '1px solid',
          borderColor: isPanelOpen ? 'rgba(232, 123, 95, 0.3)' : 'var(--color-border)',
        }}
        title={isPanelOpen ? 'Hide panel' : 'Show panel'}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <line x1="2" y1="3" x2="10" y2="3" />
          <line x1="2" y1="6" x2="10" y2="6" />
          <line x1="2" y1="9" x2="10" y2="9" />
        </svg>
        <span>Panel</span>
        {todoTotal > 0 && (
          <span
            style={{
              fontSize: '0.6rem',
              fontWeight: 600,
              padding: '1px 5px',
              borderRadius: 999,
              background: hasInProgress
                ? 'rgba(232, 123, 95, 0.2)'
                : 'rgba(74, 222, 128, 0.12)',
              color: hasInProgress ? 'var(--color-claude)' : '#4ade80',
            }}
          >
            {todoCompleted}/{todoTotal}
          </span>
        )}
      </button>
    </div>
  )
}
