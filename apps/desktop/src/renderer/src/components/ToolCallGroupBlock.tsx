import { useState } from 'react'
import { MessageGroup } from './MessageStream'
import ToolCallBlock from './ToolCallBlock'

interface Props {
  group: MessageGroup
}

/** Returns a human-readable noun for a given tool name (singular / plural). */
function toolNoun(toolName: string, count: number): string {
  const nouns: Record<string, [string, string]> = {
    Read:          ['file',      'files'],
    Write:         ['file',      'files'],
    Edit:          ['file',      'files'],
    Bash:          ['command',   'commands'],
    Glob:          ['search',    'searches'],
    Grep:          ['search',    'searches'],
    WebFetch:      ['request',   'requests'],
    WebSearch:     ['search',    'searches'],
    Task:          ['task',      'tasks'],
    'file-access': ['operation', 'operations'],
    'web-access':  ['request',   'requests'],
  }
  const [singular, plural] = nouns[toolName] ?? ['call', 'calls']
  return `${count} ${count === 1 ? singular : plural}`
}

export default function ToolCallGroupBlock({ group }: Props) {
  const [expanded, setExpanded] = useState(false)

  const total = group.entries.length
  const done = group.entries.filter((e) => e.result !== null).length
  const hasCancelled = group.entries.some((e) => e.resultMetadata?.cancelled === true)
  const hasError = group.entries.some((e) => !e.resultMetadata?.cancelled && e.resultMetadata?.is_error === true)
  const isPending = done < total

  const accentColor = isPending
    ? 'var(--color-tool-call-accent)'
    : hasCancelled && !hasError
      ? 'color-mix(in srgb, var(--color-text-muted) 40%, transparent)'
      : hasError
        ? 'color-mix(in srgb, var(--color-danger) 60%, transparent)'
        : 'var(--color-tool-result-accent)'

  const tintColor = isPending
    ? 'var(--color-tool-call-tint)'
    : hasCancelled && !hasError
      ? 'color-mix(in srgb, var(--color-text-muted) 5%, transparent)'
      : hasError
        ? 'color-mix(in srgb, var(--color-danger) 5%, transparent)'
        : 'var(--color-tool-result-tint)'

  const iconColor = isPending ? 'var(--color-accent)' : hasCancelled && !hasError ? 'var(--color-text-muted)' : hasError ? 'var(--color-danger)' : 'var(--color-success)'
  const icon = isPending ? null : hasCancelled && !hasError ? '—' : hasError ? '✗' : '✓'
  const badge = isPending ? 'RUNNING' : hasCancelled && !hasError ? 'CANCELLED' : hasError ? 'FAILED' : 'DONE'

  return (
    <div style={{ borderLeft: `2px solid ${accentColor}`, background: tintColor, borderRadius: '0 4px 4px 0' }}>
      {/* Collapsed header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 text-left"
        style={{ height: 32, color: 'var(--color-text-muted)', cursor: 'pointer', background: 'transparent', border: 'none' }}
      >
        {isPending
          ? <span className="status-spinner" style={{ width: '0.75rem', height: '0.75rem', flexShrink: 0, borderTopColor: 'var(--color-accent)' }} />
          : <span style={{ fontSize: '0.8rem', flexShrink: 0, color: iconColor }}>{icon}</span>
        }

        <span style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem', minWidth: 0, flex: 1, overflow: 'hidden' }}>
          <span className="font-mono" style={{ color: iconColor, fontSize: '0.75rem', flexShrink: 0 }}>
            {group.toolName}
          </span>
          <span style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)', opacity: 0.75 }}>
            {toolNoun(group.toolName, total)}
          </span>
        </span>

        <span style={{
          fontSize: '0.6rem',
          fontWeight: 600,
          letterSpacing: '0.06em',
          padding: '1px 6px',
          borderRadius: 999,
          flexShrink: 0,
          background: isPending ? 'color-mix(in srgb, var(--color-accent) 15%, transparent)' : hasCancelled && !hasError ? 'color-mix(in srgb, var(--color-text-muted) 15%, transparent)' : hasError ? 'color-mix(in srgb, var(--color-danger) 15%, transparent)' : 'color-mix(in srgb, var(--color-success) 12%, transparent)',
          color: iconColor,
        }}>
          {badge}
        </span>

        <span style={{
          fontSize: '0.6rem',
          color: 'var(--color-text-muted)',
          marginLeft: 6,
          flexShrink: 0,
          transition: 'transform 0.18s ease',
          display: 'inline-block',
          transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
        }}>
          ▼
        </span>
      </button>

      {/* Expanded: individual tool call blocks, indented */}
      {expanded && (
        <div style={{ paddingLeft: '0.75rem', paddingBottom: '0.5rem', display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {group.entries.map((entry) => (
            <ToolCallBlock
              key={entry.key}
              message={entry.message}
              metadata={entry.metadata}
              result={entry.result}
              resultMetadata={entry.resultMetadata}
            />
          ))}
        </div>
      )}
    </div>
  )
}
