import { useState, useEffect } from 'react'
import { useGitStore } from '../stores/git'
import { useProjectStore } from '../stores/projects'
import { useToastStore } from '../stores/toast'
import { GitFileChange } from '../types/ipc'

function FileStatusBadge({ status, staged }: { status: GitFileChange['status']; staged: boolean }) {
  const label =
    status === 'M' ? 'M'
    : status === 'A' ? 'A'
    : status === 'D' ? 'D'
    : status === 'R' ? 'R'
    : status === 'U' ? 'U'
    : '?'

  const color =
    status === 'M' ? '#e2c08d'  // amber — modified
    : status === 'A' ? '#4ade80' // green — added
    : status === 'D' ? '#f87171' // red — deleted
    : status === 'R' ? '#a78bfa' // purple — renamed
    : status === 'U' ? '#f87171' // red — unmerged
    : 'var(--color-text-muted)'  // gray — untracked

  return (
    <span
      style={{
        fontSize: '0.6rem',
        fontWeight: 700,
        color,
        width: 12,
        textAlign: 'center',
        flexShrink: 0,
        opacity: staged ? 1 : 0.65,
      }}
      title={staged ? 'Staged' : 'Unstaged'}
    >
      {label}
    </span>
  )
}

function basename(path: string): string {
  return path.split('/').pop() ?? path
}

function dirname(path: string): string {
  const parts = path.split('/')
  if (parts.length <= 1) return ''
  return parts.slice(0, -1).join('/')
}

export default function GitPanel() {
  const projects = useProjectStore((s) => s.projects)
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const project = projects.find((p) => p.id === selectedProjectId)

  const gitStatus = useGitStore((s) =>
    project?.path ? (s.statusByPath[project.path] ?? null) : null
  )
  const fetchGit = useGitStore((s) => s.fetch)
  const commitGit = useGitStore((s) => s.commit)
  const addToast = useToastStore((s) => s.add)

  const [commitMsg, setCommitMsg] = useState('')
  const [committing, setCommitting] = useState(false)

  // Refresh when project changes
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
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : 'Commit failed',
        duration: 0,
      })
    } finally {
      setCommitting(false)
    }
  }

  const stagedFiles = gitStatus?.files.filter((f) => f.staged) ?? []
  const unstagedFiles = gitStatus?.files.filter((f) => !f.staged) ?? []
  const totalChanges = gitStatus?.files.length ?? 0

  if (!project?.path) {
    return (
      <div className="flex flex-col h-full">
        <div
          className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <span className="text-xs font-semibold" style={{ color: 'var(--color-text)' }}>Source Control</span>
        </div>
        <p className="px-4 py-8 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
          No project selected.
        </p>
      </div>
    )
  }

  if (!gitStatus) {
    return (
      <div className="flex flex-col h-full">
        <div
          className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <span className="text-xs font-semibold" style={{ color: 'var(--color-text)' }}>Source Control</span>
        </div>
        <p className="px-4 py-8 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
          Not a Git repository.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <span className="text-xs font-semibold" style={{ color: 'var(--color-text)' }}>
          Source Control
        </span>
        <div className="flex items-center gap-2">
          {totalChanges > 0 && (
            <span
              className="text-xs tabular-nums px-1.5 py-0.5 rounded-full"
              style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-muted)' }}
            >
              {totalChanges}
            </span>
          )}
          <button
            onClick={() => project.path && fetchGit(project.path)}
            className="rounded p-1 hover:bg-white/10 transition-colors"
            style={{ color: 'var(--color-text-muted)' }}
            title="Refresh"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.418A6 6 0 1 1 8 2v1z"/>
              <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Commit message box */}
      <div
        className="px-3 pt-3 pb-2 flex-shrink-0 border-b"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <textarea
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          placeholder="Message (Ctrl+Enter to commit)"
          rows={3}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.ctrlKey) {
              e.preventDefault()
              handleCommit()
            }
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
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto py-1">
        {totalChanges === 0 ? (
          <p className="px-4 py-8 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
            No changes.
          </p>
        ) : (
          <>
            {stagedFiles.length > 0 && (
              <FileGroup label="Staged Changes" files={stagedFiles} />
            )}
            {unstagedFiles.length > 0 && (
              <FileGroup label="Changes" files={unstagedFiles} />
            )}
          </>
        )}
      </div>
    </div>
  )
}

function FileGroup({ label, files }: { label: string; files: GitFileChange[] }) {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div>
      {/* Group header */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center gap-1 px-3 py-1 text-left hover:bg-white/5 transition-colors"
        style={{ color: 'var(--color-text-muted)' }}
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
          }}
        >
          <path d="M0 2l4 4 4-4z" />
        </svg>
        <span className="text-[10px] font-semibold uppercase tracking-wider">{label}</span>
        <span
          className="ml-1 text-[10px] rounded-full px-1.5"
          style={{ background: 'var(--color-surface-2)' }}
        >
          {files.length}
        </span>
      </button>

      {/* Files */}
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
                <span
                  className="text-xs truncate min-w-0 flex-1"
                  style={{ color: 'var(--color-text)' }}
                >
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
