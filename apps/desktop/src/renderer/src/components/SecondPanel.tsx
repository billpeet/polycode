import { useState, useEffect, useCallback, useRef } from 'react'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'
import { useAvailableAuxTabs, AUX_TAB_LABELS, type AuxTab } from '../hooks/useAvailableAuxTabs'
import { DiffPane, FilePane } from './FilePreview'
import TerminalContent from './Terminal'
import BrowserContent from './Browser'
import CommandLogsContent from './CommandLogs'
import Assassin from './Assassin'
import PlanPane from './PlanPane'
import PanelErrorBoundary from './PanelErrorBoundary'

// ─── Resize handle ────────────────────────────────────────────────────────────

function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      onMouseDown={onMouseDown}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: 4,
        cursor: 'col-resize',
        zIndex: 10,
      }}
    />
  )
}

function useResize(defaultWidth: number) {
  const [width, setWidth] = useState(defaultWidth)
  const isDragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      isDragging.current = true
      startX.current = e.clientX
      startWidth.current = width
      document.body.style.cursor = 'col-resize'
      e.preventDefault()
    },
    [width],
  )

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!isDragging.current) return
      const delta = startX.current - e.clientX
      const newWidth = Math.max(200, Math.min(startWidth.current + delta, window.innerWidth * 0.6))
      setWidth(newWidth)
    }
    function onMouseUp() {
      if (isDragging.current) {
        isDragging.current = false
        document.body.style.cursor = ''
      }
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  return { width, handleMouseDown }
}

// ─── SecondPanel ──────────────────────────────────────────────────────────────

