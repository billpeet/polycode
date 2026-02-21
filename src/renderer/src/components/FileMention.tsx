import { ReactNode } from 'react'
import { useFilesStore } from '../stores/files'
import { useProjectStore } from '../stores/projects'
import { useUiStore } from '../stores/ui'

interface FileMentionProps {
  path: string
  variant?: 'message-user' | 'message-assistant'
}

/**
 * Styled inline file mention badge
 */
export function FileMention({ path, variant = 'message-assistant' }: FileMentionProps) {
  const fileName = path.split('/').pop() ?? path
  const selectFile = useFilesStore((s) => s.selectFile)
  const projects = useProjectStore((s) => s.projects)
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const project = projects.find((p) => p.id === selectedProjectId)
  const setRightPanelTab = useUiStore((s) => s.setRightPanelTab)

  const styles: Record<string, React.CSSProperties> = {
    'message-user': {
      background: 'rgba(255, 255, 255, 0.2)',
      color: '#fff',
      border: '1px solid rgba(255, 255, 255, 0.3)',
    },
    'message-assistant': {
      background: 'rgba(99, 179, 237, 0.15)',
      color: '#63b3ed',
      border: '1px solid rgba(99, 179, 237, 0.3)',
    },
  }

  const handleClick = () => {
    if (!project) return
    // Convert relative path to absolute path
    const absolutePath = `${project.path}/${path}`.replace(/\\/g, '/')
    selectFile(absolutePath)
    setRightPanelTab('files')
  }

  return (
    <span
      className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-mono text-xs transition-opacity hover:opacity-80"
      style={styles[variant]}
      title={`Click to preview: ${path}`}
      onClick={handleClick}
    >
      <FileIcon />
      {fileName}
    </span>
  )
}

function FileIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}

/**
 * Regex to match file mentions: @path/to/file.ext
 * Matches @ followed by a path (no spaces, ends at whitespace or end of string)
 */
const FILE_MENTION_REGEX = /@([\w./-]+\.\w+)/g

/**
 * Parse text and replace file mentions with styled components
 */
export function parseFileMentions(
  text: string,
  variant: 'message-user' | 'message-assistant' = 'message-assistant'
): ReactNode[] {
  const parts: ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  // Reset regex state
  FILE_MENTION_REGEX.lastIndex = 0

  while ((match = FILE_MENTION_REGEX.exec(text)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }

    // Add the styled mention
    const filePath = match[1]
    parts.push(
      <FileMention key={`${match.index}-${filePath}`} path={filePath} variant={variant} />
    )

    lastIndex = match.index + match[0].length
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return parts.length > 0 ? parts : [text]
}
