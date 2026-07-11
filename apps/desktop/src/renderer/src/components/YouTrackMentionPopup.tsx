import { useState, useEffect, useRef, useCallback } from 'react'
import { YouTrackServer, YouTrackIssue } from '../types/ipc'

interface Props {
  servers: YouTrackServer[]
  query: string
  onSelect: (issueId: string) => void
  onClose: () => void
  position: { top: number; left: number }
}

function YouTrackIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <path d="M8 12l3 3 5-5" />
    </svg>
  )
}

export default function YouTrackMentionPopup({ servers, query, onSelect, onClose, position }: Props) {
  const [results, setResults] = useState<YouTrackIssue[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Debounced search across all servers
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)

    if (!query) {
      setResults([])
      setLoading(false)
      return
    }

    setLoading(true)

    searchTimer.current = setTimeout(async () => {
      try {
        const allResults: YouTrackIssue[] = []
        await Promise.all(
          servers.map(async (server) => {
            try {
              const issues = await window.api.invoke('youtrack:search', server.url, server.token, query)
              allResults.push(...issues)
            } catch {
              // Skip failed servers silently
            }
          })
        )
        setResults(allResults.slice(0, 15))
      } finally {
        setLoading(false)
      }
    }, 250)

    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    }
  }, [query, servers])

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0)
  }, [results])

  // Scroll selected item into view
  useEffect(() => {
    const el = itemRefs.current.get(selectedIndex)
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      e.stopPropagation()
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      if (results[selectedIndex]) {
        onSelect(results[selectedIndex].idReadable)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }, [results, selectedIndex, onSelect, onClose])

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [handleKeyDown])

  // Close on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (listRef.current && !listRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onClose])

  return (
    <div
      ref={listRef}
      className="fixed z-50 max-h-64 min-w-80 max-w-md overflow-y-auto rounded-lg shadow-xl"
      style={{
        bottom: `calc(100vh - ${position.top}px)`,
        left: position.left,
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4)',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs"
        style={{
          borderBottom: '1px solid var(--color-border)',
          color: 'var(--color-text-muted)',
        }}
      >
        <YouTrackIcon />
        YouTrack
      </div>

      {loading ? (
        <div className="flex items-center gap-2 px-3 py-2 text-sm" style={{ color: 'var(--color-text-muted)' }}>
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
          Searching...
        </div>
      ) : results.length === 0 ? (
        <div className="px-3 py-2 text-sm" style={{ color: 'var(--color-text-muted)' }}>
          {query ? 'No issues found' : 'Type to search issues...'}
        </div>
      ) : (
        results.map((issue, index) => {
          const isSelected = index === selectedIndex
          return (
            <div
              key={issue.id}
              ref={(el) => { if (el) itemRefs.current.set(index, el) }}
              onClick={() => onSelect(issue.idReadable)}
              className="flex cursor-pointer items-start gap-2 px-3 py-2 text-sm transition-colors"
              style={{
                background: isSelected ? 'var(--color-surface-2)' : 'transparent',
              }}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <span
                className="mt-0.5 shrink-0 font-mono text-xs font-medium"
                style={{ color: '#63b3ed' }}
              >
                {issue.idReadable}
              </span>
              <span className="truncate" style={{ color: 'var(--color-text)' }} title={issue.summary}>
                {issue.summary}
              </span>
            </div>
          )
        })
      )}
    </div>
  )
}
