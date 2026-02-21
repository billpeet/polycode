import { useState, useEffect } from 'react'
import { useTodoStore, Todo } from '../stores/todos'
import { useGitStore } from '../stores/git'
import { useProjectStore } from '../stores/projects'
import { useToastStore } from '../stores/toast'
import { GitFileChange } from '../types/ipc'

// ─── Stable fallback ──────────────────────────────────────────────────────────

const EMPTY_TODOS: Todo[] = []

// ─── Shared section header ────────────────────────────────────────────────────

function SectionHeader({
  label,
  collapsed,
  onToggle,
  badge,
  badgeActive,
  right,
}: {
  label: string
  collapsed: boolean
  onToggle: () => void
  badge?: string
  badgeActive?: boolean
  right?: React.ReactNode
}) {
  return (
    <div
      className="flex items-center flex-shrink-0"
      style={{ borderBottom: collapsed ? 'none' : '1px solid var(--color-border)' }}
    >
      <button
        onClick={onToggle}
        className="flex flex-1 items-center gap-2 px-3 py-2.5 text-left hover:bg-white/5 transition-colors min-w-0"
        style={{ color: 'var(--color-text)' }}
      >
        <svg
          width="8"
          height="8"
          viewBox="0 0 8 8"
          fill="currentColor"
          style={{
            transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s',
            flexShrink: 0,
            opacity: 0.5,
          }}
        >
          <path d="M0 2l4 4 4-4z" />
        </svg>
        <span className="text-xs font-semibold">{label}</span>
        {badge && (
          <span
            style={{
              fontSize: '0.6rem',
              fontWeight: 600,
              padding: '1px 5px',
              borderRadius: 999,
              background: badgeActive
                ? 'rgba(232, 123, 95, 0.2)'
                : 'rgba(255,255,255,0.08)',
              color: badgeActive ? 'var(--color-claude)' : 'var(--color-text-muted)',
            }}
          >
            {badge}
          </span>
        )}
      </button>
      {right && <div className="pr-2">{right}</div>}
    </div>
  )
}

// ─── Tasks section ────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: Todo['status'] }) {
  if (status === 'completed') {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: 'rgba(74, 222, 128, 0.15)',
          border: '1.5px solid #4ade80',
          color: '#4ade80',
          fontSize: '0.55rem',
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        ✓
      </span>
    )
  }
  if (status === 'in_progress') {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 16,
          height: 16,
          flexShrink: 0,
        }}
      >
        <span className="streaming-dot" style={{ background: 'var(--color-claude)', width: 7, height: 7 }} />
      </span>
    )
  }
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 16,
        height: 16,
        borderRadius: '50%',
        border: '1.5px solid var(--color-border)',
        flexShrink: 0,
      }}
    />
  )
}

