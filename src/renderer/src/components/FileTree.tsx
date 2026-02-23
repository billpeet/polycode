import { useEffect, useMemo, useRef, useState } from 'react'
import { useFilesStore } from '../stores/files'
import { useThreadStore } from '../stores/threads'
import { useLocationStore } from '../stores/locations'
import { FileEntry } from '../types/ipc'

const EMPTY_ENTRIES: FileEntry[] = []
const EMPTY_LOCATIONS: import('../types/ipc').RepoLocation[] = []

function getFileIcon(name: string, isDirectory: boolean): string {
  if (isDirectory) return '\u{1F4C1}' // folder

  const ext = name.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'ts':
    case 'tsx':
      return '\u{1F535}' // blue circle for TS
    case 'js':
    case 'jsx':
      return '\u{1F7E1}' // yellow circle for JS
    case 'json':
      return '\u{1F7E0}' // orange circle
    case 'md':
    case 'mdx':
      return '\u{1F4DD}' // memo
    case 'css':
    case 'scss':
    case 'less':
      return '\u{1F3A8}' // palette
    case 'html':
      return '\u{1F310}' // globe
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'ico':
      return '\u{1F5BC}' // image
    default:
      return '\u{1F4C4}' // page
  }
}

function FileTreeItem({
  entry,
  depth = 0,
  threadId,
  projectPath,
}: {
  entry: FileEntry
  depth?: number
  threadId: string
  projectPath: string
}) {
  const expandedPaths = useFilesStore((s) => s.expandedPaths)
  const loadingPaths = useFilesStore((s) => s.loadingPaths)
  const entriesByPath = useFilesStore((s) => s.entriesByPath)
  const toggleExpanded = useFilesStore((s) => s.toggleExpanded)
  const selectFile = useFilesStore((s) => s.selectFile)
  const selectedFilePath = useFilesStore((s) => s.selectedFilePath)
  const draftByThread = useThreadStore((s) => s.draftByThread)
  const setDraft = useThreadStore((s) => s.setDraft)
  const [isHovered, setIsHovered] = useState(false)

  const isExpanded = expandedPaths.has(entry.path)
  const isLoading = loadingPaths.has(entry.path)
  const isSelected = selectedFilePath === entry.path
  const children = entriesByPath[entry.path] ?? EMPTY_ENTRIES

  function handleClick() {
    if (entry.isDirectory) {
      toggleExpanded(entry.path)
    } else {
      selectFile(entry.path)
    }
  }

  function handleMentionClick(e: React.MouseEvent) {
    e.stopPropagation()
    // Compute relative path by stripping the project root prefix
    const sep = entry.path.includes('/') && !entry.path.includes('\\') ? '/' : '\\'
    const prefix = projectPath.endsWith(sep) ? projectPath : projectPath + sep
    const relativePath = entry.path.startsWith(prefix)
      ? entry.path.slice(prefix.length)
      : entry.path
    const current = draftByThread[threadId] ?? ''
    const mention = `@${relativePath}`
    const newDraft = current === '' || current.endsWith(' ') || current.endsWith('\n')
      ? current + mention + ' '
      : current + ' ' + mention + ' '
    setDraft(threadId, newDraft)
  }

  return (
    <div>
      <div
        className="relative flex items-center"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <button
          onClick={handleClick}
          className="flex flex-1 items-center gap-1.5 py-1 text-left hover:bg-white/5 transition-colors min-w-0"
          style={{
            paddingLeft: `${8 + depth * 12}px`,
            paddingRight: !entry.isDirectory && isHovered ? '28px' : '8px',
            background: isSelected ? 'rgba(232, 123, 95, 0.15)' : 'transparent',
            color: 'var(--color-text)',
          }}
        >
          {/* Expand/collapse chevron for directories */}
          {entry.isDirectory ? (
            <svg
              width="8"
              height="8"
              viewBox="0 0 8 8"
              fill="currentColor"
              style={{
                transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 0.15s',
                flexShrink: 0,
                opacity: 0.5,
              }}
            >
              <path d="M2 0l4 4-4 4z" />
            </svg>
          ) : (
            <span style={{ width: 8, flexShrink: 0 }} />
          )}

          {/* File/folder icon */}
          <span style={{ fontSize: '0.75rem', flexShrink: 0 }}>
            {isLoading ? (
              <span className="streaming-dot" style={{ width: 6, height: 6, background: 'var(--color-text-muted)' }} />
            ) : (
              getFileIcon(entry.name, entry.isDirectory)
            )}
          </span>

          {/* Name */}
          <span className="text-xs truncate">{entry.name}</span>
        </button>

        {/* @ mention button — files only, visible on hover */}
        {!entry.isDirectory && isHovered && (
          <button
            onClick={handleMentionClick}
            title="Mention file in input"
            className="absolute right-1 flex items-center justify-center transition-colors"
            style={{
              width: 20,
              height: 20,
              borderRadius: 4,
              fontSize: '0.65rem',
              fontWeight: 600,
              background: 'rgba(232, 123, 95, 0.15)',
              color: 'var(--color-accent, #e87b5f)',
              border: '1px solid rgba(232, 123, 95, 0.3)',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            @
          </button>
        )}
      </div>

      {/* Children */}
      {entry.isDirectory && isExpanded && !isLoading && children.length > 0 && (
        <div>
          {children.map((child) => (
            <FileTreeItem key={child.path} entry={child} depth={depth + 1} threadId={threadId} projectPath={projectPath} />
          ))}
        </div>
      )}
    </div>
  )
}

function SearchResultItem({
  entry,
  projectPath,
  threadId,
}: {
  entry: FileEntry
  projectPath: string
  threadId: string
}) {
  const selectFile = useFilesStore((s) => s.selectFile)
  const selectedFilePath = useFilesStore((s) => s.selectedFilePath)
  const draftByThread = useThreadStore((s) => s.draftByThread)
  const setDraft = useThreadStore((s) => s.setDraft)
  const [isHovered, setIsHovered] = useState(false)

  const sep = entry.path.includes('/') && !entry.path.includes('\\') ? '/' : '\\'
  const prefix = projectPath.endsWith(sep) ? projectPath : projectPath + sep
  const relativePath = entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path

  function handleMentionClick(e: React.MouseEvent) {
    e.stopPropagation()
    const current = draftByThread[threadId] ?? ''
    const mention = `@${relativePath}`
    const newDraft = current === '' || current.endsWith(' ') || current.endsWith('\n')
      ? current + mention + ' '
      : current + ' ' + mention + ' '
    setDraft(threadId, newDraft)
  }

  return (
    <div
      className="relative flex items-center"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <button
        onClick={() => selectFile(entry.path)}
        className="flex flex-1 flex-col py-1 px-2 text-left hover:bg-white/5 transition-colors min-w-0"
        style={{
          paddingRight: isHovered ? '28px' : '8px',
          background: selectedFilePath === entry.path ? 'rgba(232, 123, 95, 0.15)' : 'transparent',
          color: 'var(--color-text)',
        }}
      >
        <span className="text-xs truncate">{entry.name}</span>
        <span className="text-xs truncate" style={{ color: 'var(--color-text-muted)', fontSize: '0.65rem' }}>{relativePath}</span>
      </button>
      {isHovered && (
        <button
          onClick={handleMentionClick}
          title="Mention file in input"
          className="absolute right-1 flex items-center justify-center transition-colors"
          style={{
            width: 20,
            height: 20,
            borderRadius: 4,
            fontSize: '0.65rem',
            fontWeight: 600,
            background: 'rgba(232, 123, 95, 0.15)',
            color: 'var(--color-accent, #e87b5f)',
            border: '1px solid rgba(232, 123, 95, 0.3)',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          @
        </button>
      )}
    </div>
  )
}

export default function FileTree({ threadId }: { threadId: string }) {
  const byProject = useThreadStore((s) => s.byProject)
  const archivedByProject = useThreadStore((s) => s.archivedByProject)
  const allLocations = useLocationStore((s) => s.byProject)
  const fetchLocations = useLocationStore((s) => s.fetch)

  // Search all loaded thread arrays
  const thread = Object.values(byProject).flat().find((t) => t.id === threadId)
    ?? Object.values(archivedByProject).flat().find((t) => t.id === threadId)

  const threadProjectId = thread?.project_id ?? null
  const locationsLoaded = threadProjectId ? allLocations[threadProjectId] !== undefined : false
  const threadLocations = threadProjectId ? (allLocations[threadProjectId] ?? EMPTY_LOCATIONS) : EMPTY_LOCATIONS
  // Use thread's location_id, or fallback to first location for the project
  const location = thread?.location_id
    ? threadLocations.find((l) => l.id === thread.location_id)
    : threadLocations[0] ?? null
  const projectPath = location?.path ?? null

  // Fetch locations if not loaded
  useEffect(() => {
    if (threadProjectId && !locationsLoaded) {
      fetchLocations(threadProjectId)
    }
  }, [threadProjectId, locationsLoaded, fetchLocations])

  const entriesByPath = useFilesStore((s) => s.entriesByPath)
  const fetchDirectory = useFilesStore((s) => s.fetchDirectory)
  const loadingPaths = useFilesStore((s) => s.loadingPaths)

  const rootEntries = projectPath ? (entriesByPath[projectPath] ?? EMPTY_ENTRIES) : EMPTY_ENTRIES
  const isLoading = projectPath ? loadingPaths.has(projectPath) : false

  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  // Load root directory on mount or project change
  useEffect(() => {
    if (projectPath && !entriesByPath[projectPath]) {
      fetchDirectory(projectPath)
    }
  }, [projectPath, entriesByPath, fetchDirectory])

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return null
    const allEntries = Object.values(entriesByPath).flat()
    return allEntries.filter((e) => !e.isDirectory && e.name.toLowerCase().includes(q))
  }, [search, entriesByPath])

  if (!projectPath) {
    return (
      <div className="px-4 py-6 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
        {!thread ? 'Thread not loaded.' : !locationsLoaded ? 'Loading...' : 'No location for project.'}
      </div>
    )
  }

  if (isLoading && rootEntries.length === 0) {
    return (
      <div className="px-4 py-6 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
        Loading...
      </div>
    )
  }

  return (
    <div className="flex flex-col" style={{ height: '100%' }}>
      {/* Search bar */}
      <div className="px-2 py-1.5" style={{ borderBottom: '1px solid var(--color-border)' }}>
        <div className="relative">
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            className="absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <circle cx="6.5" cy="6.5" r="4.5" />
            <line x1="10.5" y1="10.5" x2="14" y2="14" />
          </svg>
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search files…"
            className="w-full text-xs rounded"
            style={{
              paddingLeft: '24px',
              paddingRight: search ? '24px' : '8px',
              paddingTop: '4px',
              paddingBottom: '4px',
              background: 'var(--color-surface-raised, rgba(255,255,255,0.05))',
              border: '1px solid var(--color-border)',
              color: 'var(--color-text)',
              outline: 'none',
            }}
            onKeyDown={(e) => e.key === 'Escape' && setSearch('')}
          />
          {search && (
            <button
              onClick={() => { setSearch(''); searchRef.current?.focus() }}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center"
              style={{ color: 'var(--color-text-muted)', width: 16, height: 16 }}
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* File list */}
      <div className="overflow-y-auto flex-1 py-1">
        {searchResults ? (
          searchResults.length === 0 ? (
            <div className="px-4 py-6 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
              No files match.
            </div>
          ) : (
            searchResults.map((entry) => (
              <SearchResultItem key={entry.path} entry={entry} projectPath={projectPath} threadId={threadId} />
            ))
          )
        ) : rootEntries.length === 0 ? (
          <div className="px-4 py-6 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
            No files found.
          </div>
        ) : (
          rootEntries.map((entry) => (
            <FileTreeItem key={entry.path} entry={entry} threadId={threadId} projectPath={projectPath} />
          ))
        )}
      </div>
    </div>
  )
}
