import { useState, useEffect, useCallback } from 'react'
import { useGitStore } from '../stores/git'
import { useProjectStore } from '../stores/projects'
import { useToastStore } from '../stores/toast'
import { GitFileChange } from '../types/ipc'

function SparkleIcon({ className }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 3v18" />
      <path d="m5.2 7.8 11.6 8.4" />
      <path d="m5.2 16.2 11.6-8.4" />
    </svg>
  )
}

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
  const commitMsg = useGitStore((s) =>
    project?.path ? (s.commitMessageByPath[project.path] ?? '') : ''
  )
  const isGeneratingMessage = useGitStore((s) =>
    project?.path ? (s.generatingMessageByPath[project.path] ?? false) : false
  )
  const fetchGit = useGitStore((s) => s.fetch)
  const commitGit = useGitStore((s) => s.commit)
  const setCommitMsg = useGitStore((s) => s.setCommitMessage)
  const generateMsg = useGitStore((s) => s.generateCommitMessage)
  const stageFile = useGitStore((s) => s.stage)
  const unstageFile = useGitStore((s) => s.unstage)
  const stageAllFiles = useGitStore((s) => s.stageAll)
  const unstageAllFiles = useGitStore((s) => s.unstageAll)
  const addToast = useToastStore((s) => s.add)

  const [committing, setCommitting] = useState(false)

  // Refresh when project changes
  useEffect(() => {
    if (project?.path) fetchGit(project.path)
  }, [project?.path, fetchGit])

  const handleSetCommitMsg = useCallback((msg: string) => {
    if (project?.path) setCommitMsg(project.path, msg)
  }, [project?.path, setCommitMsg])

  async function handleCommit(): Promise<void> {
    if (!project?.path || !commitMsg.trim()) return
    setCommitting(true)
    try {
      await commitGit(project.path, commitMsg.trim())
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

  async function handleGenerateMessage(): Promise<void> {
    if (!project?.path) return
    try {
      await generateMsg(project.path)
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to generate message',
        duration: 0,
      })
    }
  }

  const handleStage = useCallback(async (filePath: string) => {
    if (!project?.path) return
    try {
      await stageFile(project.path, filePath)
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to stage file',
        duration: 3000,
      })
    }
  }, [project?.path, stageFile, addToast])

  const handleUnstage = useCallback(async (filePath: string) => {
    if (!project?.path) return
    try {
      await unstageFile(project.path, filePath)
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to unstage file',
        duration: 3000,
      })
    }
  }, [project?.path, unstageFile, addToast])

  const handleStageAll = useCallback(async () => {
    if (!project?.path) return
    try {
      await stageAllFiles(project.path)
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to stage files',
        duration: 3000,
      })
    }
  }, [project?.path, stageAllFiles, addToast])

  const handleUnstageAll = useCallback(async () => {
    if (!project?.path) return
    try {
      await unstageAllFiles(project.path)
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to unstage files',
        duration: 3000,
      })
    }
  }, [project?.path, unstageAllFiles, addToast])

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
        <div className="relative">
          <textarea
            value={commitMsg}
            onChange={(e) => handleSetCommitMsg(e.target.value)}
            placeholder="Message (Ctrl+Enter to commit)"
            rows={3}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.ctrlKey) {
                e.preventDefault()
                handleCommit()
              }
            }}
            className="w-full resize-none rounded px-2 py-1.5 pr-8 text-xs outline-none"
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
            className="absolute right-1.5 top-1.5 rounded p-1 hover:bg-white/10 transition-colors disabled:opacity-40"
            style={{ color: 'var(--color-claude)' }}
            title="Generate commit message with AI"
          >
            {isGeneratingMessage ? (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" className="animate-spin">
                <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.418A6 6 0 1 1 8 2v1z"/>
              </svg>
            ) : (
              <SparkleIcon />
            )}
          </button>
        </div>
        <div className="flex gap-1.5 mt-1.5">
          <button
            onClick={handleCommit}
            disabled={!commitMsg.trim() || committing || stagedFiles.length === 0}
            className="flex-1 rounded py-1.5 text-xs font-medium transition-opacity disabled:opacity-40"
            style={{ background: 'var(--color-claude)', color: '#fff' }}
          >
            {committing ? 'Committing…' : 'Commit'}
          </button>
        </div>
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
              <FileGroup
                label="Staged Changes"
                files={stagedFiles}
                onFileAction={handleUnstage}
                onGroupAction={handleUnstageAll}
                actionIcon="minus"
                actionTitle="Unstage"
              />
            )}
            {unstagedFiles.length > 0 && (
              <FileGroup
                label="Changes"
                files={unstagedFiles}
                onFileAction={handleStage}
                onGroupAction={handleStageAll}
                actionIcon="plus"
                actionTitle="Stage"
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}

interface FileGroupProps {
  label: string
  files: GitFileChange[]
  onFileAction: (filePath: string) => void
  onGroupAction: () => void
  actionIcon: 'plus' | 'minus'
  actionTitle: string
}

function FileGroup({ label, files, onFileAction, onGroupAction, actionIcon, actionTitle }: FileGroupProps) {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div>
      {/* Group header */}
      <div
        className="flex w-full items-center gap-1 px-3 py-1 hover:bg-white/5 transition-colors group"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-1 flex-1 text-left"
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
