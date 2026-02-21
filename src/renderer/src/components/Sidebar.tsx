import { useState } from 'react'
import { useProjectStore } from '../stores/projects'
import { useThreadStore } from '../stores/threads'
import ProjectDialog from './ProjectDialog'

export default function Sidebar() {
  const projects = useProjectStore((s) => s.projects)
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const selectProject = useProjectStore((s) => s.select)

  const byProject = useThreadStore((s) => s.byProject)
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId)
  const statusMap = useThreadStore((s) => s.statusMap)
  const fetchThreads = useThreadStore((s) => s.fetch)
  const createThread = useThreadStore((s) => s.create)
  const selectThread = useThreadStore((s) => s.select)

  const [showProjectDialog, setShowProjectDialog] = useState(false)

  function handleSelectProject(id: string): void {
    selectProject(id)
    if (!byProject[id]) {
      fetchThreads(id)
    }
  }

  async function handleNewThread(): Promise<void> {
    if (!selectedProjectId) return
    const name = `Thread ${Date.now()}`
    await createThread(selectedProjectId, name)
  }

  const threads = selectedProjectId ? (byProject[selectedProjectId] ?? []) : []

  return (
    <aside
      className="flex w-60 flex-shrink-0 flex-col border-r overflow-y-auto"
      style={{
        background: 'var(--color-surface)',
        borderColor: 'var(--color-border)'
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <span className="font-semibold text-sm" style={{ color: 'var(--color-claude)' }}>
          PolyCode
        </span>
        <button
          onClick={() => setShowProjectDialog(true)}
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
            <button
              onClick={() => handleSelectProject(project.id)}
              className="flex w-full items-center px-4 py-2 text-left text-sm transition-colors"
              style={{
                background:
                  selectedProjectId === project.id ? 'var(--color-surface-2)' : 'transparent',
                color: 'var(--color-text)'
              }}
            >
              <span className="mr-2 text-xs">📁</span>
              <span className="truncate">{project.name}</span>
            </button>

            {/* Threads under selected project */}
            {selectedProjectId === project.id && (
              <div>
                {threads.map((thread) => {
                  const status = statusMap[thread.id] ?? 'idle'
                  return (
                    <button
                      key={thread.id}
                      onClick={() => selectThread(thread.id)}
                      className="flex w-full items-center pl-8 pr-4 py-1.5 text-left text-xs transition-colors"
                      style={{
                        background:
                          selectedThreadId === thread.id
                            ? 'var(--color-border)'
                            : 'transparent',
                        color: 'var(--color-text-muted)'
                      }}
                    >
                      <span
                        className="mr-2 h-2 w-2 rounded-full flex-shrink-0"
                        style={{
                          background:
                            status === 'running'
                              ? '#4ade80'
                              : status === 'error'
                                ? '#f87171'
                                : status === 'stopped'
                                  ? '#facc15'
                                  : 'var(--color-text-muted)'
                        }}
                      />
                      <span className="truncate">{thread.name}</span>
                    </button>
                  )
                })}

                {/* New thread button */}
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
          <p
            className="px-4 py-6 text-xs text-center"
            style={{ color: 'var(--color-text-muted)' }}
          >
            No projects yet.
            <br />
            Click &quot;+ Project&quot; to add one.
          </p>
        )}
      </div>

      {showProjectDialog && <ProjectDialog onClose={() => setShowProjectDialog(false)} />}
    </aside>
  )
}
