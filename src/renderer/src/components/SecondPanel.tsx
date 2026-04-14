import { useState, useEffect, useCallback, useRef } from 'react'
import { useFilesStore } from '../stores/files'
import { useTerminalStore } from '../stores/terminal'
import { useCommandStore } from '../stores/commands'
import { useThreadStore } from '../stores/threads'
import { usePlanStore } from '../stores/plans'
import { DiffPane, FilePane } from './FilePreview'
import TerminalContent from './Terminal'
import CommandLogsContent from './CommandLogs'
import Assassin from './Assassin'
import PlanPane from './PlanPane'
import PanelErrorBoundary from './PanelErrorBoundary'

type Tab = 'diff' | 'file' | 'terminal' | 'commands' | 'plan'

const TAB_LABELS: Record<Tab, string> = {
  diff: 'Git Diff',
  file: 'File Preview',
  terminal: 'Terminal',
  commands: 'Command Logs',
  plan: 'Plan',
}

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

  const isTerminalOpen = useTerminalStore((s) =>
    currentLocationId ? (s.visibleByLocation[currentLocationId] ?? false) : false
  )

  const selectedInstance = useCommandStore((s) =>
    currentLocationId ? (s.selectedInstanceByLocation[currentLocationId] ?? null) : null
  )
  const hasPinnedCommands = useCommandStore((s) =>
    currentLocationId ? ((s.pinnedInstancesByLocation[currentLocationId] ?? []).length > 0) : false
  )

  const planVisible = usePlanStore((s) => s.visibleByThread[threadId] ?? false)
  const hasPlan = usePlanStore((s) => !!s.planByThread[threadId])

  const hasDiff = !!(diffView || loadingDiff)
  const hasFile = !!selectedFilePath
  const hasTerminal = isTerminalOpen
  const hasCommands = !!(selectedInstance || hasPinnedCommands)
  const showPlan = planVisible && hasPlan

  const availableTabs: Tab[] = []
  if (showPlan) availableTabs.push('plan')
  if (hasDiff) availableTabs.push('diff')
  if (hasFile) availableTabs.push('file')
  if (hasTerminal) availableTabs.push('terminal')
  if (hasCommands) availableTabs.push('commands')

  const [activeTab, setActiveTab] = useState<Tab | null>(null)

  // Auto-switch to a tab when it first becomes available
  const prevHasDiff = useRef(hasDiff)
  const prevHasFile = useRef(hasFile)
  const prevHasTerminal = useRef(hasTerminal)
  const prevHasCommands = useRef(hasCommands)
  const prevShowPlan = useRef(showPlan)

  useEffect(() => {
    if (hasDiff && !prevHasDiff.current) setActiveTab('diff')
    prevHasDiff.current = hasDiff
  }, [hasDiff])

  useEffect(() => {
    if (hasFile && !prevHasFile.current) setActiveTab('file')
    prevHasFile.current = hasFile
  }, [hasFile])

  useEffect(() => {
    if (hasTerminal && !prevHasTerminal.current) setActiveTab('terminal')
    prevHasTerminal.current = hasTerminal
  }, [hasTerminal])

  useEffect(() => {
    if (hasCommands && !prevHasCommands.current) setActiveTab('commands')
    prevHasCommands.current = hasCommands
  }, [hasCommands])

  useEffect(() => {
    if (showPlan && !prevShowPlan.current) setActiveTab('plan')
    prevShowPlan.current = showPlan
  }, [showPlan])

  const { width, handleMouseDown } = useResize(Math.round(window.innerWidth * 0.3))

  if (availableTabs.length === 0) return null

  // If the active tab is no longer available, fall back to the first available
  const currentTab = activeTab && availableTabs.includes(activeTab) ? activeTab : availableTabs[0]

  const showTabs = availableTabs.length > 1

  return (
    <div
      className="flex flex-col h-full border-l"
      style={{
        position: 'relative',
        background: currentTab === 'terminal' ? '#0f0f0f' : 'var(--color-surface)',
        borderColor: 'var(--color-border)',
        minWidth: 200,
        width,
        flexShrink: 0,
      }}
    >
      <ResizeHandle onMouseDown={handleMouseDown} />

      {/* Tab bar — only when 2+ panels are active */}
      {showTabs && (
        <div
          className="flex flex-shrink-0 border-b"
          style={{ borderColor: 'var(--color-border)' }}
        >
          {availableTabs.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
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
              {TAB_LABELS[tab]}
            </button>
          ))}
        </div>
      )}

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
        {hasTerminal && currentLocationId && <TerminalContent threadId={threadId} locationId={currentLocationId} />}
      </div>

      {/* Command logs panel */}
      {currentTab === 'commands' && hasCommands && (
        <div className="flex flex-col flex-1 overflow-hidden">
          <Assassin threadId={threadId} />
          <CommandLogsContent />
        </div>
      )}
    </div>
  )
}