export default function SecondPanel({ threadId }: { threadId: string }) {
  const layoutMode = useUiStore((s) => s.layoutMode)
  const isFull = layoutMode === 'full'
  const chatTabActive = useUiStore((s) => s.isChatTabActive(threadId))
  const setChatTabActive = useUiStore((s) => s.setChatTabActive)

  const {
    tabs: availableTabs,
    locationId: currentLocationId,
    has,
    requestedTab,
    requestedTabVersion,
  } = useAvailableAuxTabs(threadId)

  const { diff: hasDiff, file: hasFile, terminal: hasTerminal, commands: hasCommands, plan: showPlan, browser: hasBrowser } = has

  const selectedFilePath = useFilesStore((s) => currentLocationId ? (s.selectedFilePathByLocation[currentLocationId] ?? null) : s.selectedFilePath)
  const diffView = useFilesStore((s) => currentLocationId ? (s.diffViewByLocation[currentLocationId] ?? null) : s.diffView)

  const activeTab = useUiStore((s) => (s.activeAuxTabByThread[threadId] ?? null) as AuxTab | null)
  const setActiveAuxTab = useUiStore((s) => s.setActiveAuxTab)

  // Selecting any aux tab must also drop the chat tab, otherwise both would
  // claim to be active in full layout.
  const activateTab = useCallback((tab: AuxTab) => {
    if (tab !== 'chat') setActiveAuxTab(threadId, tab)
    setChatTabActive(threadId, tab === 'chat')
  }, [setActiveAuxTab, setChatTabActive, threadId])

  // Auto-switch to a tab when it first becomes available
  const prevHasDiff = useRef(hasDiff)
  const prevHasFile = useRef(hasFile)
  const prevHasTerminal = useRef(hasTerminal)
  const prevHasCommands = useRef(hasCommands)
  const prevShowPlan = useRef(showPlan)
  const prevHasBrowser = useRef(hasBrowser)

  useEffect(() => {
    if (hasDiff && !prevHasDiff.current) activateTab('diff')
    prevHasDiff.current = hasDiff
  }, [hasDiff, activateTab])

  useEffect(() => {
    if (hasFile && !prevHasFile.current) activateTab('file')
    prevHasFile.current = hasFile
  }, [hasFile, activateTab])

  useEffect(() => {
    if (hasTerminal && !prevHasTerminal.current) activateTab('terminal')
    prevHasTerminal.current = hasTerminal
  }, [hasTerminal, activateTab])

  useEffect(() => {
    if (hasCommands && !prevHasCommands.current) activateTab('commands')
    prevHasCommands.current = hasCommands
  }, [hasCommands, activateTab])

  useEffect(() => {
    if (showPlan && !prevShowPlan.current) activateTab('plan')
    prevShowPlan.current = showPlan
  }, [showPlan, activateTab])

  useEffect(() => {
    if (hasBrowser && !prevHasBrowser.current) activateTab('browser')
    prevHasBrowser.current = hasBrowser
  }, [hasBrowser, activateTab])

  useEffect(() => {
    if (!requestedTab) return
    const isAvailable =
      requestedTab === 'diff' ? hasDiff
      : requestedTab === 'file' ? hasFile
      : requestedTab === 'terminal' ? hasTerminal
      : requestedTab === 'commands' ? hasCommands
      : requestedTab === 'browser' ? hasBrowser
      : false
    if (isAvailable) queueMicrotask(() => activateTab(requestedTab))
  }, [requestedTab, requestedTabVersion, hasDiff, hasFile, hasTerminal, hasCommands, showPlan, hasBrowser, activateTab])

  const { width, handleMouseDown } = useResize(Math.round(window.innerWidth * 0.3))

  // In split layout an empty panel collapses entirely. In full layout the panel
  // is the whole workspace, so it always renders — the Chat tab is always there.
  if (availableTabs.length === 0) return null

  // Full layout shows exactly one surface at a time. When Chat is the active
  // tab the chat pane takes the window, so this panel must shrink to its tab
  // bar — otherwise both claim flex:1 and the window splits in two, which is
  // the very thing full mode exists to avoid.
  const collapsedToTabBar = isFull && chatTabActive

  // The chat tab wins while it is active; otherwise fall back to the first
  // available tab when the active one has gone away.
  const currentTab: AuxTab =
    isFull && chatTabActive ? 'chat'
    : activeTab && activeTab !== 'chat' && availableTabs.includes(activeTab) ? activeTab
    : (availableTabs.find((t) => t !== 'chat') ?? availableTabs[0])

  // Tab buttons only earn their space when there is a choice to make; the bar
  // itself always renders, because it carries expand/retract.
  const showTabButtons = availableTabs.length > 1

  return (
    <div
      className={`flex flex-col h-full ${isFull ? '' : 'border-l'}`}
      style={{
        position: 'relative',
        background: currentTab === 'terminal' ? '#0f0f0f' : 'var(--color-surface)',
        borderColor: 'var(--color-border)',
        // Full layout: the panel is the workspace, so it takes the room the
        // collapsed chat pane gave up — unless Chat itself is the active tab,
        // in which case it shrinks to just its tab bar and the chat pane takes
        // the window. Split layout keeps its resizable width.
        ...(isFull
          ? (collapsedToTabBar
              ? { flex: '0 0 auto', width: '100%', height: 'auto', minWidth: 0 }
              : { flex: 1, minWidth: 0 })
          : { minWidth: 200, width, flexShrink: 0 }),
      }}
    >
      {!isFull && <ResizeHandle onMouseDown={handleMouseDown} />}

      {/*
        Always present: besides the tabs it carries expand/retract, which has to
        be reachable with a single pane open (expanding one command log is the
        main reason to go full page) and with only the Chat tab (otherwise there
        is no way back but the keyboard shortcut).
      */}
      <div
        className="flex flex-shrink-0 border-b items-center"
        style={{ borderColor: 'var(--color-border)' }}
      >
        {showTabButtons && availableTabs.map((tab) => (
            <button
              key={tab}
              onClick={() => activateTab(tab)}
              className="px-3 py-1.5 text-xs transition-colors whitespace-nowrap"
              style={{
                color: currentTab === tab ? 'var(--color-text)' : 'var(--color-text-muted)',
                borderBottom:
                  currentTab === tab
                    ? '2px solid var(--color-claude)'
                    : '2px solid transparent',
                background: 'transparent',
              }}
            >
              {AUX_TAB_LABELS[tab]}
            </button>
          ))}

          {/*
            Expand/retract lives here rather than in the thread header: it only
            means anything when there are tabs to expand, and this bar is
            exactly where those tabs are.
          */}
          <button
            onClick={() => useUiStore.getState().toggleLayoutMode()}
            className="ml-auto mr-1.5 rounded p-0.5 hover:opacity-70 transition-opacity flex-shrink-0"
            style={{
              color: 'var(--color-text-muted)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              lineHeight: 1,
            }}
            title={
              isFull
                ? 'Retract to split view (Ctrl+Shift+L)'
                : 'Expand to full page (Ctrl+Shift+L)'
            }
            aria-label={isFull ? 'Retract to split view' : 'Expand to full page'}
          >
            {isFull ? (
              // Retract: arrows pulling inward.
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9.5 6.5h4M9.5 6.5v-4M9.5 6.5L14 2" />
                <path d="M6.5 9.5h-4M6.5 9.5v4M6.5 9.5L2 14" />
              </svg>
            ) : (
              // Expand: arrows pushing outward.
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 2h4v4M14 2l-4.5 4.5" />
                <path d="M6 14H2v-4M2 14l4.5-4.5" />
              </svg>
            )}
          </button>
      </div>

      {/* Plan preview */}
      {currentTab === 'plan' && showPlan && (
        <PanelErrorBoundary context={`Plan panel (${threadId})`}>
          <div className="flex flex-col flex-1 overflow-hidden">
            <PlanPane threadId={threadId} />
          </div>
        </PanelErrorBoundary>
      )}

      {/* Diff panel */}
      {currentTab === 'diff' && hasDiff && (
        <PanelErrorBoundary
          context={diffView ? `Diff preview (${diffView.filePath})` : 'Diff preview'}
          onDismiss={() => useFilesStore.getState().clearDiff()}
        >
          <div className="flex flex-col flex-1 overflow-hidden">
            <DiffPane />
          </div>
        </PanelErrorBoundary>
      )}

      {/* File preview panel */}
      {currentTab === 'file' && hasFile && (
        <PanelErrorBoundary
          context={`File preview (${selectedFilePath})`}
          onDismiss={() => useFilesStore.getState().clearSelection()}
        >
          <div className="flex flex-col flex-1 overflow-hidden">
            <FilePane />
          </div>
        </PanelErrorBoundary>
      )}

      {/* Terminal — kept mounted while open to preserve PTY; hidden behind other tabs via height:0 */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          flex: currentTab === 'terminal' ? 1 : 0,
          height: currentTab === 'terminal' ? 'auto' : 0,
        }}
      >
        {hasTerminal && currentLocationId && (
          <PanelErrorBoundary context={`Terminal (${currentLocationId})`}>
            <TerminalContent threadId={threadId} locationId={currentLocationId} />
          </PanelErrorBoundary>
        )}
      </div>

      {/* Browser — kept mounted while open to preserve guest pages; hidden behind other tabs via height:0 */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          flex: currentTab === 'browser' ? 1 : 0,
          height: currentTab === 'browser' ? 'auto' : 0,
        }}
      >
        {hasBrowser && currentLocationId && (
          <PanelErrorBoundary context={`Browser (${currentLocationId})`}>
            <BrowserContent locationId={currentLocationId} />
          </PanelErrorBoundary>
        )}
      </div>

      {/* Command logs panel */}
      {currentTab === 'commands' && hasCommands && (
        <PanelErrorBoundary context={`Command logs (${currentLocationId ?? threadId})`}>
          <div className="flex flex-col flex-1 overflow-hidden">
            <Assassin threadId={threadId} />
            <CommandLogsContent />
          </div>
        </PanelErrorBoundary>
      )}
    </div>
  )
}
