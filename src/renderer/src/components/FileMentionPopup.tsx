import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import Fuse from 'fuse.js'
import { SearchableFile } from '../types/ipc'

interface Props {
  projectPath: string
  query: string
  onSelect: (file: SearchableFile) => void
  onClose: () => void
  position: { top: number; left: number }
}

function FileIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''

  // Color based on file type
  let color = 'var(--color-text-muted)'
  if (['ts', 'tsx'].includes(ext)) color = '#3178c6'
  else if (['js', 'jsx'].includes(ext)) color = '#f7df1e'
  else if (['json'].includes(ext)) color = '#cbcb41'
  else if (['md', 'mdx'].includes(ext)) color = '#083fa1'
  else if (['css', 'scss', 'sass'].includes(ext)) color = '#264de4'
  else if (['html'].includes(ext)) color = '#e34c26'
  else if (['py'].includes(ext)) color = '#3776ab'
  else if (['rs'].includes(ext)) color = '#dea584'
  else if (['go'].includes(ext)) color = '#00add8'

  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}

export default function FileMentionPopup({ projectPath, query, onSelect, onClose, position }: Props) {
  const [files, setFiles] = useState<SearchableFile[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  // Load all files on mount
  useEffect(() => {
    let cancelled = false
    setLoading(true)

    window.api.invoke('files:searchList', projectPath).then((result) => {
      if (!cancelled) {
        setFiles(result)
        setLoading(false)
      }
    }).catch(() => {
      if (!cancelled) {
        setFiles([])
        setLoading(false)
      }
    })

    return () => { cancelled = true }
  }, [projectPath])

  // Fuse.js instance for fuzzy searching
  const fuse = useMemo(() => {
    return new Fuse(files, {
      keys: [
        { name: 'relativePath', weight: 0.7 },
        { name: 'name', weight: 0.3 },
      ],
      threshold: 0.4,
      includeMatches: true,
      minMatchCharLength: 1,
    })
  }, [files])

  // Filter results based on query
  const results = useMemo(() => {
    if (!query) {
      // Show first 10 files when no query
      return files.slice(0, 10).map((f) => ({ item: f, matches: [] }))
    }
    return fuse.search(query).slice(0, 10)
  }, [fuse, files, query])

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0)
  }, [results])

  // Scroll selected item into view
  useEffect(() => {
    const el = itemRefs.current.get(selectedIndex)
    if (el) {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  // Keyboard navigation
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
        onSelect(results[selectedIndex].item)
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
      className="fixed z-50 max-h-64 min-w-64 overflow-y-auto rounded-lg shadow-xl"
      style={{
        bottom: `calc(100vh - ${position.top}px)`,
        left: position.left,
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4)',
      }}
    >
      {loading ? (
        <div className="flex items-center gap-2 px-3 py-2 text-sm" style={{ color: 'var(--color-text-muted)' }}>
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
          Loading files...
        </div>
      ) : results.length === 0 ? (
        <div className="px-3 py-2 text-sm" style={{ color: 'var(--color-text-muted)' }}>
          No files found
        </div>
      ) : (
        results.map((result, index) => {
          const file = result.item
          const isSelected = index === selectedIndex

          return (
            <div
              key={file.path}
              ref={(el) => { if (el) itemRefs.current.set(index, el) }}
              onClick={() => onSelect(file)}
              className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition-colors"
              style={{
                background: isSelected ? 'var(--color-surface-2)' : 'transparent',
                color: 'var(--color-text)',
              }}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <FileIcon name={file.name} />
              <span className="truncate" title={file.relativePath}>
                {file.relativePath}
              </span>
            </div>
          )
        })
      )}
    </div>
  )
}
