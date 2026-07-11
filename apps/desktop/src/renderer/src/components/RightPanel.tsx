import { useState } from 'react'
import { PanelRight } from 'lucide-react'
import FileTree from './FileTree'
import CommandsSection from './right-panel/CommandsSection'
import GitSection from './right-panel/GitSection'
import TasksSection from './right-panel/TasksSection'
import { TabButton } from './right-panel/shared'
import { useUiStore } from '../stores/ui'
import { useRightSidebar } from './ui/sidebar-context'
import { Tooltip } from './ui/tooltip'

interface Props {
  threadId: string
}

export default function RightPanel({ threadId }: Props) {
  const [tasksCollapsed, setTasksCollapsed] = useState(false)
  const [gitCollapsed, setGitCollapsed] = useState(false)
  const activeTab = useUiStore((s) => s.rightPanelTab)
  const setActiveTab = useUiStore((s) => s.setRightPanelTab)
  const { isCollapsed, toggle } = useRightSidebar()

  if (isCollapsed) {
    return (
      <aside
        className="sidebar-transition flex flex-shrink-0 flex-col items-center border-l overflow-hidden"
        style={{
          width: '40px',
          background: 'var(--color-surface)',
          borderColor: 'var(--color-border)',
        }}
      >
        <div className="flex w-full flex-shrink-0 items-center justify-center border-b py-2.5" style={{ borderColor: 'var(--color-border)' }}>
          <Tooltip content="Expand panel">
            <button
              onClick={toggle}
              className="flex items-center justify-center rounded p-1 opacity-60 transition-opacity hover:opacity-100"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <PanelRight size={16} />
            </button>
          </Tooltip>
        </div>

        <div className="flex w-full flex-1 flex-col items-center gap-1 py-2">
          <Tooltip content="Tasks">
            <button
              onClick={() => { setActiveTab('tasks'); if (isCollapsed) toggle() }}
              className="flex items-center justify-center rounded p-1.5 transition-opacity"
              style={{
                color: activeTab === 'tasks' ? 'var(--color-text)' : 'var(--color-text-muted)',
                opacity: activeTab === 'tasks' ? 1 : 0.6,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 11l3 3L22 4" />
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
            </button>
          </Tooltip>
          <Tooltip content="Files">
            <button
              onClick={() => { setActiveTab('files'); if (isCollapsed) toggle() }}
              className="flex items-center justify-center rounded p-1.5 transition-opacity"
              style={{
                color: activeTab === 'files' ? 'var(--color-text)' : 'var(--color-text-muted)',
                opacity: activeTab === 'files' ? 1 : 0.6,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
            </button>
          </Tooltip>
          <Tooltip content="Commands">
            <button
              onClick={() => { setActiveTab('commands'); if (isCollapsed) toggle() }}
              className="flex items-center justify-center rounded p-1.5 transition-opacity"
              style={{
                color: activeTab === 'commands' ? 'var(--color-text)' : 'var(--color-text-muted)',
                opacity: activeTab === 'commands' ? 1 : 0.6,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
            </button>
          </Tooltip>
        </div>
      </aside>
    )
  }

  return (
    <aside
      className="sidebar-transition flex flex-shrink-0 flex-col border-l overflow-hidden"
      style={{ width: '16rem', background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
    >
      <div className="flex items-center flex-shrink-0 border-b" style={{ borderColor: 'var(--color-border)' }}>
        <div className="flex flex-1 items-center">
          <TabButton label="Tasks" active={activeTab === 'tasks'} onClick={() => setActiveTab('tasks')} />
          <TabButton label="Files" active={activeTab === 'files'} onClick={() => setActiveTab('files')} />
          <TabButton label="Commands" active={activeTab === 'commands'} onClick={() => setActiveTab('commands')} />
        </div>
        <Tooltip content="Collapse panel">
          <button
            onClick={toggle}
            className="flex items-center justify-center rounded p-1 mr-2 opacity-60 transition-opacity hover:opacity-100"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <PanelRight size={16} />
          </button>
        </Tooltip>
      </div>

      <div className="flex-1 overflow-y-auto">
        {activeTab === 'tasks' ? (
          <>
            <TasksSection threadId={threadId} collapsed={tasksCollapsed} onToggle={() => setTasksCollapsed((value) => !value)} />
            <div className="flex-shrink-0" style={{ height: 1, background: 'var(--color-border)' }} />
            <GitSection threadId={threadId} collapsed={gitCollapsed} onToggle={() => setGitCollapsed((value) => !value)} />
          </>
        ) : activeTab === 'files' ? (
          <FileTree threadId={threadId} />
        ) : (
          <CommandsSection threadId={threadId} />
        )}
      </div>
    </aside>
  )
}
