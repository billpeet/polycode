import { Profiler, useEffect } from 'react'
import Sidebar from './components/Sidebar'
import ThreadView from './components/ThreadView'
import RightPanel from './components/RightPanel'
import SecondPanel from './components/SecondPanel'
import ToastStack from './components/Toast'
import TitleBar from './components/TitleBar'
import { UpdateBanner } from './components/UpdateBanner'
import { SidebarProvider } from './components/ui/sidebar-context'
import { useProjectStore } from './stores/projects'
import { useThreadStore } from './stores/threads'
import { useLocationStore } from './stores/locations'
import { useUiStore } from './stores/ui'
import { useAvailableAuxTabs, type AuxTab } from './hooks/useAvailableAuxTabs'
import { useTerminalStore } from './stores/terminal'
import { useYouTrackStore } from './stores/youtrack'
import { useFavouritesStore, formatFavourite, Favourite } from './stores/favourites'
import { useFilesStore } from './stores/files'
import { useGitStore } from './stores/git'
import { useCommandStore } from './stores/commands'
import { Provider } from './types/ipc'
import { useToastStore } from './stores/toast'
import './stores/plans' // Initialize plan file watcher listener
import { useBrowserStore } from './stores/browser'
import { reportReactCommit } from './lib/perf'
import { getCurrentLocationId } from './lib/currentLocation'
import UiErrorBoundary from './components/UiErrorBoundary'
import { useDatabaseSync } from './hooks/useDatabaseSync'
import { writeClipboardText } from './lib/clipboard'

const SETTING_PROJECT_KEY = 'selectedProjectId'
const SETTING_THREAD_KEY = 'selectedThreadId'

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || target.isContentEditable
}

