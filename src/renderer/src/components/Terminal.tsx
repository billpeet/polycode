import { useState, useEffect, useRef, useCallback } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useTerminalStore } from '../stores/terminal'

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

function useResize(defaultWidth = 500) {
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

// ─── Terminal pane ────────────────────────────────────────────────────────────

interface Props {
  threadId: string
}

export default function TerminalPane({ threadId }: Props) {
  const spawn = useTerminalStore((s) => s.spawn)
  const kill = useTerminalStore((s) => s.kill)

  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const terminalIdRef = useRef<string | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)

  const { width, handleMouseDown } = useResize(500)

  // Mount xterm + spawn PTY
  useEffect(() => {
    if (!containerRef.current) return

    let disposed = false

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Code", monospace',
      theme: {
        background: '#0f0f0f',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
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
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    term.attachCustomKeyEventHandler((event) => {
      if (!isTerminalCopyShortcut(event) || !term.hasSelection()) return true
      void navigator.clipboard.writeText(term.getSelection())
      return false
    })

    // Delay fit to after layout settles
    requestAnimationFrame(() => {
      if (disposed) return
      fitAddon.fit()

      const { cols, rows } = term
      xtermRef.current = term
      fitAddonRef.current = fitAddon

      spawn(threadId, cols, rows).then((newTerminalId) => {
        if (disposed) {
          // Component unmounted before spawn returned
          window.api.invoke('terminal:kill', newTerminalId).catch(() => {})
          return
        }

        terminalIdRef.current = newTerminalId

        const unsubData = window.api.on(`terminal:data:${newTerminalId}`, (data) => {
          term.write(data as string)
        })

        const unsubExit = window.api.on(`terminal:exit:${newTerminalId}`, () => {
          term.write('\r\n\x1b[90m[Process exited]\x1b[0m\r\n')
        })

        const inputDisposable = term.onData((data) => {
          window.api.send('terminal:write', newTerminalId, data)
        })

        cleanupRef.current = () => {
          unsubData()
          unsubExit()
          inputDisposable.dispose()
        }
      }).catch((err) => {
        if (!disposed) {
          term.write(`\x1b[31mFailed to spawn terminal: ${err instanceof Error ? err.message : String(err)}\x1b[0m\r\n`)
        }
      })
    })

    return () => {
      disposed = true
      cleanupRef.current?.()
      cleanupRef.current = null
      term.dispose()
      xtermRef.current = null
      fitAddonRef.current = null
      terminalIdRef.current = null
      kill(threadId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId])

  // Resize handling: observe container and debounce fit + PTY resize
  useEffect(() => {
    if (!containerRef.current) return

    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (!fitAddonRef.current || !xtermRef.current || !terminalIdRef.current) return
        try {
          fitAddonRef.current.fit()
          const { cols, rows } = xtermRef.current
          window.api.send('terminal:resize', terminalIdRef.current, cols, rows)
        } catch {
          // Ignore errors during resize
        }
      }, 30)
    })
    observer.observe(containerRef.current)

    return () => {
      clearTimeout(timer)
      observer.disconnect()
    }
  }, [])

  // Re-fit when panel width changes
  useEffect(() => {
    if (!fitAddonRef.current || !xtermRef.current || !terminalIdRef.current) return
    const timer = setTimeout(() => {
      try {
        fitAddonRef.current?.fit()
        if (xtermRef.current && terminalIdRef.current) {
          const { cols, rows } = xtermRef.current
          window.api.send('terminal:resize', terminalIdRef.current, cols, rows)
        }
      } catch {
        // Ignore
      }
    }, 30)
    return () => clearTimeout(timer)
  }, [width])

  return (
    <div
      className="flex flex-col h-full border-l"
      style={{
        position: 'relative',
        background: '#0f0f0f',
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
          Terminal
        </span>
        <span className="flex-1" />
        <button
          onClick={() => kill(threadId)}
          className="rounded p-1 hover:bg-white/10 transition-colors flex-shrink-0"
          style={{ color: 'var(--color-text-muted)' }}
          title="Close terminal"
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z" />
          </svg>
        </button>
      </div>

      {/* Terminal container */}
      <div
        ref={containerRef}
        className="flex-1"
        style={{ overflow: 'hidden', padding: '4px 0 4px 4px' }}
      />
    </div>
  )
}
