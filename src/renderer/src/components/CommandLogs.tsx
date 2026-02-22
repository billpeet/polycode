import { useState, useEffect, useRef, useCallback } from 'react'
import { useCommandStore, EMPTY_LOGS } from '../stores/commands'
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

// ─── Main component ───────────────────────────────────────────────────────────

export default function CommandLogs() {
  const selectedCommandId = useCommandStore((s) => s.selectedCommandId)
  const logs = useCommandStore((s) => selectedCommandId ? (s.logsByCommand[selectedCommandId] ?? EMPTY_LOGS) : EMPTY_LOGS)
  const status = useCommandStore((s) => selectedCommandId ? (s.statusMap[selectedCommandId] ?? 'idle') : 'idle')
  const appendLog = useCommandStore((s) => s.appendLog)
  const selectCommand = useCommandStore((s) => s.selectCommand)

  // Find the command name from the store
  const commandName = useCommandStore((s) => {
    if (!selectedCommandId) return ''
    for (const cmds of Object.values(s.byProject)) {
      const cmd = cmds.find((c) => c.id === selectedCommandId)
      if (cmd) return cmd.name
    }
    return selectedCommandId
  })

  const bottomRef = useRef<HTMLDivElement>(null)
  const { width, handleMouseDown } = useResize(440)

  // Subscribe to log events for the selected command
  useEffect(() => {
    if (!selectedCommandId) return
    const unsub = window.api.on(`command:log:${selectedCommandId}`, (line) => {
      appendLog(selectedCommandId, line as CommandLogLine)
    })
    return unsub
  }, [selectedCommandId, appendLog])

  // Auto-scroll on new logs
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs.length])

  if (!selectedCommandId) return null

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

      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-b flex-shrink-0"
        style={{ borderColor: 'var(--color-border)' }}
      >
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
        <button
          onClick={() => selectCommand(null)}
          className="rounded p-1 hover:bg-white/10 transition-colors flex-shrink-0"
          style={{ color: 'var(--color-text-muted)' }}
          title="Close"
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
          </svg>
        </button>
      </div>

      {/* Log body */}
      <div
        className="flex-1 overflow-y-auto px-3 py-2"
        style={{
          fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Code", monospace',
          fontSize: '0.72rem',
          lineHeight: 1.6,
        }}
      >
        {logs.length === 0 ? (
          <p className="text-xs py-4 text-center" style={{ color: 'var(--color-text-muted)' }}>
            No output yet.
          </p>
        ) : (
          logs.map((line, idx) => (
            <div
              key={idx}
              style={{
                color: line.stream === 'stderr' ? '#f87171' : 'var(--color-text-muted)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {line.text}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
