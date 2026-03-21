import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useTerminalStore } from '../stores/terminal'

function isTerminalCopyShortcut(event: KeyboardEvent): boolean {
  if (event.altKey) return false
  if (!event.ctrlKey && !event.metaKey) return false
  return event.key === 'c' || event.key === 'C'
}

// ─── Terminal content (inner, no outer wrapper) ───────────────────────────────

interface Props {
  threadId: string
  locationId: string
}

export default function TerminalContent({ threadId, locationId }: Props) {
  const ensure = useTerminalStore((s) => s.ensure)
  const kill = useTerminalStore((s) => s.kill)

  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const terminalIdRef = useRef<string | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)

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

    xtermRef.current = term
    fitAddonRef.current = fitAddon

    requestAnimationFrame(() => {
      void (async () => {
        if (disposed) return
        fitAddon.fit()

        const { cols, rows } = term
        const terminalId = await ensure(threadId, locationId, cols, rows)
        if (disposed) return

        terminalIdRef.current = terminalId

        const buffer = await window.api.invoke('terminal:getBuffer', terminalId) as string
        if (disposed) return
        if (buffer) {
          term.write(buffer)
        }

        const unsubData = window.api.on(`terminal:data:${terminalId}`, (data) => {
          term.write(data as string)
        })

        const inputDisposable = term.onData((data) => {
          if (!terminalIdRef.current) return
          window.api.send('terminal:write', terminalIdRef.current, data)
        })

        cleanupRef.current = () => {
          unsubData()
          inputDisposable.dispose()
        }
      })().catch((err) => {
        if (!disposed) {
          term.write(`\x1b[31mFailed to open terminal: ${err instanceof Error ? err.message : String(err)}\x1b[0m\r\n`)
        }
      })
    })

    return () => {
      disposed = true
      cleanupRef.current?.()
      cleanupRef.current = null
      terminalIdRef.current = null
      fitAddonRef.current = null
      xtermRef.current = null
      term.dispose()
    }
  }, [ensure, locationId])

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
          // Ignore errors during resize.
        }
      }, 30)
    })
    observer.observe(containerRef.current)

    return () => {
      clearTimeout(timer)
      observer.disconnect()
    }
  }, [])

  return (
    <>
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
          onClick={() => kill(locationId)}
          className="rounded p-1 hover:bg-white/10 transition-colors flex-shrink-0"
          style={{ color: 'var(--color-text-muted)' }}
          title="Close terminal"
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z" />
          </svg>
        </button>
      </div>

      <div
        ref={containerRef}
        className="flex-1"
        style={{ overflow: 'hidden', padding: '4px 0 4px 4px' }}
      />
    </>
  )
}
