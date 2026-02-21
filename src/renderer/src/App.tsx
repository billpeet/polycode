import { useEffect } from 'react'
import Sidebar from './components/Sidebar'
import ThreadView from './components/ThreadView'
import { useProjectStore } from './stores/projects'
import { useThreadStore } from './stores/threads'

export default function App() {
  const fetchProjects = useProjectStore((s) => s.fetch)
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId)

  useEffect(() => {
    fetchProjects()
  }, [fetchProjects])

  return (
    <div className="flex h-full w-full overflow-hidden" style={{ background: 'var(--color-bg)' }}>
      <Sidebar />
      <main className="flex flex-1 flex-col overflow-hidden">
        {selectedThreadId ? (
          <ThreadView threadId={selectedThreadId} />
        ) : (
          <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-text-muted)' }}>
            {selectedProjectId
              ? 'Select or create a thread to get started'
              : 'Select or create a project to get started'}
          </div>
        )}
      </main>
    </div>
  )
}
