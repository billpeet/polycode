import { useState, useEffect, useCallback } from 'react'
import { useTodoStore, Todo } from '../stores/todos'
import { useGitStore } from '../stores/git'
import { useThreadStore } from '../stores/threads'
import { useLocationStore } from '../stores/locations'
import { useToastStore } from '../stores/toast'
import { useUiStore, RightPanelTab } from '../stores/ui'
import { useFilesStore } from '../stores/files'
import { GitFileChange } from '../types/ipc'
import FileTree from './FileTree'

function SparkleIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v18" />
      <path d="m5.2 7.8 11.6 8.4" />
      <path d="m5.2 16.2 11.6-8.4" />
    </svg>
  )
}

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

interface FileGroupProps {
  label: string
  files: GitFileChange[]
  onFileAction: (filePath: string) => void
  onGroupAction: () => void
  actionIcon: 'plus' | 'minus'
  actionTitle: string
  onFileClick?: (file: GitFileChange) => void
}

function FileGroup({ label, files, onFileAction, onGroupAction, actionIcon, actionTitle, onFileClick }: FileGroupProps) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <div>
      <div
        className="flex w-full items-center gap-1 px-3 py-1.5 hover:bg-white/5 transition-colors group"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-1 flex-1 text-left"
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
        <button
          onClick={(e) => { e.stopPropagation(); onGroupAction() }}
          className="opacity-0 group-hover:opacity-100 rounded p-0.5 hover:bg-white/10 transition-all"
          title={`${actionTitle} All`}
        >
          {actionIcon === 'plus' ? (
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z"/>
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 8a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7A.5.5 0 0 1 4 8z"/>
            </svg>
          )}
        </button>
      </div>
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
                  style={{ color: 'var(--color-text)', cursor: onFileClick ? 'pointer' : 'default' }}
                  onClick={() => onFileClick?.(file)}
                >
                  {name}
                </span>
                {dir && (
                  <span
                    className="text-[10px] truncate flex-shrink-0 max-w-[60px] group-hover:hidden"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    {dir}
                  </span>
                )}
                <button
                  onClick={() => onFileAction(file.path)}
                  className="opacity-0 group-hover:opacity-100 rounded p-0.5 hover:bg-white/10 transition-all flex-shrink-0"
                  title={actionTitle}
                >
                  {actionIcon === 'plus' ? (
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z"/>
                    </svg>
                  ) : (
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M4 8a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7A.5.5 0 0 1 4 8z"/>
                    </svg>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

const EMPTY_FILES: string[] = []
const EMPTY_LOCATIONS: import('../types/ipc').RepoLocation[] = []

function GitSection({ threadId, collapsed, onToggle }: { threadId: string; collapsed: boolean; onToggle: () => void }) {
  const byProject = useThreadStore((s) => s.byProject)
  const archivedByProject = useThreadStore((s) => s.archivedByProject)
  const allLocations = useLocationStore((s) => s.byProject)
  const fetchLocations = useLocationStore((s) => s.fetch)

  // Search all loaded thread arrays — thread may belong to a non-selected project or be archived
  const thread = Object.values(byProject).flat().find((t) => t.id === threadId)
    ?? Object.values(archivedByProject).flat().find((t) => t.id === threadId)

  // Look up locations from the thread's actual project, not the selected project
  const threadProjectId = thread?.project_id ?? null
  const locationsLoaded = threadProjectId ? allLocations[threadProjectId] !== undefined : false
  const threadLocations = threadProjectId ? (allLocations[threadProjectId] ?? EMPTY_LOCATIONS) : EMPTY_LOCATIONS
  // Use thread's location_id, or fallback to first location for the project
  const location = thread?.location_id
    ? threadLocations.find((l) => l.id === thread.location_id)
    : threadLocations[0] ?? null
  const projectPath = location?.path ?? null

  // Fetch locations if not loaded for the thread's project
  useEffect(() => {
    if (threadProjectId && !locationsLoaded) {
      fetchLocations(threadProjectId)
    }
  }, [threadProjectId, locationsLoaded, fetchLocations])

  const statusByPath = useGitStore((s) => s.statusByPath)
  const commitMessageByPath = useGitStore((s) => s.commitMessageByPath)
  const generatingMessageByPath = useGitStore((s) => s.generatingMessageByPath)
  const pushingByPath = useGitStore((s) => s.pushingByPath)
  const pullingByPath = useGitStore((s) => s.pullingByPath)

  const gitStatus = projectPath ? (statusByPath[projectPath] ?? null) : null
  const commitMsg = projectPath ? (commitMessageByPath[projectPath] ?? '') : ''
  const isGeneratingMessage = projectPath ? (generatingMessageByPath[projectPath] ?? false) : false
  const modifiedFiles = useGitStore((s) => s.modifiedFilesByThread[threadId] ?? EMPTY_FILES)
  const fetchGit = useGitStore((s) => s.fetch)
  const commitGit = useGitStore((s) => s.commit)
  const setCommitMsg = useGitStore((s) => s.setCommitMessage)
  const generateMsg = useGitStore((s) => s.generateCommitMessage)
  const stageFile = useGitStore((s) => s.stage)
  const unstageFile = useGitStore((s) => s.unstage)
  const stageAllFiles = useGitStore((s) => s.stageAll)
  const unstageAllFiles = useGitStore((s) => s.unstageAll)
  const stageFilesAction = useGitStore((s) => s.stageFiles)
  const fetchModifiedFiles = useGitStore((s) => s.fetchModifiedFiles)
  const addToast = useToastStore((s) => s.add)
  const selectDiff = useFilesStore((s) => s.selectDiff)

  const pushGit = useGitStore((s) => s.push)
  const pullGit = useGitStore((s) => s.pull)
  const isPushing = projectPath ? (pushingByPath[projectPath] ?? false) : false
  const isPulling = projectPath ? (pullingByPath[projectPath] ?? false) : false

  const [committing, setCommitting] = useState(false)

  useEffect(() => {
    if (projectPath && !collapsed) fetchGit(projectPath)
  }, [projectPath, collapsed, fetchGit])

  useEffect(() => {
    if (threadId) fetchModifiedFiles(threadId)
  }, [threadId, fetchModifiedFiles])

  const handleSetCommitMsg = useCallback((msg: string) => {
    if (projectPath) setCommitMsg(projectPath, msg)
  }, [projectPath, setCommitMsg])

  // Compute staged/unstaged split
  const stagedFiles = gitStatus?.files.filter((f) => f.staged) ?? []
  const unstagedFiles = gitStatus?.files.filter((f) => !f.staged) ?? []

  // Compute unstaged files that were modified by this thread
  const threadRelPaths = new Set(
    modifiedFiles.map((f) =>
      projectPath ? f.replace(projectPath + '/', '').replace(projectPath + '\\', '') : f
    )
  )
  const threadUnstagedFiles = unstagedFiles.filter((f) => threadRelPaths.has(f.path))
  const otherUnstagedFiles = unstagedFiles.filter((f) => !threadRelPaths.has(f.path))
  // Show split view only when no staged files exist and there are thread-specific unstaged files
  const showThreadSplit = threadUnstagedFiles.length > 0 && stagedFiles.length === 0

  async function handleCommit(): Promise<void> {
    if (!projectPath || !commitMsg.trim()) return
    setCommitting(true)
    try {
      await commitGit(projectPath, commitMsg.trim())
      addToast({ type: 'success', message: 'Commit successful', duration: 3000 })
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Commit failed', duration: 0 })
    } finally {
      setCommitting(false)
    }
  }

  async function handleGenerateMessage(): Promise<void> {
    if (!projectPath) return
    try {
      await generateMsg(projectPath)
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to generate message', duration: 0 })
    }
  }

  const handleStage = useCallback(async (filePath: string) => {
    if (!projectPath) return
    try {
      await stageFile(projectPath, filePath)
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to stage file', duration: 3000 })
    }
  }, [projectPath, stageFile, addToast])

  const handleUnstage = useCallback(async (filePath: string) => {
    if (!projectPath) return
    try {
      await unstageFile(projectPath, filePath)
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to unstage file', duration: 3000 })
    }
  }, [projectPath, unstageFile, addToast])

  const handleStageAll = useCallback(async () => {
    if (!projectPath) return
    try {
      await stageAllFiles(projectPath)
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to stage files', duration: 3000 })
    }
  }, [projectPath, stageAllFiles, addToast])

  const handleFileClick = useCallback((file: GitFileChange) => {
    if (!projectPath) return
    selectDiff(projectPath, file.path, file.staged)
  }, [projectPath, selectDiff])

  const handleUnstageAll = useCallback(async () => {
    if (!projectPath) return
    try {
      await unstageAllFiles(projectPath)
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to unstage files', duration: 3000 })
    }
  }, [projectPath, unstageAllFiles, addToast])

  const handleStageThreadFiles = useCallback(async () => {
    if (!projectPath || threadUnstagedFiles.length === 0) return
    try {
      await stageFilesAction(projectPath, threadUnstagedFiles.map((f) => f.path))
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to stage files', duration: 3000 })
    }
  }, [projectPath, threadUnstagedFiles, stageFilesAction, addToast])

  const handleStageOtherFiles = useCallback(async () => {
    if (!projectPath || otherUnstagedFiles.length === 0) return
    try {
      await stageFilesAction(projectPath, otherUnstagedFiles.map((f) => f.path))
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to stage files', duration: 3000 })
    }
  }, [projectPath, otherUnstagedFiles, stageFilesAction, addToast])

  const totalChanges = gitStatus?.files.length ?? 0

  const refreshButton = (
    <button
      onClick={() => projectPath && fetchGit(projectPath)}
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
                {!thread ? 'Thread not loaded.' : !locationsLoaded ? 'Loading...' : !projectPath ? 'No location for project.' : 'Not a Git repository.'}
              </p>
            ) : (
              <>
                <div className="relative">
                  <textarea
                    value={commitMsg}
                    onChange={(e) => handleSetCommitMsg(e.target.value)}
                    placeholder="Commit message (Ctrl+Enter)"
                    rows={2}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); handleCommit() }
                    }}
                    className="w-full resize-none rounded px-2 py-1.5 pr-7 text-xs outline-none"
                    style={{
                      background: 'var(--color-surface-2)',
                      border: '1px solid var(--color-border)',
                      color: 'var(--color-text)',
                      fontFamily: 'inherit',
                    }}
                  />
                  <button
                    onClick={handleGenerateMessage}
                    disabled={isGeneratingMessage || totalChanges === 0}
                    className="absolute right-1 top-1 rounded p-1 hover:bg-white/10 transition-colors disabled:opacity-40"
                    style={{ color: 'var(--color-claude)' }}
                    title="Generate commit message with AI"
                  >
                    {isGeneratingMessage ? (
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" className="animate-spin">
                        <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.418A6 6 0 1 1 8 2v1z"/>
                      </svg>
                    ) : (
                      <SparkleIcon />
                    )}
                  </button>
                </div>
                <button
                  onClick={handleCommit}
                  disabled={!commitMsg.trim() || committing || stagedFiles.length === 0}
                  className="mt-1.5 w-full rounded py-1.5 text-xs font-medium transition-opacity disabled:opacity-40"
                  style={{ background: 'var(--color-claude)', color: '#fff' }}
                >
                  {committing ? 'Committing…' : 'Commit'}
                </button>

                {/* Push / Pull row */}
                <div className="flex gap-1.5 mt-1.5">
                  <button
                    onClick={async () => {
                      if (!projectPath) return
                      try {
                        await pullGit(projectPath)
                        addToast({ type: 'success', message: 'Pulled successfully', duration: 3000 })
                      } catch (err) {
                        addToast({ type: 'error', message: err instanceof Error ? err.message : 'Pull failed', duration: 0 })
                      }
                    }}
                    disabled={isPulling}
                    className="flex-1 flex items-center justify-center gap-1 rounded py-1.5 text-xs font-medium transition-opacity disabled:opacity-40"
                    style={{
                      background: 'var(--color-surface-2)',
                      border: '1px solid var(--color-border)',
                      color: gitStatus.behind > 0 ? '#f87171' : 'var(--color-text-muted)',
                    }}
                    title="Pull from remote"
                  >
                    {isPulling ? (
                      <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className="animate-spin">
                        <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.418A6 6 0 1 1 8 2v1z"/>
                      </svg>
                    ) : (
                      <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M8 12l-4-4h2.5V4h3v4H12L8 12z"/>
                      </svg>
                    )}
                    Pull{gitStatus.behind > 0 ? ` ↓${gitStatus.behind}` : ''}
                  </button>
                  <button
                    onClick={async () => {
                      if (!projectPath) return
                      try {
                        await pushGit(projectPath)
                        addToast({ type: 'success', message: 'Pushed successfully', duration: 3000 })
                      } catch (err) {
                        addToast({ type: 'error', message: err instanceof Error ? err.message : 'Push failed', duration: 0 })
                      }
                    }}
                    disabled={isPushing}
                    className="flex-1 flex items-center justify-center gap-1 rounded py-1.5 text-xs font-medium transition-opacity disabled:opacity-40"
                    style={{
                      background: 'var(--color-surface-2)',
                      border: '1px solid var(--color-border)',
                      color: gitStatus.ahead > 0 ? '#4ade80' : 'var(--color-text-muted)',
                    }}
                    title="Push to remote"
                  >
                    {isPushing ? (
                      <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className="animate-spin">
                        <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.418A6 6 0 1 1 8 2v1z"/>
                      </svg>
                    ) : (
                      <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M8 4l4 4H9.5v4h-3V8H4l4-4z"/>
                      </svg>
                    )}
                    Push{gitStatus.ahead > 0 ? ` ↑${gitStatus.ahead}` : ''}
                  </button>
                </div>
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
                  {stagedFiles.length > 0 && (
                    <FileGroup
                      label="Staged"
                      files={stagedFiles}
                      onFileAction={handleUnstage}
                      onGroupAction={handleUnstageAll}
                      actionIcon="minus"
                      actionTitle="Unstage"
                      onFileClick={handleFileClick}
                    />
                  )}
                  {showThreadSplit ? (
                    <>
                      <FileGroup
                        label="From this thread"
                        files={threadUnstagedFiles}
                        onFileAction={handleStage}
                        onGroupAction={handleStageThreadFiles}
                        actionIcon="plus"
                        actionTitle="Stage"
                        onFileClick={handleFileClick}
                      />
                      {otherUnstagedFiles.length > 0 && (
                        <FileGroup
                          label="Other changes"
                          files={otherUnstagedFiles}
                          onFileAction={handleStage}
                          onGroupAction={handleStageOtherFiles}
                          actionIcon="plus"
                          actionTitle="Stage"
                          onFileClick={handleFileClick}
                        />
                      )}
                    </>
                  ) : (
                    unstagedFiles.length > 0 && (
                      <FileGroup
                        label="Changes"
                        files={unstagedFiles}
                        onFileAction={handleStage}
                        onGroupAction={handleStageAll}
                        actionIcon="plus"
                        actionTitle="Stage"
                        onFileClick={handleFileClick}
                      />
                    )
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── Tab button ────────────────────────────────────────────────────────────────

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider transition-colors"
      style={{
        color: active ? 'var(--color-text)' : 'var(--color-text-muted)',
        borderBottom: active ? '2px solid var(--color-claude)' : '2px solid transparent',
        marginBottom: -1,
      }}
    >
      {label}
    </button>
  )
}

