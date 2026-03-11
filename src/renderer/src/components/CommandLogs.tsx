import { Fragment, useState, useEffect, useRef, useCallback } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { useCommandStore, EMPTY_LOGS, parseInstKey } from '../stores/commands'
import { useProjectStore } from '../stores/projects'
import { useThreadStore } from '../stores/threads'
import { useLocationStore } from '../stores/locations'
import { CommandLogLine, CommandStatus } from '../types/ipc'

const EMPTY_PINNED: string[] = []
const EMPTY_PORTS: number[] = []

function isTerminalCopyShortcut(event: KeyboardEvent): boolean {
  if (event.altKey) return false
  if (!event.ctrlKey && !event.metaKey) return false
  return event.key === 'c' || event.key === 'C'
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

// ─── Status dot ───────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: CommandStatus }) {
  const color =
    status === 'running' ? '#4ade80'
    : status === 'stopping' ? '#fb923c'
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

// ─── Write log lines to xterm ─────────────────────────────────────────────────

function writeLogLinesToXterm(term: XTerm, lines: CommandLogLine[]) {
  for (const line of lines) {
    if (line.stream === 'stderr') {
      // Wrap stderr lines in red if they don't already contain ANSI color codes
      term.write(`\x1b[31m${line.text}\x1b[0m\r\n`)
    } else {
      term.write(`${line.text}\r\n`)
    }
  }
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

  const status = useCommandStore((s) => s.statusMap[instanceKey] ?? 'idle')
  const ports = useCommandStore((s) => s.portsMap[instanceKey] ?? EMPTY_PORTS)
  const setPorts = useCommandStore((s) => s.setPorts)
  const fetchPorts = useCommandStore((s) => s.fetchPorts)
  const start = useCommandStore((s) => s.start)
  const stop = useCommandStore((s) => s.stop)
  const restart = useCommandStore((s) => s.restart)

  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const initializedRef = useRef(false)

  const toggleSearch = useCallback(() => {
    setSearchOpen((prev) => {
      if (prev) {
        setSearchQuery('')
        searchAddonRef.current?.clearDecorations()
      }
      return !prev
    })
  }, [])

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus()
    }
  }, [searchOpen])

  // Drive search addon from query
  useEffect(() => {
    if (!searchAddonRef.current) return
    if (searchQuery.trim()) {
      searchAddonRef.current.findNext(searchQuery, { incremental: true })
    } else {
      searchAddonRef.current.clearDecorations()
    }
  }, [searchQuery])

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
  const isDifferentLocation = (
    !isDifferentProject &&
    currentLocationId !== null &&
    locationId !== currentLocationId
  )
  const isContextMismatch = isDifferentProject || isDifferentLocation
  const commandLocationLabel = command
    ? ((locationsByProject[command.project_id] ?? []).find((l) => l.id === locationId)?.label ?? null)
    : null

  // Mount xterm
  useEffect(() => {
    if (!containerRef.current) return

    const term = new XTerm({
      cursorBlink: false,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      disableStdin: true,
      fontSize: 12,
      lineHeight: 1.35,
      scrollback: 5000,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Code", monospace',
      theme: {
        background: '#0f0f0f',
        foreground: '#a1a1aa',
        cursor: 'transparent',
        selectionBackground: 'rgba(180, 203, 255, 0.25)',
        black: '#1e1e1e',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#facc15',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#d4d4d4',
        brightBlack: '#6b7280',
        brightRed: '#fca5a5',
        brightGreen: '#86efac',
        brightYellow: '#fde68a',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#f9fafb',
      },
    })

    const fitAddon = new FitAddon()
    const searchAddon = new SearchAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(searchAddon)
    term.open(containerRef.current)
    term.attachCustomKeyEventHandler((event) => {
      if (!isTerminalCopyShortcut(event) || !term.hasSelection()) return true
      void navigator.clipboard.writeText(term.getSelection())
      return false
    })

    xtermRef.current = term
    fitAddonRef.current = fitAddon
    searchAddonRef.current = searchAddon
    initializedRef.current = false

    requestAnimationFrame(() => {
      try { fitAddon.fit() } catch { /* ignore */ }
    })

    // Load existing logs from backend
    window.api.invoke('commands:getLogs', commandId, locationId).then((logs: CommandLogLine[]) => {
      if (logs.length > 0) {
        writeLogLinesToXterm(term, logs)
      }
      initializedRef.current = true
    })

    return () => {
      xtermRef.current = null
      fitAddonRef.current = null
      searchAddonRef.current = null
      initializedRef.current = false
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceKey])

  // Subscribe to streaming log events
  useEffect(() => {
    const unsub = window.api.on(`command:log:${instanceKey}`, (payload) => {
      const term = xtermRef.current
      if (!term) return
      const lines: CommandLogLine[] = Array.isArray(payload)
        ? payload as CommandLogLine[]
        : [payload as CommandLogLine]
      writeLogLinesToXterm(term, lines)
    })
    return unsub
  }, [instanceKey])

  // Clear terminal on restart (status transitions to 'running' after 'stopping')
  const prevStatusRef = useRef(status)
  useEffect(() => {
    if (prevStatusRef.current === 'stopping' && status === 'running') {
      xtermRef.current?.reset()
    }
    prevStatusRef.current = status
  }, [status])

  // Subscribe to port events
  useEffect(() => {
    const unsub = window.api.on(`command:ports:${instanceKey}`, (nextPorts) => {
      setPorts(instanceKey, nextPorts as number[])
    })
    return unsub
  }, [instanceKey, setPorts])

  // Resize observer for xterm fit
  useEffect(() => {
    if (!containerRef.current) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        try { fitAddonRef.current?.fit() } catch { /* ignore */ }
      }, 30)
    })
    observer.observe(containerRef.current)
    return () => {
      clearTimeout(timer)
      observer.disconnect()
    }
  }, [])

  const [pid, setPid] = useState<number | null>(null)

  useEffect(() => {
    if (status === 'running' || status === 'stopping') {
      window.api.invoke('commands:getPid', commandId, locationId).then((p) => setPid(p))
      void fetchPorts(commandId, locationId)
    } else {
      setPid(null)
    }
  }, [commandId, locationId, status, fetchPorts])

  const isActive = status === 'running' || status === 'stopping'
  const isStopping = status === 'stopping'
  const hasRun = isActive || status === 'stopped' || status === 'error'

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
          {ports.length > 0 && (
            <span
              className="text-[10px] font-mono px-1 rounded flex-shrink-0"
              style={{ color: '#4ade80', background: 'rgba(74, 222, 128, 0.12)' }}
              title="Listening ports"
            >
              {ports.join(', ')}
            </span>
          )}
          {/* Start / Stop */}
          {!isActive ? (
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
              onClick={() => !isStopping && stop(commandId, locationId)}
              disabled={isStopping}
              className="rounded p-1 hover:bg-white/10 transition-colors flex-shrink-0 disabled:opacity-50"
              style={{ color: '#f87171' }}
              title={isStopping ? 'Stopping' : 'Stop'}
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                <path d="M5 3.5h6A1.5 1.5 0 0 1 12.5 5v6a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 11V5A1.5 1.5 0 0 1 5 3.5z"/>
              </svg>
            </button>
          )}
          {/* Restart */}
          {hasRun && (
            <button
              onClick={() => !isStopping && restart(commandId, locationId)}
              disabled={isStopping}
              className="rounded p-1 hover:bg-white/10 transition-colors flex-shrink-0 disabled:opacity-50"
              style={{ color: 'var(--color-text-muted)' }}
              title={isStopping ? 'Stopping' : 'Restart'}
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
              onKeyDown={(e) => {
                if (e.key === 'Escape') toggleSearch()
                if (e.key === 'Enter') {
                  if (e.shiftKey) {
                    searchAddonRef.current?.findPrevious(searchQuery)
                  } else {
                    searchAddonRef.current?.findNext(searchQuery)
                  }
                }
              }}
              placeholder="Search logs…"
              className="flex-1 rounded px-2 py-0.5 text-xs outline-none"
              style={{
                background: 'rgba(255,255,255,0.07)',
                border: '1px solid var(--color-border)',
                color: 'var(--color-text)',
              }}
            />
            <button
              onClick={() => searchAddonRef.current?.findPrevious(searchQuery)}
              className="rounded p-0.5 hover:bg-white/10 transition-colors"
              style={{ color: 'var(--color-text-muted)' }}
              title="Previous (Shift+Enter)"
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                <path fillRule="evenodd" d="M7.646 4.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1-.708.708L8 5.707l-5.646 5.647a.5.5 0 0 1-.708-.708z"/>
              </svg>
            </button>
            <button
              onClick={() => searchAddonRef.current?.findNext(searchQuery)}
              className="rounded p-0.5 hover:bg-white/10 transition-colors"
              style={{ color: 'var(--color-text-muted)' }}
              title="Next (Enter)"
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                <path fillRule="evenodd" d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708"/>
              </svg>
            </button>
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

      {/* xterm container */}
      <div
        ref={containerRef}
        className="flex-1"
        style={{ overflow: 'hidden', padding: '4px 0 4px 4px', background: '#0f0f0f', minHeight: 0 }}
      />
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function CommandLogs() {
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
  const pinnedInstances = useCommandStore((s) =>
    currentLocationId ? (s.pinnedInstancesByLocation[currentLocationId] ?? EMPTY_PINNED) : EMPTY_PINNED
  )
  const pinInstance = useCommandStore((s) => s.pinInstance)
  const unpinInstance = useCommandStore((s) => s.unpinInstance)
  const selectInstance = useCommandStore((s) => s.selectInstance)
  const { width, handleMouseDown } = useResize(Math.round(window.innerWidth * 0.3))

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
            onPin={() => pinInstance(key, parseInstKey(key).locationId)}
            onUnpin={() => unpinInstance(key, parseInstKey(key).locationId)}
            onClose={() => {
              const { locationId } = parseInstKey(key)
              if (isPinned) unpinInstance(key, locationId)
              if (currentLocationId) selectInstance(null, currentLocationId)
            }}
          />
        </Fragment>
      ))}
    </div>
  )
}
