import { useState } from 'react'
import type { AgentGroup } from './MessageStream'
import { agentStatsLabel } from './MessageStream'
import { renderEntry } from './renderEntry'
import AgentPrompt from './AgentPrompt'

interface Props {
  group: AgentGroup
  /** Isolate the transcript view to this agent group. */
  onIsolate?: (agentKey: string) => void
}

function statusVisuals(status: AgentGroup['status']) {
  switch (status) {
    case 'completed':
      return { icon: '✓', color: '#4ade80', badge: 'DONE', tint: 'var(--color-tool-result-tint)', accent: 'var(--color-tool-result-accent)', badgeBg: 'rgba(74, 222, 128, 0.12)' }
    case 'failed':
      return { icon: '✗', color: '#f87171', badge: 'FAILED', tint: 'rgba(248, 113, 113, 0.05)', accent: 'rgba(248, 113, 113, 0.6)', badgeBg: 'rgba(248, 113, 113, 0.15)' }
    case 'stopped':
      return { icon: '—', color: '#6b7280', badge: 'STOPPED', tint: 'rgba(107, 114, 128, 0.05)', accent: 'rgba(107, 114, 128, 0.4)', badgeBg: 'rgba(107, 114, 128, 0.15)' }
    default:
      return { icon: null, color: 'var(--color-claude)', badge: 'RUNNING', tint: 'var(--color-tool-call-tint)', accent: 'var(--color-tool-call-accent)', badgeBg: 'rgba(232, 123, 95, 0.15)' }
  }
}

export default function AgentGroupBlock({ group, onIsolate }: Props) {
  const [expanded, setExpanded] = useState(false)

  const v = statusVisuals(group.status)
  const isRunning = group.status === 'running'
  const count = group.entries.length
  const stats = agentStatsLabel(group)

  return (
    <div style={{ borderLeft: `2px solid ${v.accent}`, background: v.tint, borderRadius: '0 4px 4px 0' }}>
      {/* Collapsed header */}
      <button
        onClick={() => setExpanded((x) => !x)}
        className="flex w-full items-center gap-2 px-3 text-left"
        style={{ height: 32, color: 'var(--color-text-muted)', cursor: 'pointer', background: 'transparent', border: 'none' }}
      >
        {isRunning
          ? <span className="status-spinner" style={{ width: '0.75rem', height: '0.75rem', flexShrink: 0, borderTopColor: 'var(--color-claude)' }} />
          : <span style={{ fontSize: '0.8rem', flexShrink: 0, color: v.color }}>{v.icon}</span>
        }

        <span style={{ fontSize: '0.7rem', flexShrink: 0, opacity: 0.7 }}>🤖</span>

        <span style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem', minWidth: 0, flex: 1, overflow: 'hidden' }}>
          <span className="font-mono" style={{ color: v.color, fontSize: '0.75rem', flexShrink: 0, whiteSpace: 'nowrap' }}>
            {group.label}
          </span>
          {group.description && (
            <span style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {group.description}
            </span>
          )}
          <span style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)', opacity: 0.75, flexShrink: 0, marginLeft: 'auto', whiteSpace: 'nowrap' }}>
            {count} {count === 1 ? 'entry' : 'entries'}{stats ? ` · ${stats}` : ''}
          </span>
        </span>

        {onIsolate && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onIsolate(group.key) }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onIsolate(group.key) } }}
            className="hover:opacity-100"
            style={{ fontSize: '0.6rem', fontWeight: 600, letterSpacing: '0.04em', padding: '1px 6px', borderRadius: 999, flexShrink: 0, opacity: 0.6, color: 'var(--color-text-muted)', border: '1px solid var(--color-border)', cursor: 'pointer' }}
          >
            ISOLATE
          </span>
        )}

        <span style={{
          fontSize: '0.6rem',
          fontWeight: 600,
          letterSpacing: '0.06em',
          padding: '1px 6px',
          borderRadius: 999,
          flexShrink: 0,
          background: v.badgeBg,
          color: v.color,
        }}>
          {v.badge}
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

      {/* Expanded: the full prompt sent to the sub-agent, then its nested transcript */}
      {expanded && (
        <div style={{ paddingLeft: '0.75rem', paddingBottom: '0.5rem', display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {group.prompt && <AgentPrompt prompt={group.prompt} />}
          {group.entries.map((entry) => (
            <div key={entry.key}>
              {renderEntry(entry, { onIsolateAgent: onIsolate })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