function TasksSection({ threadId, collapsed, onToggle }: { threadId: string; collapsed: boolean; onToggle: () => void }) {
  const todos = useTodoStore((s) => s.todosByThread[threadId] ?? EMPTY_TODOS)
  const completed = todos.filter((t) => t.status === 'completed').length
  const total = todos.length
  const hasInProgress = todos.some((t) => t.status === 'in_progress')

  const badge = total > 0 ? `${completed}/${total}` : undefined

  return (
    <div className="flex-shrink-0">
      <SectionHeader
        label="Tasks"
        collapsed={collapsed}
        onToggle={onToggle}
        badge={badge}
        badgeActive={hasInProgress}
      />
      {!collapsed && (
        <div>
          {todos.length === 0 ? (
            <p className="px-4 py-6 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
              No tasks yet.
            </p>
          ) : (
            <ul className="px-3 space-y-0.5 py-2">
              {todos.map((todo, idx) => (
                <li
                  key={idx}
                  className="flex items-start gap-2.5 rounded px-2 py-1.5"
                  style={{
                    background: todo.status === 'in_progress' ? 'rgba(232, 123, 95, 0.07)' : 'transparent',
                    opacity: todo.status === 'completed' ? 0.45 : 1,
                    transition: 'opacity 0.2s, background 0.2s',
                  }}
                >
                  <StatusIcon status={todo.status} />
                  <span
                    className="text-xs leading-relaxed min-w-0 break-words"
                    style={{
                      color: 'var(--color-text)',
                      textDecoration: todo.status === 'completed' ? 'line-through' : 'none',
                    }}
                  >
                    {todo.status === 'in_progress' ? todo.activeForm : todo.content}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Git section ──────────────────────────────────────────────────────────────

function FileStatusBadge({ status, staged }: { status: GitFileChange['status']; staged: boolean }) {
  const label = status === 'M' ? 'M' : status === 'A' ? 'A' : status === 'D' ? 'D' : status === 'R' ? 'R' : status === 'U' ? 'U' : '?'
  const color =
    status === 'M' ? '#e2c08d'
    : status === 'A' ? '#4ade80'
    : status === 'D' ? '#f87171'
    : status === 'R' ? '#a78bfa'
    : status === 'U' ? '#f87171'
    : 'var(--color-text-muted)'

  return (
    <span
      style={{ fontSize: '0.6rem', fontWeight: 700, color, width: 12, textAlign: 'center', flexShrink: 0, opacity: staged ? 1 : 0.65 }}
      title={staged ? 'Staged' : 'Unstaged'}
    >
      {label}
    </span>
  )
}

function basename(p: string): string { return p.split('/').pop() ?? p }
function dirname(p: string): string {
  const parts = p.split('/')
  return parts.length <= 1 ? '' : parts.slice(0, -1).join('/')
}

function FileGroup({ label, files }: { label: string; files: GitFileChange[] }) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <div>
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center gap-1 px-3 py-1.5 text-left hover:bg-white/5 transition-colors"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <svg
          width="7"
          height="7"
          viewBox="0 0 8 8"
          fill="currentColor"
          style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', flexShrink: 0 }}
        >
          <path d="M0 2l4 4 4-4z" />
        </svg>
        <span className="text-[10px] font-semibold uppercase tracking-wider">{label}</span>
        <span className="ml-1 text-[10px] rounded-full px-1.5" style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-muted)' }}>
          {files.length}
        </span>
      </button>
      {!collapsed && (
        <ul>
          {files.map((file, idx) => {
            const name = basename(file.path)
            const dir = dirname(file.path)
            return (
              <li
                key={`${file.path}-${idx}`}
                className="flex items-center gap-2 px-4 py-1 hover:bg-white/5 transition-colors group"
                title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
              >
                <FileStatusBadge status={file.status} staged={file.staged} />
                <span className="text-xs truncate min-w-0 flex-1" style={{ color: 'var(--color-text)' }}>
                  {name}
                </span>
                {dir && (
                  <span
                    className="text-[10px] truncate flex-shrink-0 max-w-[60px] opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    {dir}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function GitSection({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const projects = useProjectStore((s) => s.projects)
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const project = projects.find((p) => p.id === selectedProjectId)

  const gitStatus = useGitStore((s) => project?.path ? (s.statusByPath[project.path] ?? null) : null)
  const fetchGit = useGitStore((s) => s.fetch)
  const commitGit = useGitStore((s) => s.commit)
  const addToast = useToastStore((s) => s.add)

  const [commitMsg, setCommitMsg] = useState('')
  const [committing, setCommitting] = useState(false)

  useEffect(() => {
    if (project?.path) fetchGit(project.path)
  }, [project?.path, fetchGit])

  async function handleCommit(): Promise<void> {
    if (!project?.path || !commitMsg.trim()) return
    setCommitting(true)
    try {
      await commitGit(project.path, commitMsg.trim())
      setCommitMsg('')
      addToast({ type: 'success', message: 'Commit successful', duration: 3000 })
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Commit failed', duration: 0 })
    } finally {
      setCommitting(false)
    }
  }

  const stagedFiles = gitStatus?.files.filter((f) => f.staged) ?? []
  const unstagedFiles = gitStatus?.files.filter((f) => !f.staged) ?? []
  const totalChanges = gitStatus?.files.length ?? 0

  const refreshButton = (
    <button
      onClick={() => project?.path && fetchGit(project.path)}
      className="rounded p-1 hover:bg-white/10 transition-colors"
      style={{ color: 'var(--color-text-muted)' }}
      title="Refresh"
    >
      <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.418A6 6 0 1 1 8 2v1z"/>
        <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/>
      </svg>
    </button>
  )

  return (
    <div className="flex-shrink-0">
      <SectionHeader
        label="Source Control"
        collapsed={collapsed}
        onToggle={onToggle}
        badge={totalChanges > 0 ? String(totalChanges) : undefined}
        right={refreshButton}
      />

      {!collapsed && (
        <>
          {/* Commit box — always shown when expanded */}
          <div className="px-3 pt-2.5 pb-2" style={{ borderBottom: '1px solid var(--color-border)' }}>
            {!gitStatus ? (
              <p className="py-2 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
                {!project?.path ? 'No project selected.' : 'Not a Git repository.'}
              </p>
            ) : (
              <>
                <textarea
                  value={commitMsg}
                  onChange={(e) => setCommitMsg(e.target.value)}
                  placeholder="Commit message (Ctrl+Enter)"
                  rows={2}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); handleCommit() }
                  }}
                  className="w-full resize-none rounded px-2 py-1.5 text-xs outline-none"
                  style={{
                    background: 'var(--color-surface-2)',
                    border: '1px solid var(--color-border)',
                    color: 'var(--color-text)',
                    fontFamily: 'inherit',
                  }}
                />
                <button
                  onClick={handleCommit}
                  disabled={!commitMsg.trim() || committing}
                  className="mt-1.5 w-full rounded py-1.5 text-xs font-medium transition-opacity disabled:opacity-40"
                  style={{ background: 'var(--color-claude)', color: '#fff' }}
                >
                  {committing ? 'Committing…' : 'Commit All'}
                </button>
              </>
            )}
          </div>

          {/* File list */}
          {gitStatus && (
            <div className="py-1">
              {totalChanges === 0 ? (
                <p className="px-4 py-4 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
                  No changes.
                </p>
              ) : (
                <>
                  {stagedFiles.length > 0 && <FileGroup label="Staged" files={stagedFiles} />}
                  {unstagedFiles.length > 0 && <FileGroup label="Changes" files={unstagedFiles} />}
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── Root panel ───────────────────────────────────────────────────────────────

interface Props {
  threadId: string
}

export default function RightPanel({ threadId }: Props) {
  const [tasksCollapsed, setTasksCollapsed] = useState(false)
  const [gitCollapsed, setGitCollapsed] = useState(false)

  return (
    <aside
      className="flex w-64 flex-shrink-0 flex-col border-l overflow-y-auto"
      style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
    >
      {/* Top border / panel header */}
      <div
        className="flex items-center px-3 py-2 flex-shrink-0 border-b"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
          Panel
        </span>
      </div>

      <TasksSection
        threadId={threadId}
        collapsed={tasksCollapsed}
        onToggle={() => setTasksCollapsed((c) => !c)}
      />

      {/* Divider between sections */}
      <div className="flex-shrink-0" style={{ height: 1, background: 'var(--color-border)' }} />

      <GitSection
        collapsed={gitCollapsed}
        onToggle={() => setGitCollapsed((c) => !c)}
      />
    </aside>
  )
}
