import { Message } from '../types/ipc'
import { useState } from 'react'

interface Props {
  message: Message
  metadata: Record<string, unknown> | null
}

export default function ToolCallBlock({ message, metadata }: Props) {
  const [expanded, setExpanded] = useState(false)
  const type = (metadata?.type as string) ?? 'tool'
  const toolName = (metadata?.name as string) ?? message.content

  return (
    <div
      className="rounded border text-xs"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <span>{type === 'tool_call' ? '⚡' : '✓'}</span>
        <span className="font-mono" style={{ color: 'var(--color-claude)' }}>
          {toolName}
        </span>
        <span className="ml-auto">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <pre
          className="overflow-x-auto px-3 pb-3 text-xs"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {message.content}
        </pre>
      )}
    </div>
  )
}
