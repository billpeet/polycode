import { PendingAttachment } from '../types/ipc'

interface Props {
  attachments: PendingAttachment[]
  onRemove: (id: string) => void
  disabled?: boolean
}

function PdfIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <path d="M9 15v-2h2a1 1 0 0 1 1 1v0a1 1 0 0 1-1 1H9z" />
      <path d="M15 13v4" />
      <path d="M15 13h1.5a1.5 1.5 0 0 1 0 3H15" />
    </svg>
  )
}

function FileIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export default function AttachmentPreview({ attachments, onRemove, disabled }: Props) {
  if (attachments.length === 0) return null

  return (
    <div
      className="flex flex-wrap gap-2 px-3 py-2"
      style={{ borderBottom: '1px solid var(--color-border)' }}
    >
      {attachments.map((att) => (
        <div
          key={att.id}
          className="group relative flex items-center gap-2 rounded-lg px-2 py-1.5"
          style={{
            background: 'var(--color-surface-2)',
            border: '1px solid var(--color-border)',
          }}
        >
          {/* Thumbnail or icon */}
          {att.type === 'image' && att.dataUrl ? (
            <img
              src={att.dataUrl}
              alt={att.name}
              className="h-8 w-8 rounded object-cover"
            />
          ) : att.type === 'pdf' ? (
            <div
              className="flex h-8 w-8 items-center justify-center rounded"
              style={{ background: 'rgba(239, 68, 68, 0.1)' }}
            >
              <PdfIcon className="h-5 w-5 text-red-400" />
            </div>
          ) : (
            <div
              className="flex h-8 w-8 items-center justify-center rounded"
              style={{ background: 'var(--color-surface)' }}
            >
              <FileIcon className="h-5 w-5" style={{ color: 'var(--color-text-muted)' }} />
            </div>
          )}

          {/* Filename and size */}
          <div className="flex flex-col">
            <span
              className="max-w-[120px] truncate text-xs font-medium"
              style={{ color: 'var(--color-text)' }}
            >
              {att.name}
            </span>
            <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
              {formatSize(att.size)}
            </span>
          </div>

          {/* Remove button */}
          {!disabled && (
            <button
              onClick={() => onRemove(att.id)}
              className="ml-1 flex h-5 w-5 items-center justify-center rounded-full transition-all hover:bg-red-500/20"
              style={{ color: 'var(--color-text-muted)' }}
              title="Remove attachment"
            >
              <CloseIcon />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
