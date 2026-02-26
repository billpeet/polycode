import { useEffect, useRef } from 'react'
import { ErrorBoundary } from '@sentry/react'
import Sidebar from './components/Sidebar'
import ThreadView from './components/ThreadView'
import RightPanel from './components/RightPanel'
import FilePreview from './components/FilePreview'
import CommandLogs from './components/CommandLogs'
import ToastStack from './components/Toast'
import TitleBar from './components/TitleBar'
import { useProjectStore } from './stores/projects'
import { useThreadStore } from './stores/threads'
import { useLocationStore } from './stores/locations'
import { useUiStore } from './stores/ui'
import { useFilesStore } from './stores/files'
import { useToastStore } from './stores/toast'
import { useCommandStore } from './stores/commands'
import { useYouTrackStore } from './stores/youtrack'

const STORAGE_PROJECT_KEY = 'polycode:selectedProjectId'
const STORAGE_THREAD_KEY = 'polycode:selectedThreadId'

export default function App() {
  const fetchProjects = useProjectStore((s) => s.fetch)
  const projects = useProjectStore((s) => s.projects)
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const selectProject = useProjectStore((s) => s.select)
  const expandProject = useProjectStore((s) => s.expand)

  const fetchThreads = useThreadStore((s) => s.fetch)
  const byProject = useThreadStore((s) => s.byProject)
  const fetchLocations = useLocationStore((s) => s.fetch)
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

  // Track whether we've attempted restore yet
  const restored = useRef(false)

  const fetchYouTrackServers = useYouTrackStore((s) => s.fetch)

  // 1. Load projects and YouTrack servers on mount
  useEffect(() => {
    fetchProjects()
    fetchYouTrackServers()
  }, [fetchProjects, fetchYouTrackServers])

  // 2. Once projects arrive, restore last selection
  useEffect(() => {
    if (restored.current || projects.length === 0) return

    const savedProjectId = localStorage.getItem(STORAGE_PROJECT_KEY)
    const savedThreadId = localStorage.getItem(STORAGE_THREAD_KEY)

    const project = projects.find((p) => p.id === savedProjectId)
    if (!project) return // saved project no longer exists — leave unselected

    restored.current = true
    selectProject(project.id)
    expandProject(project.id)
    fetchLocations(project.id)
    fetchThreads(project.id).then(() => {
      // selectThread is called inside the byProject effect below
    })

    // Stash thread ID to restore after threads load
    if (savedThreadId) {
      pendingThreadId.current = savedThreadId
    }
  }, [projects, selectProject, expandProject, fetchThreads, fetchLocations])

  // Ref to carry the desired thread ID across the async fetch
  const pendingThreadId = useRef<string | null>(null)

  // 3. Once threads arrive for the restored project, select the saved thread
  useEffect(() => {
    const pending = pendingThreadId.current
    if (!pending || !selectedProjectId) return
    const threads = byProject[selectedProjectId] ?? []
    if (threads.length === 0) return
    const thread = threads.find((t) => t.id === pending)
    if (thread) {
      pendingThreadId.current = null
      selectThread(thread.id)
    }
  }, [byProject, selectedProjectId, selectThread])

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
        message: 'Update ready — restart Polycode to install.',
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

  // 4. Persist selections whenever they change (after initial restore)
  useEffect(() => {
    if (selectedProjectId) {
      localStorage.setItem(STORAGE_PROJECT_KEY, selectedProjectId)
    }
  }, [selectedProjectId])

  useEffect(() => {
    if (selectedThreadId) {
      localStorage.setItem(STORAGE_THREAD_KEY, selectedThreadId)
    }
  }, [selectedThreadId])

  return (
    <ErrorBoundary fallback={
      <div className="flex h-full w-full items-center justify-center" style={{ color: 'var(--color-text-muted)' }}>
        Something went wrong. Please restart Polycode.
      </div>
    }>
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
                  : (selectedInstance || hasPinnedCommands)
                    ? <CommandLogs />
                    : null
                }
                {isTodoPanelOpen && <RightPanel threadId={selectedThreadId} />}
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-text-muted)' }}>
                {selectedProjectId
                  ? 'Select or create a thread to get started'
                  : 'Select or create a project to get started'}
              </div>
            )}
          </main>
        </div>
      </div>
      <ToastStack />
    </ErrorBoundary>
  )
}
