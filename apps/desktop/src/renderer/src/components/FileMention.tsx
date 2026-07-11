import { ReactNode, useState, useEffect } from 'react'
import { useFilesStore } from '../stores/files'
import { useProjectStore } from '../stores/projects'
import { useLocationStore } from '../stores/locations'
import { useThreadStore } from '../stores/threads'
import { useUiStore } from '../stores/ui'
import { RepoLocation } from '../types/ipc'

const EMPTY_LOCATIONS: RepoLocation[] = []

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
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId)
  const byProject = useThreadStore((s) => s.byProject)
  const projectLocations = useLocationStore((s) => selectedProjectId ? (s.byProject[selectedProjectId] ?? EMPTY_LOCATIONS) : EMPTY_LOCATIONS)
  const setRightPanelTab = useUiStore((s) => s.setRightPanelTab)

  // Find location path for the selected thread
  const threads = selectedProjectId ? (byProject[selectedProjectId] ?? []) : []
  const thread = threads.find((t) => t.id === selectedThreadId)
  const location = thread?.location_id ? projectLocations.find((l) => l.id === thread.location_id) : null

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
    if (!location) return
    // Convert relative path to absolute path
    const absolutePath = `${location.path}/${path}`.replace(/\\/g, '/')
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
 * Styled inline directory mention badge
 */
export function FolderMention({ path, variant = 'message-assistant' }: FileMentionProps) {
  // Strip trailing slash for display
  const displayPath = path.endsWith('/') ? path.slice(0, -1) : path
  const folderName = displayPath.split(/[\\/]/).pop() ?? displayPath

  const styles: Record<string, React.CSSProperties> = {
    'message-user': {
      background: 'rgba(255, 255, 255, 0.2)',
      color: '#fff',
      border: '1px solid rgba(255, 255, 255, 0.3)',
    },
    'message-assistant': {
      background: 'rgba(232, 184, 109, 0.15)',
      color: '#e8b86d',
      border: '1px solid rgba(232, 184, 109, 0.3)',
    },
  }

  return (
    <span
      className="inline-flex cursor-default items-center gap-1 rounded px-1.5 py-0.5 font-mono text-xs"
      style={styles[variant]}
      title={displayPath}
    >
      <FolderIcon />
      {folderName}
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

function FolderIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
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
 * Regex to match YouTrack issue mentions: @PROJ-123
 * Project codes are uppercase letters/digits, followed by a dash and issue number.
 * Must be preceded by whitespace or start-of-string, and followed by whitespace,
 * end-of-string, or common punctuation.
 */
const YOUTRACK_MENTION_REGEX = /(?<!\S)@([A-Z][A-Z0-9]+-[0-9]+)(?=[\s,!?.;]|$)/g

/**
 * Styled inline YouTrack issue mention badge
 */
export function YouTrackMention({
  issueId,
  variant = 'message-assistant',
}: {
  issueId: string
  variant?: 'message-user' | 'message-assistant'
}) {
  const styles: Record<string, React.CSSProperties> = {
    'message-user': {
      background: 'rgba(255, 255, 255, 0.15)',
      color: '#fff',
      border: '1px solid rgba(255, 255, 255, 0.25)',
    },
    'message-assistant': {
      background: 'rgba(99, 179, 237, 0.12)',
      color: '#63b3ed',
      border: '1px solid rgba(99, 179, 237, 0.3)',
    },
  }

  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-xs"
      style={styles[variant]}
      title={`YouTrack issue ${issueId}`}
    >
      <YouTrackBadgeIcon />
      {issueId}
    </span>
  )
}

function YouTrackBadgeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <circle cx="12" cy="12" r="10" />
      <path d="M8 12l3 3 5-5" />
    </svg>
  )
}

/**
 * Regex to match file and directory mentions: @path/to/file.ext or @path/to/dir/
 * Handles both Unix and Windows paths, including absolute paths with drive letters.
 * File mentions end with an extension (.ext); directory mentions must have at least
 * two path segments (e.g. @src/components/) to avoid false-positives on npm scoped
 * packages like @scope/pkg or other @-prefixed tokens.
 * Requires @ to be at start-of-string or preceded by whitespace ((?<!\S)).
 * File pattern is first so paths like @src/file.ts match as files, not truncated dirs.
 */
const FILE_MENTION_REGEX = /(?<!\S)@([A-Za-z]:)?([^\s@]+\.\w+|[^\s@/]+\/[^\s@]+\/)/g

/**
 * Parse text and replace file and YouTrack issue mentions with styled components.
 * Attachments (paths containing polycode-attachments) get special treatment.
 */
export function parseFileMentions(
  text: string,
  variant: 'message-user' | 'message-assistant' = 'message-assistant'
): ReactNode[] {
  // Collect all mention positions (YouTrack and file) sorted by index
  const mentions: Array<{ index: number; length: number; node: ReactNode }> = []

  // Find YouTrack issue mentions
  YOUTRACK_MENTION_REGEX.lastIndex = 0
  let ytMatch: RegExpExecArray | null
  while ((ytMatch = YOUTRACK_MENTION_REGEX.exec(text)) !== null) {
    const issueId = ytMatch[1]
    mentions.push({
      index: ytMatch.index,
      length: ytMatch[0].length,
      node: <YouTrackMention key={`yt-${ytMatch.index}`} issueId={issueId} variant={variant} />,
    })
  }

  // Find file/folder/attachment mentions
  FILE_MENTION_REGEX.lastIndex = 0
  let fileMatch: RegExpExecArray | null
  while ((fileMatch = FILE_MENTION_REGEX.exec(text)) !== null) {
    const driveLetter = fileMatch[1] ?? ''
    const restOfPath = fileMatch[2]
    const filePath = driveLetter + restOfPath

    let node: ReactNode
    if (isAttachmentPath(filePath)) {
      node = <AttachmentMention key={`att-${fileMatch.index}`} path={filePath} variant={variant} />
    } else if (filePath.endsWith('/')) {
      node = <FolderMention key={`dir-${fileMatch.index}`} path={filePath} variant={variant} />
    } else {
      node = <FileMention key={`file-${fileMatch.index}`} path={filePath} variant={variant} />
    }

    mentions.push({ index: fileMatch.index, length: fileMatch[0].length, node })
  }

  // Sort by position in text
  mentions.sort((a, b) => a.index - b.index)

  // Build result, skipping overlapping matches
  const parts: ReactNode[] = []
  let lastIndex = 0

  for (const mention of mentions) {
    if (mention.index < lastIndex) continue // skip overlap

    const textBefore = text.slice(lastIndex, mention.index)
    if (textBefore.trim()) {
      parts.push(textBefore)
    } else if (textBefore.includes('\n') && parts.length > 0) {
      parts.push(textBefore)
    }

    parts.push(mention.node)
    lastIndex = mention.index + mention.length
  }

  // Remaining text after last mention
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex)
    if (remaining.trim() || parts.length === 0) {
      parts.push(remaining)
    }
  }

  return parts.length > 0 ? parts : [text]
}
