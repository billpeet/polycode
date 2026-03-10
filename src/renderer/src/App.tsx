import { useEffect } from 'react'
import { ErrorBoundary } from '@sentry/react'
import Sidebar from './components/Sidebar'
import ThreadView from './components/ThreadView'
import RightPanel from './components/RightPanel'
import FilePreview from './components/FilePreview'
import CommandLogs from './components/CommandLogs'
import TerminalPane from './components/Terminal'
import ToastStack from './components/Toast'
import TitleBar from './components/TitleBar'
import { SidebarProvider } from './components/ui/sidebar-context'
import { useProjectStore } from './stores/projects'
import { useThreadStore } from './stores/threads'
import { useLocationStore } from './stores/locations'
import { useUiStore } from './stores/ui'
import { useFilesStore } from './stores/files'
import { useToastStore } from './stores/toast'
import { useCommandStore } from './stores/commands'
import { useTerminalStore } from './stores/terminal'
import { useYouTrackStore } from './stores/youtrack'

const SETTING_PROJECT_KEY = 'selectedProjectId'
const SETTING_THREAD_KEY = 'selectedThreadId'

export default function App() {
  const fetchProjects = useProjectStore((s) => s.fetch)
  const projects = useProjectStore((s) => s.projects)
  const projectsLoading = useProjectStore((s) => s.loading)
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const selectProject = useProjectStore((s) => s.select)
  const expandProject = useProjectStore((s) => s.expand)

  const fetchThreads = useThreadStore((s) => s.fetch)
  const fetchLocations = useLocationStore((s) => s.fetch)
  const fetchPools = useLocationStore((s) => s.fetchPools)
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId)
  const selectThread = useThreadStore((s) => s.select)

  const isTodoPanelOpen = useUiStore((s) =>
    selectedThreadId ? (s.todoPanelOpenByThread[selectedThreadId] ?? true) : false
  )

  const selectedFilePath = useFilesStore((s) => s.selectedFilePath)
  const diffView = useFilesStore((s) => s.diffView)
  const loadingDiff = useFilesStore((s) => s.loadingDiff)

  const currentLocationId = useThreadStore((s) => {
    if (!s.selectedThreadId) return null
    for (const threads of Object.values(s.byProject)) {
      const t = threads.find((t) => t.id === s.selectedThreadId)
      if (t) return t.location_id ?? null
    }
    return null
  })

  const selectedInstance = useCommandStore((s) =>
    currentLocationId ? (s.selectedInstanceByLocation[currentLocationId] ?? null) : null
  )
  const hasPinnedCommands = useCommandStore((s) =>
    currentLocationId ? ((s.pinnedInstancesByLocation[currentLocationId] ?? []).length > 0) : false
  )

  const isTerminalOpen = useTerminalStore((s) =>
    selectedThreadId ? (s.visibleByThread[selectedThreadId] ?? false) : false
  )

  const fetchYouTrackServers = useYouTrackStore((s) => s.fetch)

  // 1. On mount: load saved selections from DB, then fetch projects
  useEffect(() => {
    Promise.all([
      window.api.invoke('settings:get', SETTING_PROJECT_KEY),
      window.api.invoke('settings:get', SETTING_THREAD_KEY),
      fetchProjects(),
      fetchYouTrackServers(),
    ]).then(([savedProjectId, savedThreadId]) => {
      if (!savedProjectId) return
      const project = useProjectStore.getState().projects.find((p) => p.id === savedProjectId)
      if (!project) return

      selectProject(project.id)
      expandProject(project.id)
      fetchLocations(project.id)
      fetchPools(project.id)

      fetchThreads(project.id).then(() => {
        if (!savedThreadId) return
        const thread = useThreadStore.getState().byProject[project.id]?.find((t) => t.id === savedThreadId)
        if (thread) selectThread(thread.id)
      })
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keyboard shortcuts
  useEffect(() => {
    function handler(e: KeyboardEvent): void {
      if (!e.ctrlKey) return

      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
      const isInputField = tag === 'input' || tag === 'textarea'

      if (e.key === 't' || e.key === 'T') {
        if (isInputField) return
        e.preventDefault()
        if (selectedProjectId) {
          useThreadStore.getState().create(selectedProjectId, 'New thread')
        }
      } else if (e.key === 'w' || e.key === 'W') {
        if (isInputField) return
        e.preventDefault()
        useThreadStore.getState().select(null)
      } else if (e.key === 'k' || e.key === 'K') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('focus-input'))
      } else if (e.key === '`') {
        e.preventDefault()
        const tid = useThreadStore.getState().selectedThreadId
        if (tid) useTerminalStore.getState().toggleVisible(tid)
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selectedProjectId])

  // Update available notification
  useEffect(() => {
    return window.api.on('app:update-downloaded', () => {
      useToastStore.getState().add({
        type: 'info',
        message: 'Update ready — restart PolyCode to install.',
        duration: 0,
        actionLabel: 'Restart now',
        onAction: async () => {
          try {
            await window.api.invoke('app:install-update')
          } catch (err) {
            useToastStore.getState().add({
              type: 'error',
              message: err instanceof Error ? err.message : 'Failed to restart for update.',
              duration: 0,
            })
          }
        },
      })
    })
  }, [])

  // 4. Persist selections whenever they change
  useEffect(() => {
    if (selectedProjectId) {
      window.api.invoke('settings:set', SETTING_PROJECT_KEY, selectedProjectId)
    }
  }, [selectedProjectId])

  useEffect(() => {
    if (selectedThreadId) {
      window.api.invoke('settings:set', SETTING_THREAD_KEY, selectedThreadId)
    }
  }, [selectedThreadId])

  return (
    <ErrorBoundary fallback={
      <div className="flex h-full w-full items-center justify-center" style={{ color: 'var(--color-text-muted)' }}>
        Something went wrong. Please restart PolyCode.
      </div>
    }>
      <SidebarProvider>
      <div className="flex h-full w-full flex-col overflow-hidden" style={{ background: 'var(--color-bg)' }}>
        <TitleBar />
        <div className="flex flex-1 overflow-hidden">
          <Sidebar />
          <main className="flex flex-1 overflow-hidden">
            {selectedThreadId ? (
              <>
                <div className="flex flex-1 flex-col overflow-hidden">
                  <ThreadView threadId={selectedThreadId} />
                </div>
                {(selectedFilePath || diffView || loadingDiff)
                  ? <FilePreview />
                  : isTerminalOpen
                    ? <TerminalPane threadId={selectedThreadId} />
                    : (selectedInstance || hasPinnedCommands)
                      ? <CommandLogs />
                      : null
                }
                {isTodoPanelOpen && <RightPanel threadId={selectedThreadId} />}
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center gap-2" style={{ color: 'var(--color-text-muted)' }}>
                {projectsLoading && projects.length === 0 ? (
                  <>
                    <span className="status-spinner h-3 w-3" />
                    <span className="text-sm">Loading…</span>
                  </>
                ) : selectedProjectId
                  ? 'Select or create a thread to get started'
                  : 'Select or create a project to get started'}
              </div>
            )}
          </main>
        </div>
      </div>
      <ToastStack />
      </SidebarProvider>
    </ErrorBoundary>
  )
}
