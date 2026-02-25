import { useState } from 'react'
import { Message } from '../types/ipc'
import MarkdownContent from './MarkdownContent'

interface Props {
  message: Message
}

const TRUNCATE_LENGTH = 200

export default function ThinkingBlock({ message }: Props) {
  const [expanded, setExpanded] = useState(false)

  const text = message.content
  const isTruncated = text.length > TRUNCATE_LENGTH
  const preview = isTruncated ? text.slice(0, TRUNCATE_LENGTH).trimEnd() + '…' : text

  const accentColor = 'rgba(139, 92, 246, 0.5)'
  const tintColor = 'rgba(139, 92, 246, 0.04)'

  return (
    <div style={{ borderLeft: `2px solid ${accentColor}`, background: tintColor, borderRadius: '0 4px 4px 0' }}>
      <button
        onClick={() => isTruncated && setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 text-left"
        style={{
          height: 32,
          color: 'var(--color-text-muted)',
          cursor: isTruncated ? 'pointer' : 'default',
          background: 'transparent',
          border: 'none',
        }}
      >
        {/* Icon */}
        <span style={{ fontSize: '0.72rem', flexShrink: 0, color: 'rgba(139, 92, 246, 0.8)' }}>
          ◌
        </span>

        {/* Label + truncated preview */}
        <span style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem', minWidth: 0, flex: 1, overflow: 'hidden' }}>
          <span style={{ fontSize: '0.65rem', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'rgba(139, 92, 246, 0.7)', flexShrink: 0 }}>
            Thinking
          </span>
          {!expanded && (
            <span style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)', opacity: 0.75 }}>
              {preview}
            </span>
          )}
        </span>

        {/* Chevron */}
        {isTruncated && (
          <span style={{ fontSize: '0.6rem', color: 'var(--color-text-muted)', marginLeft: 6, flexShrink: 0, transition: 'transform 0.18s ease', display: 'inline-block', transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}>
            ▼
          </span>
        )}
      </button>

      {expanded && (
        <div style={{ padding: '0 0.75rem 0.75rem', opacity: 0.85 }}>
          <MarkdownContent content={text} />
        </div>
      )}
    </div>
  )
}
