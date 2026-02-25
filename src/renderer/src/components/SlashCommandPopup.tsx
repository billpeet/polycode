import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import Fuse from 'fuse.js'
import { SlashCommand } from '../types/ipc'

interface Props {
  commands: SlashCommand[]
  query: string
  onSelect: (command: SlashCommand) => void
  onClose: () => void
  position: { top: number; left: number }
}

export default function SlashCommandPopup({ commands, query, onSelect, onClose, position }: Props) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  const fuse = useMemo(() => {
    return new Fuse(commands, {
      keys: [
        { name: 'name', weight: 0.7 },
        { name: 'description', weight: 0.3 },
      ],
      threshold: 0.4,
      includeMatches: true,
      minMatchCharLength: 1,
    })
  }, [commands])

  const results = useMemo(() => {
    if (!query) {
      return commands.slice(0, 12).map((c) => ({ item: c }))
    }
    return fuse.search(query).slice(0, 12)
  }, [fuse, commands, query])

  useEffect(() => {
    setSelectedIndex(0)
  }, [results])

  useEffect(() => {
    const el = itemRefs.current.get(selectedIndex)
    if (el) {
      el.scrollIntoView({ block: 'nearest' })
    }
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

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (listRef.current && !listRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onClose])

  if (results.length === 0) return null

  return (
    <div
      ref={listRef}
      className="fixed z-50 max-h-72 min-w-64 overflow-y-auto rounded-lg shadow-xl"
      style={{
        bottom: `calc(100vh - ${position.top}px)`,
        left: position.left,
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4)',
      }}
    >
      <div
        className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)' }}
      >
        Slash Commands
      </div>
      {results.map((result, index) => {
        const cmd = result.item
        const isSelected = index === selectedIndex
        const isGlobal = cmd.project_id === null

        return (
          <div
            key={cmd.id}
            ref={(el) => { if (el) itemRefs.current.set(index, el) }}
            onClick={() => onSelect(cmd)}
            onMouseEnter={() => setSelectedIndex(index)}
            className="flex cursor-pointer flex-col gap-0.5 px-3 py-2 text-sm transition-colors"
            style={{
              background: isSelected ? 'var(--color-surface-2)' : 'transparent',
            }}
          >
            <div className="flex items-center gap-2">
              <span
                className="font-mono text-xs font-medium"
                style={{ color: 'var(--color-claude)' }}
              >
                /{cmd.name}
              </span>
              {isGlobal && (
                <span
                  className="rounded px-1 py-0.5 text-[9px] font-semibold uppercase"
                  style={{
                    background: 'rgba(255,255,255,0.06)',
                    color: 'var(--color-text-muted)',
                  }}
                >
                  global
                </span>
              )}
            </div>
            {cmd.description && (
              <span
                className="truncate text-xs"
                style={{ color: 'var(--color-text-muted)' }}
              >
                {cmd.description}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