export default function App() {
  useDatabaseSync()

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

  const layoutMode = useUiStore((s) => s.layoutMode)
  const chatTabActive = useUiStore((s) =>
    selectedThreadId ? (s.chatTabActiveByThread[selectedThreadId] ?? true) : true
  )
  // Shared with SecondPanel so the Ctrl+Tab cycle and the rendered tab bar can
  // never disagree about which tabs exist.
  const { tabs: auxTabs } = useAvailableAuxTabs(selectedThreadId ?? '')
  // In full layout the chat only shows when its tab is selected; in split it is
  // always visible. Note this controls *visibility*, never mounting — see below.
  const chatVisible = layoutMode === 'split' || chatTabActive

  const fetchYouTrackServers = useYouTrackStore((s) => s.fetch)
  const loadFavourites = useFavouritesStore((s) => s.load)

  // Popups from browser-panel guest pages (target=_blank) arrive here as
  // "open this url in the same location's browser panel" requests from main.
  useEffect(() => {
    return window.api.on('browser:popup-request', (locationId, url) => {
      if (typeof locationId === 'string' && typeof url === 'string') {
        void useBrowserStore.getState().open(locationId, url)
      }
    })
  }, [])

  // 1. On mount: load saved selections from DB, then fetch projects
  useEffect(() => {
    Promise.all([
      window.api.invoke('settings:get', SETTING_PROJECT_KEY),
      window.api.invoke('settings:get', SETTING_THREAD_KEY),
      fetchProjects(),
      fetchYouTrackServers(),
      loadFavourites(),
      useUiStore.getState().loadLayoutMode(),
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
          await writeClipboardText(selectionText)
        }
        return
      }

      // Ctrl+1..9 loads a favourite combo; Ctrl+Shift+1..9 saves the current one.
      const digitMatch = /^Digit([1-9])$/.exec(e.code)
      if (digitMatch) {
        e.preventDefault()
        const slot = Number(digitMatch[1])
        const threadStore = useThreadStore.getState()
        const tid = threadStore.selectedThreadId
        const thread = tid
          ? Object.values(threadStore.byProject).flat().find((t) => t.id === tid)
          : undefined
        if (!thread) {
          useToastStore.getState().add({ type: 'info', message: 'Select a thread first' })
          return
        }

        if (e.shiftKey) {
          const fav: Favourite = {
            provider: thread.provider as Provider,
            model: thread.model,
            reasoningLevel: thread.reasoning_level ?? 'off',
          }
          await useFavouritesStore.getState().save(slot, fav)
          useToastStore.getState().add({ type: 'success', message: `Saved favourite ${slot}: ${formatFavourite(fav)}` })
        } else {
          const fav = useFavouritesStore.getState().bySlot[slot]
          if (!fav) {
            useToastStore.getState().add({ type: 'info', message: `Favourite ${slot} is empty (Ctrl+Shift+${slot} to save)` })
            return
          }
          // Provider is locked once a thread has messages — other providers
          // have no access to this conversation history.
          if (thread.has_messages && fav.provider !== thread.provider) {
            useToastStore.getState().add({ type: 'info', message: `Favourite ${slot} uses ${fav.provider} — the provider can't change once a thread has messages` })
            return
          }
          await threadStore.setProviderAndModel(thread.id, fav.provider, fav.model)
          await threadStore.setReasoningLevel(thread.id, fav.reasoningLevel)
          useToastStore.getState().add({ type: 'success', message: `Loaded favourite ${slot}: ${formatFavourite(fav)}` })
        }
        return
      }

      if ((e.key === 't' || e.key === 'T') && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        if (selectedProjectId) {
          const threadState = useThreadStore.getState()
          const locations = useLocationStore.getState().byProject[selectedProjectId] ?? []
          const locationId = getCurrentLocationId(
            threadState.byProject[selectedProjectId] ?? [],
            threadState.selectedThreadId,
            locations,
          )
          if (locationId) {
            // Create-on-send: opens the draft composer prefilled with the
            // current destination; the Thread materializes on first send.
            threadState.openDraftThread(selectedProjectId, locationId)
            window.dispatchEvent(new CustomEvent('focus-input'))
          }
        }
      } else if ((e.key === 'w' || e.key === 'W') && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        if (!selectedProjectId) return

        const threadState = useThreadStore.getState()
        const currentThread = (threadState.byProject[selectedProjectId] ?? [])
          .find((thread) => thread.id === threadState.selectedThreadId)
        if (!currentThread) return

        // Closing the create-on-send draft just discards it — no DB row exists.
        if (currentThread.is_pending && threadState.draftNewThreadId === currentThread.id) {
          threadState.discardDraftThread()
          return
        }

        const remainingThreads = (threadState.byProject[selectedProjectId] ?? [])
          .filter((thread) => thread.id !== currentThread.id)
        const replacementThread = remainingThreads
          .filter((thread) => thread.location_id === currentThread.location_id)
          .slice()
          .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0]

        if (replacementThread) {
          threadState.select(replacementThread.id)
        } else if (currentThread.location_id) {
          threadState.openDraftThread(selectedProjectId, currentThread.location_id)
        } else {
          threadState.select(null)
        }

        await threadState.archive(currentThread.id, selectedProjectId)
      } else if ((e.key === 'l' || e.key === 'L') && !e.altKey && e.shiftKey) {
        e.preventDefault()
        useUiStore.getState().toggleLayoutMode()
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

  // Ctrl+Tab / Ctrl+Shift+Tab cycles aux tabs in full layout. Registered on the
  // capture phase so a focused xterm — which binds its own key handling — cannot
  // swallow it first.
  useEffect(() => {
    if (layoutMode !== 'full' || !selectedThreadId || auxTabs.length < 2) return


    function handler(e: KeyboardEvent): void {
      if (e.key !== 'Tab' || !(e.ctrlKey || e.metaKey) || e.altKey) return
      e.preventDefault()
      e.stopPropagation()

      const ui = useUiStore.getState()
      const threadId = selectedThreadId as string
      const current: AuxTab = ui.isChatTabActive(threadId)
        ? 'chat'
        : ((ui.activeAuxTabByThread[threadId] as AuxTab | undefined)
            ?? auxTabs.find((t) => t !== 'chat')
            ?? 'chat')

      const index = auxTabs.indexOf(current)
      const next = auxTabs[
        (((index === -1 ? 0 : index) + (e.shiftKey ? -1 : 1)) + auxTabs.length) % auxTabs.length
      ]

      if (next === 'chat') {
        ui.setChatTabActive(threadId, true)
      } else {
        ui.setActiveAuxTab(threadId, next)
        ui.setChatTabActive(threadId, false)
      }
    }

    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [layoutMode, selectedThreadId, auxTabs])

  useEffect(() => {
    return window.api.on('remote:active-changed', () => {
      useProjectStore.setState({
        projects: [],
        archivedProjects: [],
        selectedProjectId: null,
        expandedProjectIds: new Set<string>(),
        loading: false,
      })
      useThreadStore.setState({
        byProject: {},
        archivedByProject: {},
        archivedCountByProject: {},
        archivedPageByProject: {},
        selectedThreadId: null,
        statusMap: {},
        unreadByThread: {},
        expandedArchivedProjectId: null,
        draftByThread: {},
        planModeByThread: {},
        fastModeByThread: {},
        queuedMessageByThread: {},
        usageByThread: {},
        runStartedAtByThread: {},
        pidByThread: {},
        pendingThreadIdByLocation: {},
        queueThreads: [],
        draftNewThreadId: null,
        draftNewWorktree: false,
      })
      useLocationStore.setState({
        byProject: {},
        poolsByProject: {},
        deletingWorktreesByProject: {},
      })
      useCommandStore.setState({
        byProject: {},
        statusMap: {},
        portsMap: {},
        logsByCommand: {},
        selectedInstanceByLocation: {},
        pinnedInstancesByLocation: {},
      })
      useTerminalStore.setState({
        terminalByLocation: {},
        visibleByLocation: {},
        widthByLocation: {},
      })
      useFilesStore.setState({
        entriesByPath: {},
        expandedPaths: new Set<string>(),
        loadingPaths: new Set<string>(),
        selectedFilePath: null,
        fileContent: null,
        loadingContent: false,
        selectedFilePathByLocation: {},
        fileContentByLocation: {},
        loadingContentByLocation: {},
        diffView: null,
        loadingDiff: false,
        diffViewByLocation: {},
        loadingDiffByLocation: {},
      })
      useGitStore.setState({
        statusByPath: {},
        loadingByPath: {},
        notRepoByPath: {},
        commitMessageByPath: {},
        generatingMessageByPath: {},
        pushingByPath: {},
        pullingByPath: {},
        refreshingRemoteByPath: {},
        branchesByPath: {},
        branchLoadingByPath: {},
        initializingByPath: {},
        lastCommitByPath: {},
        amendingByPath: {},
        undoingCommitByPath: {},
        stashesByPath: {},
        stashLoadingByPath: {},
        stashBusyByPath: {},
        modifiedFilesByThread: {},
      })
      void fetchProjects()
    })
  }, [fetchProjects])

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
    <UiErrorBoundary
      context="PolyCode"
      variant="root"
      resetKeys={[selectedThreadId]}
      onEscape={() => useThreadStore.getState().select(null)}
    >
      <SidebarProvider>
      <div className="flex h-full w-full flex-col overflow-hidden" style={{ background: 'var(--color-bg)' }}>
        <UiErrorBoundary context="Application header">
          <TitleBar />
          <UpdateBanner />
        </UiErrorBoundary>
        <div className="flex flex-1 overflow-hidden">
          <Profiler id="Sidebar" onRender={reportReactCommit}>
            <UiErrorBoundary context="Sidebar" resetKeys={[selectedProjectId]}>
              <Sidebar />
            </UiErrorBoundary>
          </Profiler>
          <main className="flex flex-1 overflow-hidden">
            {selectedThreadId ? (
              <>
                {/*
                  The chat pane stays mounted in both layouts and is hidden with
                  CSS, never unmounted. ThreadView owns the thread:output IPC
                  subscriptions and MessageStream's virtualizer state, so
                  swapping it in and out on a layout toggle would drop events and
                  reset scroll position. Width 0 (rather than display:none) keeps
                  the element measurable, so the virtualizer's height cache does
                  not fill with zeroes while hidden.
                */}
                {/*
                  Split lays chat and the aux panel side by side. Full stacks
                  them, so the aux tab bar sits above whichever single surface
                  is showing — the panel body, or the chat when its tab is
                  active. Same two children either way; only the axis changes.
                */}
                <div
                  className={`flex flex-1 overflow-hidden ${layoutMode === 'full' ? 'flex-col' : 'flex-row'}`}
                >
                  <div
                    className="flex flex-col overflow-hidden"
                    style={{
                      // order (not DOM position) puts the tab bar above the chat
                      // in full layout, so the chat element is never moved in the
                      // tree and never remounts.
                      order: layoutMode === 'full' ? 1 : 0,
                      ...(chatVisible ? { flex: 1 } : { flex: 0, width: 0, height: 0 }),
                    }}
                    aria-hidden={!chatVisible}
                  >
                    <Profiler id="ThreadView" onRender={reportReactCommit}>
                      <UiErrorBoundary context="Thread workspace" resetKeys={[selectedThreadId]}>
                        <ThreadView threadId={selectedThreadId} />
                      </UiErrorBoundary>
                    </Profiler>
                  </div>
                  <Profiler id="SecondPanel" onRender={reportReactCommit}>
                    <UiErrorBoundary context="Auxiliary panel" resetKeys={[selectedThreadId]}>
                      <SecondPanel threadId={selectedThreadId} />
                    </UiErrorBoundary>
                  </Profiler>
                </div>
                {isTodoPanelOpen && (
                  <Profiler id="RightPanel" onRender={reportReactCommit}>
                    <UiErrorBoundary context="Right panel" resetKeys={[selectedThreadId]}>
                      <RightPanel threadId={selectedThreadId} />
                    </UiErrorBoundary>
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
      <UiErrorBoundary context="Notifications">
        <ToastStack />
      </UiErrorBoundary>
      </SidebarProvider>
    </UiErrorBoundary>
  )
}
