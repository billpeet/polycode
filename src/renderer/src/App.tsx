import { Profiler, useEffect } from 'react'
import { ErrorBoundary } from '@sentry/react'
import Sidebar from './components/Sidebar'
import ThreadView from './components/ThreadView'
import RightPanel from './components/RightPanel'
import SecondPanel from './components/SecondPanel'
import ToastStack from './components/Toast'
import TitleBar from './components/TitleBar'
import { SidebarProvider } from './components/ui/sidebar-context'
import { useProjectStore } from './stores/projects'
import { useThreadStore } from './stores/threads'
import { useLocationStore } from './stores/locations'
import { useUiStore } from './stores/ui'
import { useToastStore } from './stores/toast'
import { useTerminalStore } from './stores/terminal'
import { useYouTrackStore } from './stores/youtrack'
import './stores/plans' // Initialize plan file watcher listener
import { reportReactCommit } from './lib/perf'

const SETTING_PROJECT_KEY = 'selectedProjectId'
const SETTING_THREAD_KEY = 'selectedThreadId'

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || target.isContentEditable
}

export default function App() {
  const fetchProjects = useProjectStore((s) => s.fetch)
  const projects = useProjectStore((s) => s.projects)
  const projectsLoading = useProjectStore((s) => s.loading)
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const selectProject = useProjectStore((s) => s.select)
  const expandProject = useProjectStore((s) => s.expand)

  const fetchThreads = useThreadStore((s) => s.fetch)
  const byProject = useThreadStore((s) => s.byProject)
  const fetchLocations = useLocationStore((s) => s.fetch)
  const fetchPools = useLocationStore((s) => s.fetchPools)
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId)
  const selectThread = useThreadStore((s) => s.select)

  const isTodoPanelOpen = useUiStore((s) =>
    selectedThreadId ? (s.todoPanelOpenByThread[selectedThreadId] ?? true) : false
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
    async function handler(e: KeyboardEvent): Promise<void> {
      const hasPrimaryModifier = e.ctrlKey || e.metaKey
      if (!hasPrimaryModifier) return

      const isInputField = isEditableTarget(e.target)
      const isCopyShortcut = (e.key === 'c' || e.key === 'C') && !e.altKey
      if (isCopyShortcut && !isInputField) {
        const selectionText = window.getSelection?.()?.toString() ?? ''
        if (selectionText) {
          e.preventDefault()
          try {
            await navigator.clipboard.writeText(selectionText)
          } catch {
            // Fall through to the platform handler if clipboard access is denied.
          }
        }
        return
      }

      if (e.key === 't' || e.key === 'T') {
        if (isInputField) return
        e.preventDefault()
        if (selectedProjectId) {
          const locations = useLocationStore.getState().byProject[selectedProjectId] ?? []
          const activeLocations = locations.filter((location) => !location.pool_id || location.checked_out)
          const locationId = activeLocations[0]?.id
          if (locationId) {
            useThreadStore.getState().create(selectedProjectId, 'New thread', locationId)
          }
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
        const state = useThreadStore.getState()
        const tid = state.selectedThreadId
        if (!tid) return
        const locationId = Object.values(state.byProject)
          .flat()
          .find((thread) => thread.id === tid)
          ?.location_id
        if (locationId) useTerminalStore.getState().toggleVisible(locationId)
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

  // Keep the selected project aligned with the currently selected thread.
  useEffect(() => {
    if (!selectedThreadId) return

    const ownerProjectId = Object.entries(byProject).find(([, threads]) =>
      (threads ?? []).some((thread) => thread.id === selectedThreadId)
    )?.[0]

    if (!ownerProjectId || ownerProjectId === selectedProjectId) return

    selectProject(ownerProjectId)
    expandProject(ownerProjectId)
    if (!useLocationStore.getState().byProject[ownerProjectId]) {
      void fetchLocations(ownerProjectId)
    }
    if (!useLocationStore.getState().poolsByProject[ownerProjectId]) {
      void fetchPools(ownerProjectId)
    }
  }, [byProject, expandProject, fetchLocations, fetchPools, selectedProjectId, selectedThreadId, selectProject])

  return (
    <ErrorBoundary
      onError={(error, componentStack) => {
        console.error('[renderer] Unhandled React error reached app boundary', error, componentStack)
      }}
      fallback={
        <div className="flex h-full w-full items-center justify-center" style={{ color: 'var(--color-text-muted)' }}>
          Something went wrong. Please restart PolyCode.
        </div>
      }
    >
      <SidebarProvider>
      <div className="flex h-full w-full flex-col overflow-hidden" style={{ background: 'var(--color-bg)' }}>
        <TitleBar />
        <div className="flex flex-1 overflow-hidden">
          <Profiler id="Sidebar" onRender={reportReactCommit}>
            <Sidebar />
          </Profiler>
          <main className="flex flex-1 overflow-hidden">
            {selectedThreadId ? (
              <>
                <div className="flex flex-1 flex-col overflow-hidden">
                  <Profiler id="ThreadView" onRender={reportReactCommit}>
                    <ThreadView threadId={selectedThreadId} />
                  </Profiler>
                </div>
                <Profiler id="SecondPanel" onRender={reportReactCommit}>
                  <SecondPanel threadId={selectedThreadId} />
                </Profiler>
                {isTodoPanelOpen && (
                  <Profiler id="RightPanel" onRender={reportReactCommit}>
                    <RightPanel threadId={selectedThreadId} />
                  </Profiler>
                )}
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
