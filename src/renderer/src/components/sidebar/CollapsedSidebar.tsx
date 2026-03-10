import type { ReactNode } from 'react'
import { PanelLeft, Plus, Settings } from 'lucide-react'
import { Project, Thread, ThreadStatus } from '../../types/ipc'
import { Tooltip } from '../ui/tooltip'

interface CollapsedSidebarProps {
  projects: Project[]
  byProject: Record<string, Thread[] | undefined>
  statusMap: Record<string, ThreadStatus | undefined>
  selectedProjectId: string | null
  onToggleSidebar: () => void
  onToggleProject: (projectId: string) => void
  onOpenSettings: () => void
  onOpenProjectDialog: () => void
  dialogs: ReactNode
}

export default function CollapsedSidebar({
  projects,
  byProject,
  statusMap,
  selectedProjectId,
  onToggleSidebar,
  onToggleProject,
  onOpenSettings,
  onOpenProjectDialog,
  dialogs,
}: CollapsedSidebarProps) {
  const runningProjects = projects.filter((project) => {
    const threads = byProject[project.id] ?? []
    return threads.some((thread) => statusMap[thread.id] === 'running' || statusMap[thread.id] === 'stopping')
  })

  return (
    <aside
      className="sidebar-transition flex flex-shrink-0 flex-col items-center overflow-hidden border-r"
      style={{
        width: '48px',
        background: 'var(--color-surface)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div className="flex w-full flex-shrink-0 items-center justify-center border-b py-3" style={{ borderColor: 'var(--color-border)' }}>
        <button
          onClick={onToggleSidebar}
          className="flex items-center justify-center rounded p-1.5 opacity-60 transition-opacity hover:opacity-100"
          style={{ color: 'var(--color-text-muted)' }}
          title="Expand sidebar"
        >
          <PanelLeft size={16} />
        </button>
      </div>

      <div className="w-full flex-1 overflow-y-auto py-1">
        {projects.map((project) => {
          const isActive = selectedProjectId === project.id
          const hasRunning = runningProjects.includes(project)
          const initial = project.name.charAt(0).toUpperCase()

          return (
            <Tooltip key={project.id} content={project.name}>
              <button
                onClick={() => onToggleProject(project.id)}
                className="relative flex w-full items-center justify-center py-2 transition-colors"
                style={{
                  background: isActive ? 'var(--color-surface-2)' : 'transparent',
                  color: isActive ? 'var(--color-text)' : 'var(--color-text-muted)',
                }}
              >
                <span className="text-xs font-semibold">{initial}</span>
                {hasRunning && (
                  <span
                    className="absolute right-2.5 top-1.5 h-1.5 w-1.5 rounded-full"
                    style={{ background: '#4ade80' }}
                  />
                )}
              </button>
            </Tooltip>
          )
        })}
      </div>

      <div className="flex flex-shrink-0 flex-col items-center gap-1 border-t py-2" style={{ borderColor: 'var(--color-border)' }}>
        <Tooltip content="Settings">
          <button
            onClick={onOpenSettings}
            className="flex items-center justify-center rounded p-1.5 opacity-60 transition-opacity hover:opacity-100"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <Settings size={16} />
          </button>
        </Tooltip>
        <Tooltip content="New project">
          <button
            onClick={onOpenProjectDialog}
            className="flex items-center justify-center rounded p-1.5 opacity-60 transition-opacity hover:opacity-100"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <Plus size={16} />
          </button>
        </Tooltip>
      </div>

      {dialogs}
    </aside>
  )
}
