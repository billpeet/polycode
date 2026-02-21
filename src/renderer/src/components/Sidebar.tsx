import { useState } from 'react'
import { useProjectStore } from '../stores/projects'
import { useThreadStore } from '../stores/threads'
import { useMessageStore } from '../stores/messages'
import { Project } from '../types/ipc'
import ProjectDialog from './ProjectDialog'

export default function Sidebar() {
  const projects = useProjectStore((s) => s.projects)
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const selectProject = useProjectStore((s) => s.select)
  const removeProject = useProjectStore((s) => s.remove)

  const messagesByThread = useMessageStore((s) => s.messagesByThread)

  const byProject = useThreadStore((s) => s.byProject)
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId)
  const statusMap = useThreadStore((s) => s.statusMap)
  const fetchThreads = useThreadStore((s) => s.fetch)
  const createThread = useThreadStore((s) => s.create)
  const removeThread = useThreadStore((s) => s.remove)
  const selectThread = useThreadStore((s) => s.select)

  const [projectDialog, setProjectDialog] = useState<{ mode: 'create' } | { mode: 'edit'; project: Project } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ type: 'project' | 'thread'; id: string; name: string } | null>(null)

  function handleSelectProject(id: string): void {
    selectProject(id)
    if (!byProject[id]) fetchThreads(id)
  }

  async function handleNewThread(): Promise<void> {
    if (!selectedProjectId) return
    await createThread(selectedProjectId, 'New thread')
  }

  async function handleDeleteProject(id: string): Promise<void> {
    await removeProject(id)
    setConfirmDelete(null)
  }

  async function handleDeleteThread(id: string): Promise<void> {
    if (!selectedProjectId) return
    await removeThread(id, selectedProjectId)
    setConfirmDelete(null)
  }

  const threads = selectedProjectId ? (byProject[selectedProjectId] ?? []) : []

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
            <div className="group flex items-center">
              <button
                onClick={() => handleSelectProject(project.id)}
                className="flex flex-1 items-center px-4 py-2 text-left text-sm transition-colors min-w-0"
                style={{
                  background: selectedProjectId === project.id ? 'var(--color-surface-2)' : 'transparent',
                  color: 'var(--color-text)'
                }}
              >
                <span className="mr-2 text-xs flex-shrink-0">📁</span>
                <span className="truncate">{project.name}</span>
              </button>
              {/* Project actions — visible on hover */}
              <div className="flex-shrink-0 flex items-center gap-0.5 pr-2 opacity-0 group-hover:opacity-100 transition-opacity">
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

            {/* Threads under selected project */}
            {selectedProjectId === project.id && (
              <div>
                {threads.map((thread) => {
                  const status = statusMap[thread.id] ?? 'idle'
                  const statusColor =
                    status === 'running' ? '#4ade80'
                    : status === 'error' ? '#f87171'
                    : status === 'stopped' ? '#facc15'
                    : 'var(--color-text-muted)'
                  return (
                    <div key={thread.id} className="group flex items-center">
                      <button
                        onClick={() => selectThread(thread.id)}
                        className="flex flex-1 items-center pl-8 pr-2 py-1.5 text-left text-xs transition-colors min-w-0"
                        style={{
                          background: selectedThreadId === thread.id ? 'var(--color-border)' : 'transparent',
                          color: 'var(--color-text-muted)'
                        }}
                      >
                        <span
                          className="mr-2 h-1.5 w-1.5 rounded-full flex-shrink-0"
                          style={{ background: statusColor }}
                        />
                        <span className="truncate">{thread.name}</span>
                      </button>
                      {/* Thread delete — visible on hover */}
                      <button
                        onClick={() => {
                          const msgs = messagesByThread[thread.id]
                          const isEmpty = !msgs || msgs.length === 0
                          if (isEmpty) {
                            handleDeleteThread(thread.id)
                          } else {
                            setConfirmDelete({ type: 'thread', id: thread.id, name: thread.name })
                          }
                        }}
                        className="flex-shrink-0 mr-2 rounded p-1 text-xs opacity-0 group-hover:opacity-100 hover:bg-white/10 transition-all"
                        style={{ color: 'var(--color-text-muted)' }}
                        title="Delete thread"
                      >
                        ✕
                      </button>
                    </div>
                  )
                })}

                <button
                  onClick={handleNewThread}
                  className="flex w-full items-center pl-8 pr-4 py-1.5 text-left text-xs opacity-50 hover:opacity-80 transition-opacity"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  + New thread
                </button>
              </div>
            )}
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
                onClick={() => confirmDelete.type === 'project'
                  ? handleDeleteProject(confirmDelete.id)
                  : handleDeleteThread(confirmDelete.id)
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
    </aside>
  )
}
