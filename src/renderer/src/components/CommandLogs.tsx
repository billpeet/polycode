import { Fragment, useState, useEffect, useRef, useCallback } from 'react'
import { useCommandStore, EMPTY_LOGS, parseInstKey } from '../stores/commands'
import { useProjectStore } from '../stores/projects'
import { useThreadStore } from '../stores/threads'
import { useLocationStore } from '../stores/locations'
import { CommandLogLine, CommandStatus } from '../types/ipc'

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

function useResize(defaultWidth = 400) {
  const [width, setWidth] = useState(defaultWidth)
  const isDragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true
    startX.current = e.clientX
    startWidth.current = width
    document.body.style.cursor = 'col-resize'
    e.preventDefault()
  }, [width])

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

// Strip ANSI escape codes
const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

// ─── Status dot ───────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: CommandStatus }) {
  const color =
    status === 'running' ? '#4ade80'
    : status === 'error' ? '#f87171'
    : 'var(--color-text-muted)'
  return (
    <span
      style={{
        display: 'inline-block',
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
      }}
    />
  )
}

// ─── Single command log panel ─────────────────────────────────────────────────

function CommandLogPanel({
  instanceKey,
  isPinned,
  onPin,
  onUnpin,
  onClose,
}: {
  instanceKey: string
  isPinned: boolean
  onPin: () => void
  onUnpin: () => void
  onClose: () => void
}) {
  const { commandId, locationId } = parseInstKey(instanceKey)

  const logs = useCommandStore((s) => s.logsByCommand[instanceKey] ?? EMPTY_LOGS)
  const status = useCommandStore((s) => s.statusMap[instanceKey] ?? 'idle')
  const appendLog = useCommandStore((s) => s.appendLog)
  const start = useCommandStore((s) => s.start)
  const stop = useCommandStore((s) => s.stop)
  const restart = useCommandStore((s) => s.restart)

  const [searchQuery, setSearchQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const filteredLogs = searchQuery
    ? logs.filter((line) => stripAnsi(line.text).toLowerCase().includes(searchQuery.toLowerCase()))
    : logs

  const toggleSearch = useCallback(() => {
    setSearchOpen((prev) => {
      if (prev) setSearchQuery('')
      return !prev
    })
  }, [])

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus()
    }
  }, [searchOpen])

  const command = useCommandStore((s) => {
    for (const cmds of Object.values(s.byProject)) {
      const cmd = cmds.find((c) => c.id === commandId)
      if (cmd) return cmd
    }
    return null
  })
  const commandName = command?.name ?? commandId

  const projects = useProjectStore((s) => s.projects)
  const locationsByProject = useLocationStore((s) => s.byProject)
  const currentThread = useThreadStore((s) => {
    if (!s.selectedThreadId) return null
    for (const threads of Object.values(s.byProject)) {
      const t = threads.find((t) => t.id === s.selectedThreadId)
      if (t) return t
    }
    return null
  })
  const currentProjectId = currentThread?.project_id ?? null
  const currentLocationId = currentThread?.location_id ?? null
  const commandProject = command ? (projects.find((p) => p.id === command.project_id) ?? null) : null
  const isDifferentProject = command !== null && currentProjectId !== null && command.project_id !== currentProjectId
  // Different location: instance is running in a different location than the current thread
  const isDifferentLocation = (
    !isDifferentProject &&
    currentLocationId !== null &&
    locationId !== currentLocationId
  )
  const isContextMismatch = isDifferentProject || isDifferentLocation
  // Label for the location this instance is running in
  const commandLocationLabel = command
    ? ((locationsByProject[command.project_id] ?? []).find((l) => l.id === locationId)?.label ?? null)
    : null

  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [userScrolled, setUserScrolled] = useState(false)
  const isScrolledToBottom = useRef(true)

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' })
    setUserScrolled(false)
    isScrolledToBottom.current = true
  }, [])

  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150
    isScrolledToBottom.current = atBottom
    setUserScrolled(!atBottom)
  }, [])

  useEffect(() => {
    const unsub = window.api.on(`command:log:${instanceKey}`, (line) => {
      appendLog(instanceKey, line as CommandLogLine)
    })
    return unsub
  }, [instanceKey, appendLog])

  useEffect(() => {
    if (!userScrolled && !searchQuery) {
      scrollToBottom()
    }
  }, [logs.length, userScrolled, searchQuery, scrollToBottom])

  useEffect(() => {
    setUserScrolled(false)
    isScrolledToBottom.current = true
  }, [instanceKey])

  const [pid, setPid] = useState<number | null>(null)

  useEffect(() => {
    if (status === 'running') {
      window.api.invoke('commands:getPid', commandId, locationId).then((p) => setPid(p))
    } else {
      setPid(null)
    }
  }, [commandId, locationId, status])

  const hasRun = status === 'running' || status === 'stopped' || status === 'error'

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div
        className="flex flex-col border-b flex-shrink-0"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="flex items-center gap-2 px-3 py-2">
          <span
            className="text-xs font-semibold rounded px-1.5 py-0.5"
            style={{ background: 'rgba(255,255,255,0.07)', color: 'var(--color-text-muted)' }}
          >
            Logs
          </span>
          <StatusDot status={status} />
          <span className="text-xs font-medium truncate flex-1" style={{ color: 'var(--color-text)' }}>
            {commandName}
          </span>
          {pid !== null && (
            <span
              className="text-[10px] font-mono px-1 rounded flex-shrink-0"
              style={{ color: 'var(--color-text-muted)', background: 'rgba(255,255,255,0.05)' }}
              title="Process ID"
            >
              {pid}
            </span>
          )}
          {/* Start / Stop */}
          {status !== 'running' ? (
            <button
              onClick={() => start(commandId, locationId)}
              className="rounded p-1 hover:bg-white/10 transition-colors flex-shrink-0"
              style={{ color: '#4ade80' }}
              title="Start"
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                <path d="M11.596 8.697l-6.363 3.692c-.54.313-1.233-.066-1.233-.697V4.308c0-.63.692-1.01 1.233-.696l6.363 3.692a.802.802 0 0 1 0 1.393z"/>
              </svg>
            </button>
          ) : (
            <button
              onClick={() => stop(commandId, locationId)}
              className="rounded p-1 hover:bg-white/10 transition-colors flex-shrink-0"
              style={{ color: '#f87171' }}
              title="Stop"
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                <path d="M5 3.5h6A1.5 1.5 0 0 1 12.5 5v6a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 11V5A1.5 1.5 0 0 1 5 3.5z"/>
              </svg>
            </button>
          )}
          {/* Restart */}
          {hasRun && (
            <button
              onClick={() => restart(commandId, locationId)}
              className="rounded p-1 hover:bg-white/10 transition-colors flex-shrink-0"
              style={{ color: 'var(--color-text-muted)' }}
              title="Restart"
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                <path fillRule="evenodd" d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/>
                <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/>
              </svg>
            </button>
          )}
          {/* Search toggle */}
          <button
            onClick={toggleSearch}
            className="rounded p-1 hover:bg-white/10 transition-colors flex-shrink-0"
            style={{ color: searchOpen ? 'var(--color-claude)' : 'var(--color-text-muted)' }}
            title="Search logs"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
              <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001q.044.06.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1 1 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0"/>
            </svg>
          </button>
          {/* Pin / Unpin */}
          <button
            onClick={isPinned ? onUnpin : onPin}
            className="rounded p-1 hover:bg-white/10 transition-colors flex-shrink-0"
            style={{ color: isPinned ? 'var(--color-claude)' : 'var(--color-text-muted)' }}
            title={isPinned ? 'Unpin' : 'Pin'}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4.146.146A.5.5 0 0 1 4.5 0h7a.5.5 0 0 1 .5.5c0 .68-.342 1.174-.646 1.479-.126.125-.25.224-.354.298v4.431l.078.048c.203.127.476.314.751.555C12.36 7.775 13 8.527 13 9.5a.5.5 0 0 1-.5.5h-4v4.5c0 .276-.224 1.5-.5 1.5s-.5-1.224-.5-1.5V10h-4a.5.5 0 0 1-.5-.5c0-.973.64-1.725 1.17-2.189A5.921 5.921 0 0 1 5 6.708V2.277a2.77 2.77 0 0 1-.354-.298C4.342 1.674 4 1.179 4 .5a.5.5 0 0 1 .146-.354z"/>
            </svg>
          </button>
          <button
            onClick={onClose}
            className="rounded p-1 hover:bg-white/10 transition-colors flex-shrink-0"
            style={{ color: 'var(--color-text-muted)' }}
            title="Close"
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
            </svg>
          </button>
        </div>
        {searchOpen && (
          <div className="flex items-center gap-1.5 px-3 pb-2">
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && toggleSearch()}
              placeholder="Filter logs…"
              className="flex-1 rounded px-2 py-0.5 text-xs outline-none"
              style={{
                background: 'rgba(255,255,255,0.07)',
                border: '1px solid var(--color-border)',
                color: 'var(--color-text)',
              }}
            />
            {searchQuery && (
              <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                {filteredLogs.length}/{logs.length}
              </span>
            )}
          </div>
        )}
        {commandProject && (
          <div className="flex items-center gap-1.5 px-3 pb-2">
            {isContextMismatch ? (
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" style={{ color: '#f59e0b', flexShrink: 0 }}>
                <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM7.002 11a1 1 0 1 1 2 0 1 1 0 0 1-2 0zm.938-3.411-.17 3.2a.75.75 0 0 1-1.5 0l-.17-3.2a.92.92 0 0 1 .92-.989h0a.92.92 0 0 1 .92.989z"/>
              </svg>
            ) : (
              <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>
                <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h7A2.5 2.5 0 0 1 14 2.5v11a.5.5 0 0 1-.777.416L8 11.101l-5.223 2.815A.5.5 0 0 1 2 13.5V2.5zm2.5-1A1.5 1.5 0 0 0 3 2.5v10.5l4.5-2.428 4.5 2.428V2.5A1.5 1.5 0 0 0 11.5 1h-7z"/>
              </svg>
            )}
            <span
              className="text-[10px] truncate"
              style={{ color: isContextMismatch ? '#f59e0b' : 'var(--color-text-muted)' }}
            >
              {commandProject.name}{commandLocationLabel ? ` / ${commandLocationLabel}` : ''}
            </span>
            {isDifferentProject && (
              <span
                className="text-[10px] rounded px-1 py-0.5 flex-shrink-0"
                style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}
              >
                different project
              </span>
            )}
            {isDifferentLocation && (
              <span
                className="text-[10px] rounded px-1 py-0.5 flex-shrink-0"
                style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}
              >
                different location
              </span>
            )}
          </div>
        )}
      </div>

      {/* Log body */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="overflow-y-auto px-3 py-2"
          style={{
            position: 'absolute',
            inset: 0,
            fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Code", monospace',
            fontSize: '0.72rem',
            lineHeight: 1.6,
          }}
        >
          {logs.length === 0 ? (
            <p className="text-xs py-4 text-center" style={{ color: 'var(--color-text-muted)' }}>
              No output yet.
            </p>
          ) : filteredLogs.length === 0 ? (
            <p className="text-xs py-4 text-center" style={{ color: 'var(--color-text-muted)' }}>
              No matches.
            </p>
          ) : (
            filteredLogs.map((line, idx) => (
              <div
                key={idx}
                style={{
                  color: line.stream === 'stderr' ? '#f87171' : 'var(--color-text-muted)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
                {stripAnsi(line.text)}
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>
        {userScrolled && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-3 right-3 rounded-full px-3 py-1 text-xs font-medium shadow-lg transition-opacity hover:opacity-90"
            style={{ background: 'var(--color-claude)', color: '#fff', zIndex: 10 }}
          >
            ↓ Latest
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function CommandLogs() {
  const selectedInstance = useCommandStore((s) => s.selectedInstance)
  const pinnedInstances = useCommandStore((s) => s.pinnedInstances)
  const pinInstance = useCommandStore((s) => s.pinInstance)
  const unpinInstance = useCommandStore((s) => s.unpinInstance)
  const selectInstance = useCommandStore((s) => s.selectInstance)
  const { width, handleMouseDown } = useResize(440)

  // Show selected panel only if it isn't already pinned
  const showSelected = selectedInstance !== null && !pinnedInstances.includes(selectedInstance)

  const panels: Array<{ key: string; isPinned: boolean }> = [
    ...pinnedInstances.map((key) => ({ key, isPinned: true })),
    ...(showSelected ? [{ key: selectedInstance!, isPinned: false }] : []),
  ]

  if (panels.length === 0) return null

  return (
    <div
      className="flex flex-col h-full border-l"
      style={{
        position: 'relative',
        background: 'var(--color-surface)',
        borderColor: 'var(--color-border)',
        minWidth: 200,
        width,
        flexShrink: 0,
      }}
    >
      <ResizeHandle onMouseDown={handleMouseDown} />

      {panels.map(({ key, isPinned }, idx) => (
        <Fragment key={key}>
          {idx > 0 && (
            <div style={{ height: 1, background: 'var(--color-border)', flexShrink: 0 }} />
          )}
          <CommandLogPanel
            instanceKey={key}
            isPinned={isPinned}
            onPin={() => pinInstance(key)}
            onUnpin={() => unpinInstance(key)}
            onClose={() => isPinned ? unpinInstance(key) : selectInstance(null)}
          />
        </Fragment>
      ))}
    </div>
  )
}
