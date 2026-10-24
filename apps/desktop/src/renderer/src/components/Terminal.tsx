import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useTerminalStore } from '../stores/terminal'
import { writeClipboardText } from '../lib/clipboard'
import { client } from '../lib/client'
import { terminalAppearance, useAppearance } from '../lib/theme'

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
  const appearanceTheme = useAppearance((s) => s.theme)
  const fontMono = useAppearance((s) => s.fontMono)

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
      ...terminalAppearance(useAppearance.getState()),
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    term.attachCustomKeyEventHandler((event) => {
      if (!isTerminalCopyShortcut(event) || !term.hasSelection()) return true
      void writeClipboardText(term.getSelection())
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

        const buffer = await client.invoke('terminal:getBuffer', terminalId) as string
        if (disposed) return
        if (buffer) {
          term.write(buffer)
        }

        const unsubData = client.on(`terminal:data:${terminalId}`, (data) => {
          term.write(data as string)
        })

        const inputDisposable = term.onData((data) => {
          if (!terminalIdRef.current) return
          client.send('terminal:write', terminalIdRef.current, data)
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
  }, [ensure, locationId, threadId])

  // Follow theme and font changes without remounting the terminal.
  useEffect(() => {
    const term = xtermRef.current
    if (!term) return
    const { theme, fontFamily } = terminalAppearance({ theme: appearanceTheme, fontMono })
    term.options.theme = theme
    term.options.fontFamily = fontFamily
    fitAddonRef.current?.fit()
  }, [appearanceTheme, fontMono])

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
          client.send('terminal:resize', terminalIdRef.current, cols, rows)
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
