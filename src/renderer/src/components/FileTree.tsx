import { useEffect } from 'react'
import { useFilesStore } from '../stores/files'
import { useProjectStore } from '../stores/projects'
import { FileEntry } from '../types/ipc'

const EMPTY_ENTRIES: FileEntry[] = []

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

function FileTreeItem({ entry, depth = 0 }: { entry: FileEntry; depth?: number }) {
  const expandedPaths = useFilesStore((s) => s.expandedPaths)
  const loadingPaths = useFilesStore((s) => s.loadingPaths)
  const entriesByPath = useFilesStore((s) => s.entriesByPath)
  const toggleExpanded = useFilesStore((s) => s.toggleExpanded)
  const selectFile = useFilesStore((s) => s.selectFile)
  const selectedFilePath = useFilesStore((s) => s.selectedFilePath)

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

  return (
    <div>
      <button
        onClick={handleClick}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-white/5 transition-colors"
        style={{
          paddingLeft: `${8 + depth * 12}px`,
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

      {/* Children */}
      {entry.isDirectory && isExpanded && !isLoading && children.length > 0 && (
        <div>
          {children.map((child) => (
            <FileTreeItem key={child.path} entry={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

export default function FileTree() {
  const projects = useProjectStore((s) => s.projects)
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const project = projects.find((p) => p.id === selectedProjectId)

  const entriesByPath = useFilesStore((s) => s.entriesByPath)
  const fetchDirectory = useFilesStore((s) => s.fetchDirectory)
  const loadingPaths = useFilesStore((s) => s.loadingPaths)

  const projectPath = project?.path
  const rootEntries = projectPath ? (entriesByPath[projectPath] ?? EMPTY_ENTRIES) : EMPTY_ENTRIES
  const isLoading = projectPath ? loadingPaths.has(projectPath) : false

  // Load root directory on mount or project change
  useEffect(() => {
    if (projectPath && !entriesByPath[projectPath]) {
      fetchDirectory(projectPath)
    }
  }, [projectPath, entriesByPath, fetchDirectory])

  if (!projectPath) {
    return (
      <div className="px-4 py-6 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
        No project selected.
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

  if (rootEntries.length === 0) {
    return (
      <div className="px-4 py-6 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
        No files found.
      </div>
    )
  }

  return (
    <div className="py-1">
      {rootEntries.map((entry) => (
        <FileTreeItem key={entry.path} entry={entry} />
      ))}
    </div>
  )
}
