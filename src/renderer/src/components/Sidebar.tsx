import { useState, useEffect, useRef } from 'react'
import { useProjectStore } from '../stores/projects'
import { useThreadStore } from '../stores/threads'
import { Project, Thread } from '../types/ipc'
import ProjectDialog from './ProjectDialog'
import ImportHistoryDialog from './ImportHistoryDialog'

function relativeTime(iso: string): string {
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

export default function Sidebar() {
  const projects = useProjectStore((s) => s.projects)
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const expandedProjectIds = useProjectStore((s) => s.expandedProjectIds)
  const selectProject = useProjectStore((s) => s.select)
  const toggleExpanded = useProjectStore((s) => s.toggleExpanded)
  const removeProject = useProjectStore((s) => s.remove)

  const byProject = useThreadStore((s) => s.byProject)
  const archivedByProject = useThreadStore((s) => s.archivedByProject)
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId)
  const statusMap = useThreadStore((s) => s.statusMap)
  const showArchived = useThreadStore((s) => s.showArchived)
  const archivedCountByProject = useThreadStore((s) => s.archivedCountByProject)
  const fetchThreads = useThreadStore((s) => s.fetch)
  const createThread = useThreadStore((s) => s.create)
  const removeThread = useThreadStore((s) => s.remove)
  const archiveThread = useThreadStore((s) => s.archive)
  const unarchiveThread = useThreadStore((s) => s.unarchive)
  const toggleShowArchived = useThreadStore((s) => s.toggleShowArchived)
  const selectThread = useThreadStore((s) => s.select)
  const setName = useThreadStore((s) => s.setName)

  const [projectDialog, setProjectDialog] = useState<{ mode: 'create' } | { mode: 'edit'; project: Project } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ type: 'project' | 'thread'; id: string; name: string; archived?: boolean } | null>(null)
  const [importDialogProject, setImportDialogProject] = useState<{ id: string; path: string } | null>(null)

  const setStatus = useThreadStore((s) => s.setStatus)

  // Track IPC subscriptions for all known threads (title + status)
  const subsRef = useRef<Map<string, Array<() => void>>>(new Map())

  // Subscribe to title and status updates for all threads in byProject
  useEffect(() => {
    const allThreadIds = new Set<string>()
    for (const threads of Object.values(byProject)) {
      for (const t of threads) {
        allThreadIds.add(t.id)
      }
    }

    // Subscribe to new threads
    for (const threadId of allThreadIds) {
      if (!subsRef.current.has(threadId)) {
        const unsubTitle = window.api.on(`thread:title:${threadId}`, (...args) => {
          setName(threadId, args[0] as string)
        })
        const unsubStatus = window.api.on(`thread:status:${threadId}`, (...args) => {
          setStatus(threadId, args[0] as 'idle' | 'running' | 'error' | 'stopped')
        })
        // Safety net: reset status to idle on complete if still running
        const unsubComplete = window.api.on(`thread:complete:${threadId}`, () => {
          const currentStatus = useThreadStore.getState().statusMap[threadId]
          if (currentStatus === 'running') {
            setStatus(threadId, 'idle')
          }
        })
        subsRef.current.set(threadId, [unsubTitle, unsubStatus, unsubComplete])
      }
    }

    // Unsubscribe from removed threads
    for (const [threadId, unsubs] of subsRef.current) {
      if (!allThreadIds.has(threadId)) {
        unsubs.forEach((fn) => fn())
        subsRef.current.delete(threadId)
      }
    }
  }, [byProject, setName, setStatus])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const unsubs of subsRef.current.values()) {
        unsubs.forEach((fn) => fn())
      }
      subsRef.current.clear()
    }
  }, [])

  function handleToggleProject(id: string): void {
    toggleExpanded(id)
    // Also select this project when expanding (so new thread button works)
    if (!expandedProjectIds.has(id)) {
      selectProject(id)
    }
    // Fetch threads if not already loaded
    if (!byProject[id]) fetchThreads(id)
  }

  async function handleNewThread(projectId: string): Promise<void> {
    await createThread(projectId, 'New thread')
    selectProject(projectId)
    window.dispatchEvent(new Event('focus-input'))
  }

  async function handleDeleteProject(id: string): Promise<void> {
    await removeProject(id)
    setConfirmDelete(null)
  }

  async function handleDeleteThread(id: string, projectId: string): Promise<void> {
    await removeThread(id, projectId)
    setConfirmDelete(null)
  }

  async function handleArchiveThread(thread: Thread, projectId: string): Promise<void> {
    await archiveThread(thread.id, projectId)
  }

  async function handleUnarchiveThread(thread: Thread, projectId: string): Promise<void> {
    await unarchiveThread(thread.id, projectId)
  }

  function renderThread(thread: Thread, isArchived: boolean, projectId: string) {
    const status = statusMap[thread.id] ?? 'idle'
    const statusColor =
      status === 'running' ? '#4ade80'
      : status === 'error' ? '#f87171'
      : status === 'stopped' ? '#facc15'
      : 'var(--color-text-muted)'

    return (
      <div
        key={thread.id}
        className="group relative"
        style={{ opacity: isArchived ? 0.6 : 1 }}
      >
        <button
          onClick={() => selectThread(thread.id)}
          className="flex w-full items-center pl-8 pr-2 py-1.5 text-left text-xs transition-colors min-w-0"
          style={{
            background: selectedThreadId === thread.id ? 'var(--color-border)' : 'transparent',
            color: 'var(--color-text-muted)'
          }}
        >
          {!isArchived && status === 'running' ? (
            <span
              className="mr-2 h-1.5 w-1.5 flex-shrink-0 status-spinner"
            />
          ) : (
            <span
              className="mr-2 h-1.5 w-1.5 rounded-full flex-shrink-0"
              style={{ background: isArchived ? 'var(--color-text-muted)' : statusColor }}
            />
          )}
          <span className="flex flex-col min-w-0">
            <span className="truncate">{thread.name}</span>
            <span
              className="text-[10px] leading-tight"
              style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}
            >
              {relativeTime(thread.updated_at)}
            </span>
          </span>
        </button>

        {/* Thread actions — absolutely positioned, overlay on hover */}
        <div
          className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ background: selectedThreadId === thread.id ? 'var(--color-border)' : 'var(--color-surface)' }}
        >
          {isArchived ? (
            <button
              onClick={() => handleUnarchiveThread(thread, projectId)}
              className="rounded p-1 hover:bg-white/10 transition-colors"
              style={{ color: 'var(--color-text-muted)' }}
              title="Unarchive thread"
            >
              {/* Unarchive: box with up arrow */}
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1" y="7" width="14" height="8" rx="1" />
                <path d="M1 7l2-4h10l2 4" />
                <path d="M8 11V4M5.5 6.5L8 4l2.5 2.5" />
              </svg>
            </button>
          ) : (
            <button
              onClick={() => handleArchiveThread(thread, projectId)}
              className="rounded p-1 hover:bg-white/10 transition-colors"
              style={{ color: 'var(--color-text-muted)' }}
              title="Archive thread"
            >
              {/* Archive: box with down arrow */}
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1" y="7" width="14" height="8" rx="1" />
                <path d="M1 7l2-4h10l2 4" />
                <path d="M8 9v6M5.5 12.5L8 15l2.5-2.5" />
              </svg>
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <aside
      className="flex w-60 flex-shrink-0 flex-col border-r overflow-hidden"
      style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <span className="font-semibold text-sm" style={{ color: 'var(--color-claude)' }}>
          PolyCode
        </span>
        <button
          onClick={() => setProjectDialog({ mode: 'create' })}
          className="text-xs px-2 py-1 rounded opacity-70 hover:opacity-100 transition-opacity"
          style={{ background: 'var(--color-surface-2)', color: 'var(--color-text)' }}
          title="New project"
        >
          + Project
        </button>
      </div>

      {/* Projects list */}
      <div className="flex-1 overflow-y-auto">
        {projects.map((project) => (
          <div key={project.id}>
            {/* Project row */}
            <div className="group relative">
              <button
                onClick={() => handleToggleProject(project.id)}
                className="flex w-full items-center px-4 py-2 text-left text-sm transition-colors min-w-0"
                style={{
                  background: expandedProjectIds.has(project.id) ? 'var(--color-surface-2)' : 'transparent',
                  color: 'var(--color-text)'
                }}
              >
                <span className="mr-1.5 text-[10px] flex-shrink-0 opacity-50" style={{ width: '10px' }}>
                  {expandedProjectIds.has(project.id) ? '▾' : '▸'}
                </span>
                <span className="mr-2 text-xs flex-shrink-0">📁</span>
                <span className="truncate">{project.name}</span>
              </button>
              {/* Project actions — absolutely positioned, overlay on hover */}
              <div
                className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                style={{ background: expandedProjectIds.has(project.id) ? 'var(--color-surface-2)' : 'var(--color-surface)' }}
              >
                <button
                  onClick={() => setProjectDialog({ mode: 'edit', project })}
                  className="rounded p-1 text-xs hover:bg-white/10 transition-colors"
                  style={{ color: 'var(--color-text-muted)' }}
                  title="Edit project"
                >
                  ✎
                </button>
                <button
                  onClick={() => setConfirmDelete({ type: 'project', id: project.id, name: project.name })}
                  className="rounded p-1 text-xs hover:bg-white/10 transition-colors"
                  style={{ color: 'var(--color-text-muted)' }}
                  title="Delete project"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Threads under this project */}
            {(() => {
              const isExpanded = expandedProjectIds.has(project.id)
              const projectThreads = byProject[project.id] ?? []
              const projectArchivedThreads = archivedByProject[project.id] ?? []
              const projectArchivedCount = archivedCountByProject[project.id] ?? 0
              const runningThreads = projectThreads.filter((t) => statusMap[t.id] === 'running')

              // When collapsed, only show running threads
              if (!isExpanded) {
                if (runningThreads.length === 0) return null
                return (
                  <div>
                    {runningThreads.map((thread) => renderThread(thread, false, project.id))}
                  </div>
                )
              }

              // When expanded, show everything
              return (
                <div>
                  {/* Thread actions — at the top */}
                  <div className="flex items-center pl-8 pr-4 py-1.5 gap-2">
                    <button
                      onClick={() => handleNewThread(project.id)}
                      className="text-xs opacity-50 hover:opacity-80 transition-opacity"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      + New
                    </button>
                    <span className="text-xs opacity-30" style={{ color: 'var(--color-text-muted)' }}>|</span>
                    <button
                      onClick={() => setImportDialogProject({ id: project.id, path: project.path })}
                      className="text-xs opacity-50 hover:opacity-80 transition-opacity"
                      style={{ color: 'var(--color-text-muted)' }}
                      title="Import from Claude Code CLI history"
                    >
                      Import
                    </button>
                  </div>

                  {/* Active threads */}
                  {projectThreads.map((thread) => renderThread(thread, false, project.id))}

                  {/* Archive toggle — only shown when there are archived threads or section is open */}
                  {(projectArchivedCount > 0 || showArchived) && (
                    <button
                      onClick={() => toggleShowArchived(project.id)}
                      className="flex w-full items-center pl-8 pr-4 py-1 text-left text-[10px] opacity-40 hover:opacity-70 transition-opacity"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      {showArchived ? `▾ Hide archived` : `▸ Archived (${projectArchivedCount})`}
                    </button>
                  )}

                  {/* Archived threads */}
                  {showArchived && projectArchivedThreads.map((thread) => renderThread(thread, true, project.id))}
                </div>
              )
            })()}
          </div>
        ))}

        {projects.length === 0 && (
          <p className="px-4 py-6 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
            No projects yet.
            <br />
            Click &quot;+ Project&quot; to add one.
          </p>
        )}
      </div>

      {/* Project create/edit dialog */}
      {projectDialog && (
        <ProjectDialog
          mode={projectDialog.mode}
          project={projectDialog.mode === 'edit' ? projectDialog.project : undefined}
          onClose={() => setProjectDialog(null)}
        />
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.7)' }}
          onClick={() => setConfirmDelete(null)}
        >
          <div
            className="w-80 rounded-lg p-5 shadow-2xl"
            style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm mb-1" style={{ color: 'var(--color-text)' }}>
              Delete {confirmDelete.type}?
            </p>
            <p className="text-xs mb-4" style={{ color: 'var(--color-text-muted)' }}>
              <span className="font-mono" style={{ color: 'var(--color-text)' }}>{confirmDelete.name}</span>
              {confirmDelete.type === 'project' && ' and all its threads will be permanently deleted.'}
              {confirmDelete.type === 'thread' && ' and all its messages will be permanently deleted.'}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                className="rounded px-3 py-1.5 text-xs"
                style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
              >
                Cancel
              </button>
              <button
                onClick={() =>
                  confirmDelete.type === 'project'
                    ? handleDeleteProject(confirmDelete.id)
                    : handleDeleteThread(confirmDelete.id, selectedProjectId!)
                }
                className="rounded px-3 py-1.5 text-xs font-medium"
                style={{ background: '#dc2626', color: '#fff' }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import history dialog */}
      {importDialogProject && (
        <ImportHistoryDialog
          projectId={importDialogProject.id}
          projectPath={importDialogProject.path}
          onClose={() => setImportDialogProject(null)}
          onImported={() => fetchThreads(importDialogProject.id)}
        />
      )}
    </aside>
  )
}