// ─── Root panel ───────────────────────────────────────────────────────────────

interface Props {
  threadId: string
}

export default function RightPanel({ threadId }: Props) {
  const [tasksCollapsed, setTasksCollapsed] = useState(false)
  const [gitCollapsed, setGitCollapsed] = useState(false)

  const activeTab = useUiStore((s) => s.rightPanelTab)
  const setActiveTab = useUiStore((s) => s.setRightPanelTab)

  return (
    <aside
      className="flex w-64 flex-shrink-0 flex-col border-l overflow-hidden"
      style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
    >
      {/* Tab header */}
      <div
        className="flex items-center flex-shrink-0 border-b"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <TabButton label="Tasks" active={activeTab === 'tasks'} onClick={() => setActiveTab('tasks')} />
        <TabButton label="Files" active={activeTab === 'files'} onClick={() => setActiveTab('files')} />
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'tasks' ? (
          <>
            <TasksSection
              threadId={threadId}
              collapsed={tasksCollapsed}
              onToggle={() => setTasksCollapsed((c) => !c)}
            />

            {/* Divider between sections */}
            <div className="flex-shrink-0" style={{ height: 1, background: 'var(--color-border)' }} />

            <GitSection
              threadId={threadId}
              collapsed={gitCollapsed}
              onToggle={() => setGitCollapsed((c) => !c)}
            />
          </>
        ) : (
          <FileTree threadId={threadId} />
        )}
      </div>
    </aside>
  )
}
