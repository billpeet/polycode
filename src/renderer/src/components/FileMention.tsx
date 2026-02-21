import { ReactNode, useState, useEffect } from 'react'
import { useFilesStore } from '../stores/files'
import { useProjectStore } from '../stores/projects'
import { useUiStore } from '../stores/ui'

interface FileMentionProps {
  path: string
  variant?: 'message-user' | 'message-assistant'
}

/**
 * Check if a path is an attachment (in the polycode-attachments temp directory)
 */
function isAttachmentPath(path: string): boolean {
  return path.includes('polycode-attachments')
}

/**
 * Get the file extension from a path
 */
function getExtension(path: string): string {
  const match = path.match(/\.(\w+)$/)
  return match ? match[1].toLowerCase() : ''
}

/**
 * Check if extension is an image type
 */
function isImageExtension(ext: string): boolean {
  return ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)
}

/**
 * Styled inline file mention badge
 */
export function FileMention({ path, variant = 'message-assistant' }: FileMentionProps) {
  const fileName = path.split(/[\\/]/).pop() ?? path
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

/**
 * Attachment mention - shows image previews or icons for other files
 */
export function AttachmentMention({ path, variant = 'message-assistant' }: FileMentionProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [isExpanded, setIsExpanded] = useState(false)
  const [imageError, setImageError] = useState(false)
  const ext = getExtension(path)
  const isImage = isImageExtension(ext)
  const isPdf = ext === 'pdf'

  // For images, construct attachment:// URL
  // Path format: .../polycode-attachments/threadId/filename
  useEffect(() => {
    if (!isImage) return

    // Extract threadId and filename from path
    const normalizedPath = path.replace(/\\/g, '/')
    const match = normalizedPath.match(/polycode-attachments\/([^/]+)\/([^/]+)$/)
    if (match) {
      const [, threadId, filename] = match
      setImageUrl(`attachment://${threadId}/${filename}`)
    } else {
      // Fallback: try the full path as filename (shouldn't happen)
      setImageUrl(null)
    }
    setImageError(false)
  }, [path, isImage])

  const badgeStyles: React.CSSProperties = {
    background: variant === 'message-user' ? 'rgba(255, 255, 255, 0.15)' : 'rgba(168, 85, 247, 0.1)',
    border: `1px solid ${variant === 'message-user' ? 'rgba(255, 255, 255, 0.25)' : 'rgba(168, 85, 247, 0.25)'}`,
  }

  // Image attachment with preview
  if (isImage && imageUrl && !imageError) {
    return (
      <span className="inline-block align-top">
        <span
          className="group relative inline-block cursor-pointer overflow-hidden rounded-lg transition-all hover:ring-2 hover:ring-purple-400/50"
          onClick={() => setIsExpanded(!isExpanded)}
          title="Click to expand/collapse"
        >
          <img
            src={imageUrl}
            alt="attachment"
            className={`rounded-lg object-contain transition-all ${
              isExpanded ? 'max-h-96 max-w-md' : 'max-h-32 max-w-48'
            }`}
            style={{
              border: variant === 'message-user'
                ? '2px solid rgba(255, 255, 255, 0.3)'
                : '2px solid rgba(168, 85, 247, 0.3)',
            }}
            onError={() => setImageError(true)}
          />
          {/* Expand indicator */}
          <span
            className="absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100"
          >
            {isExpanded ? 'Click to collapse' : 'Click to expand'}
          </span>
        </span>
      </span>
    )
  }

  // Fallback for failed image load - show badge
  if (isImage && imageError) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1"
        style={badgeStyles}
      >
        <ImageIcon variant={variant} />
        <span
          className="text-xs font-medium"
          style={{ color: variant === 'message-user' ? '#fff' : 'var(--color-text)' }}
        >
          Image
        </span>
      </span>
    )
  }

  // PDF attachment
  if (isPdf) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1"
        style={badgeStyles}
      >
        <PdfIcon variant={variant} />
        <span
          className="text-xs font-medium"
          style={{ color: variant === 'message-user' ? '#fff' : 'var(--color-text)' }}
        >
          PDF
        </span>
      </span>
    )
  }

  // Generic attachment
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1"
      style={badgeStyles}
    >
      <ImageIcon variant={variant} />
      <span
        className="text-xs font-medium"
        style={{ color: variant === 'message-user' ? '#fff' : 'var(--color-text)' }}
      >
        Attachment
      </span>
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

function ImageIcon({ variant }: { variant: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke={variant === 'message-user' ? '#fff' : '#a855f7'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  )
}

function PdfIcon({ variant }: { variant: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke={variant === 'message-user' ? '#fff' : '#ef4444'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <path d="M9 15v-2h2a1 1 0 0 1 1 1v0a1 1 0 0 1-1 1H9z" />
    </svg>
  )
}

/**
 * Regex to match file mentions: @path/to/file.ext
 * Handles both Unix and Windows paths, including absolute paths with drive letters
 * Matches @ followed by a path (no spaces, ends at whitespace or end of string)
 */
const FILE_MENTION_REGEX = /@([A-Za-z]:)?([^\s@]+\.\w+)/g

/**
 * Parse text and replace file mentions with styled components
 * Attachments (paths containing polycode-attachments) get special treatment
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
      const textBefore = text.slice(lastIndex, match.index)
      // Skip empty strings or just newlines between consecutive attachments
      if (textBefore.trim()) {
        parts.push(textBefore)
      } else if (textBefore.includes('\n') && parts.length > 0) {
        // Keep meaningful newlines
        parts.push(textBefore)
      }
    }

    // Reconstruct full path (drive letter + rest of path)
    const driveLetter = match[1] ?? ''
    const restOfPath = match[2]
    const filePath = driveLetter + restOfPath

    // Check if this is an attachment path
    if (isAttachmentPath(filePath)) {
      parts.push(
        <AttachmentMention key={`${match.index}-attachment`} path={filePath} variant={variant} />
      )
    } else {
      parts.push(
        <FileMention key={`${match.index}-${filePath}`} path={filePath} variant={variant} />
      )
    }

    lastIndex = match.index + match[0].length
  }

  // Add remaining text
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex)
    // If the remaining text is just whitespace after attachments, skip it
    if (remaining.trim() || parts.length === 0) {
      parts.push(remaining)
    }
  }

  return parts.length > 0 ? parts : [text]
}
