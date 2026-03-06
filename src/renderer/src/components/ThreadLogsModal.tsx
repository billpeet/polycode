import { useState, useEffect, useRef } from 'react'
import { ThreadLogEntry } from '../types/ipc'
import { useBackdropClose } from '../hooks/useBackdropClose'

const TYPE_COLORS: Record<string, string> = {
  message_sent: '#63b3ed',
  text: '#4ade80',
  tool_call: '#f6ad55',
  tool_result: '#fbbf24',
  error: '#f87171',
  done: '#a78bfa',
  status: '#94a3b8',
  thinking: '#c084fc',
  usage: '#64748b',
  rate_limit: '#fb923c',
}

function typeColor(type: string): string {
  return TYPE_COLORS[type] ?? '#94a3b8'
}

function formatTs(ts: string): string {
  try {
    const d = new Date(ts)
    return d.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })
  } catch {
    return ts
  }
}

interface LogRowProps {
  entry: ThreadLogEntry
}

function LogRow({ entry }: LogRowProps) {
  const [expanded, setExpanded] = useState(false)
  const hasMetadata = entry.metadata != null && Object.keys(entry.metadata as object).length > 0

  return (
    <div
      style={{
        borderBottom: '1px solid var(--color-border)',
        padding: '6px 8px',
        fontFamily: 'monospace',
        fontSize: '0.72rem',
        lineHeight: 1.5,
      }}
    >
      <div className="flex items-start gap-2">
        <span style={{ color: 'var(--color-text-muted)', flexShrink: 0, fontSize: '0.65rem', paddingTop: 1 }}>
          {formatTs(entry.ts)}
        </span>
        <span
          style={{
            flexShrink: 0,
            padding: '0 5px',
            borderRadius: 3,
            fontSize: '0.65rem',
            fontWeight: 600,
            background: `${typeColor(entry.type)}22`,
            color: typeColor(entry.type),
            border: `1px solid ${typeColor(entry.type)}44`,
          }}
        >
          {entry.type}
        </span>
        {entry.content && (
          <span style={{ color: 'var(--color-text)', wordBreak: 'break-word', minWidth: 0 }}>
            {entry.content}
          </span>
        )}
        {hasMetadata && (
          <button
            onClick={() => setExpanded((v) => !v)}
            style={{
              marginLeft: 'auto',
              flexShrink: 0,
              fontSize: '0.65rem',
              color: 'var(--color-text-muted)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '0 2px',
            }}
            title={expanded ? 'Collapse metadata' : 'Expand metadata'}
          >
            {expanded ? '▲' : '▼'}
          </button>
        )}
      </div>
      {expanded && hasMetadata && (
        <pre
          style={{
            marginTop: 4,
            marginLeft: 0,
            padding: '6px 8px',
            borderRadius: 4,
            background: 'var(--color-surface-2)',
            color: 'var(--color-text-muted)',
            fontSize: '0.65rem',
            overflowX: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {JSON.stringify(entry.metadata, null, 2)}
        </pre>
      )}
    </div>
  )
}

interface Props {
  threadId: string
  onClose: () => void
}

export default function ThreadLogsModal({ threadId, onClose }: Props) {
  const backdropClose = useBackdropClose(onClose)
  const [entries, setEntries] = useState<ThreadLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [copied, setCopied] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  async function load() {
    setLoading(true)
    try {
      const data = await window.api.invoke('threads:getLogs', threadId)
      setEntries(data)
    } finally {
      setLoading(false)
    }
  }

  async function copyToClipboard() {
    const text = filtered.map((e) => JSON.stringify(e)).join('\n')
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  useEffect(() => { load() }, [threadId])

  const filtered = filter.trim()
    ? entries.filter((e) => {
        const q = filter.toLowerCase()
        return e.type.toLowerCase().includes(q) || (e.content ?? '').toLowerCase().includes(q)
      })
    : entries

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={backdropClose.onClick}
      onPointerDown={backdropClose.onPointerDown}
    >
      <div
        style={{
          width: '780px',
          maxWidth: '92vw',
          height: '70vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 8,
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-2.5 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface)' }}
        >
          <span style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--color-text)' }}>
            Thread Logs
          </span>
          <div className="flex items-center gap-2">
            <span style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>
              {filtered.length} {filtered.length === 1 ? 'entry' : 'entries'}
            </span>
            <button
              onClick={copyToClipboard}
              disabled={filtered.length === 0}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors"
              style={{
                color: copied ? '#4ade80' : 'var(--color-text-muted)',
                background: 'transparent',
                border: `1px solid ${copied ? 'rgba(74,222,128,0.3)' : 'var(--color-border)'}`,
                cursor: filtered.length === 0 ? 'default' : 'pointer',
                opacity: filtered.length === 0 ? 0.4 : 1,
              }}
              title="Copy visible entries to clipboard (NDJSON)"
            >
              {copied ? (
                <>
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M12.736 3.97a.733.733 0 0 1 1.047 0c.286.289.29.756.01 1.05L7.88 12.01a.733.733 0 0 1-1.065.02L3.217 8.384a.757.757 0 0 1 0-1.06.733.733 0 0 1 1.047 0l3.052 3.093 5.4-6.425z"/>
                  </svg>
                  Copied
                </>
              ) : (
                <>
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1z"/>
                    <path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0z"/>
                  </svg>
                  Copy
                </>
              )}
            </button>
            <button
              onClick={load}
              disabled={loading}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors"
              style={{
                color: 'var(--color-text-muted)',
                background: 'transparent',
                border: '1px solid var(--color-border)',
                cursor: loading ? 'default' : 'pointer',
                opacity: loading ? 0.5 : 1,
              }}
              title="Refresh logs"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 16 16"
                fill="currentColor"
                className={loading ? 'animate-spin' : undefined}
              >
                <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.418A6 6 0 1 1 8 2v1z"/>
                <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/>
              </svg>
              Refresh
            </button>
            <button
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--color-text-muted)',
                cursor: 'pointer',
                fontSize: '1rem',
                lineHeight: 1,
                padding: '2px 4px',
              }}
              title="Close"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Filter */}
        <div
          className="px-3 py-2 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by type or content…"
            style={{
              width: '100%',
              background: 'var(--color-surface-2)',
              border: '1px solid var(--color-border)',
              borderRadius: 4,
              padding: '4px 8px',
              fontSize: '0.75rem',
              color: 'var(--color-text)',
              outline: 'none',
              fontFamily: 'monospace',
            }}
          />
        </div>

        {/* Log body */}
        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto' }}>
          {loading ? (
            <div
              className="flex items-center justify-center h-full"
              style={{ color: 'var(--color-text-muted)', fontSize: '0.8rem' }}
            >
              Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div
              className="flex items-center justify-center h-full"
              style={{ color: 'var(--color-text-muted)', fontSize: '0.8rem' }}
            >
              {entries.length === 0 ? 'No log entries yet.' : 'No entries match the filter.'}
            </div>
          ) : (
            filtered.map((entry, i) => <LogRow key={i} entry={entry} />)
          )}
        </div>
      </div>
    </div>
  )
}
