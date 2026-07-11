import { useState } from 'react'
import { Message } from '../types/ipc'
import MarkdownContent from './MarkdownContent'

interface Props {
  message: Message
}

const TRUNCATE_LENGTH = 200

function renderInlineBold(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index} style={{ fontWeight: 600, color: 'var(--color-text)' }}>{part.slice(2, -2)}</strong>
    }
    return part
  })
}

export default function ThinkingBlock({ message }: Props) {
  const [expanded, setExpanded] = useState(false)

  const text = message.content
  const collapsedText = text.replace(/\s+/g, ' ').trim()
  const isTruncated = collapsedText.length > TRUNCATE_LENGTH
  const preview = isTruncated ? collapsedText.slice(0, TRUNCATE_LENGTH).trimEnd() + '…' : collapsedText

  const accentColor = 'rgba(139, 92, 246, 0.5)'
  const tintColor = 'rgba(139, 92, 246, 0.04)'

  return (
    <div
      className="w-full min-w-0 overflow-hidden"
      style={{ borderLeft: `2px solid ${accentColor}`, background: tintColor, borderRadius: '0 4px 4px 0' }}
    >
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
            <span style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.75, minWidth: 0 }}>
              {renderInlineBold(preview)}
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
        <div style={{ padding: '0 0.75rem 0.75rem', opacity: 0.85, minWidth: 0, overflow: 'hidden' }}>
          <MarkdownContent content={text} className="thinking-markdown" />
        </div>
      )}
    </div>
  )
}
