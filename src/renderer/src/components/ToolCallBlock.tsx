import { Message } from '../types/ipc'
import { useState, useMemo, type CSSProperties } from 'react'
import EditDiffView from './EditDiffView'

interface Props {
  message: Message
  metadata: Record<string, unknown> | null
  result: Message | null
  resultMetadata: Record<string, unknown> | null
}

function prettyJson(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(value, null, 2)
  }
  return String(value ?? '')
}

function getInputSummary(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const inp = input as Record<string, unknown>

  // Task (subagent): show the description
  if (toolName === 'Task' && typeof inp.description === 'string') {
    return inp.description
  }

  // Read: show file path + optional range annotation
  if (toolName === 'Read' && typeof inp.file_path === 'string') {
    const fp = inp.file_path as string
    const offset = inp.offset != null ? Number(inp.offset) : null
    const limit = inp.limit != null ? Number(inp.limit) : null
    let suffix = ''
    if (offset != null && limit != null) suffix = ` +${offset} [${limit} lines]`
    else if (offset != null) suffix = ` +${offset}`
    else if (limit != null) suffix = ` [${limit} lines]`
    const display = fp.length > 100 ? '…' + fp.slice(-100) : fp
    return display + suffix
  }

  // Write: just show the file path — content is shown in the expanded body
  if (toolName === 'Write' && typeof inp.file_path === 'string') {
    const fp = inp.file_path as string
    return fp.length > 120 ? '…' + fp.slice(-120) : fp
  }

  const preferred = ['command', 'file_path', 'filePath', 'path', 'pattern', 'query', 'url']
  for (const key of preferred) {
    if (typeof inp[key] === 'string' && inp[key]) {
      const val = inp[key] as string
      const firstLine = val.split('\n')[0]
      return firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine
    }
  }
  for (const val of Object.values(inp)) {
    if (typeof val === 'string' && val) {
      const firstLine = val.split('\n')[0]
      return firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine
    }
  }
  return null
}

const CLAUDE_LINE_RE = /^ *(\d+)→(.*)$/

function BodyContent({ text }: { text: string }) {
  const parsed = useMemo(() => {
    const lines = text.split('\n')
    const matches = lines.map((l) => CLAUDE_LINE_RE.exec(l))
    const matchCount = matches.filter(Boolean).length
    if (matchCount < 3 || matchCount < lines.filter((l) => l.trim()).length * 0.8) return null
    return matches.map((m, i) => m ? { num: m[1], code: m[2] } : { num: '', code: lines[i] })
  }, [text])

  const preStyle: CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.72rem',
    margin: 0,
    maxHeight: 400,
    overflowY: 'auto',
    background: 'transparent',
    lineHeight: 1.6,
  }

  if (!parsed) {
    return (
      <pre style={{ ...preStyle, color: 'var(--color-text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {text}
      </pre>
    )
  }

  return (
    <pre style={{ ...preStyle, overflowX: 'auto', whiteSpace: 'pre' }}>
      {parsed.map((line, i) => (
        <div key={i} style={{ display: 'flex' }}>
          <span style={{ minWidth: '3ch', textAlign: 'right', marginRight: '1.25ch', color: 'var(--color-border)', userSelect: 'none', flexShrink: 0 }}>
            {line.num}
          </span>
          <span style={{ color: 'var(--color-text-muted)' }}>{line.code}</span>
        </div>
      ))}
    </pre>
  )
}

/** Renders the input section of a tool call with tool-specific formatting. */
function InputBody({ toolName, input }: { toolName: string; input: unknown }) {
  const inp = (input && typeof input === 'object') ? input as Record<string, unknown> : null

  const labelStyle: CSSProperties = {
    fontSize: '0.6rem',
    fontWeight: 600,
    letterSpacing: '0.05em',
    textTransform: 'uppercase' as const,
    color: 'var(--color-text-muted)',
    marginBottom: '0.2rem',
  }

  const filePathStyle: CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.72rem',
    color: 'var(--color-text-muted)',
    wordBreak: 'break-all',
  }

  // Task (subagent): show prompt as readable text
  if (toolName === 'Task' && inp && typeof inp.prompt === 'string') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        {typeof inp.subagent_type === 'string' && (
          <div>
            <div style={labelStyle}>Subagent</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>
              {inp.subagent_type}
            </div>
          </div>
        )}
        <div>
          <div style={labelStyle}>Prompt</div>
          <pre style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--color-text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, maxHeight: 400, overflowY: 'auto', background: 'transparent', lineHeight: 1.6 }}>
            {inp.prompt}
          </pre>
        </div>
      </div>
    )
  }

  // Edit: show inline diff view (old_string → new_string)
  if (toolName === 'Edit' && inp && typeof inp.file_path === 'string') {
    return (
      <EditDiffView
        toolName="Edit"
        filePath={inp.file_path as string}
        oldString={typeof inp.old_string === 'string' ? inp.old_string : undefined}
        newString={typeof inp.new_string === 'string' ? inp.new_string : ''}
      />
    )
  }

  // Write: show inline diff view (full file as added)
  if (toolName === 'Write' && inp && typeof inp.file_path === 'string') {
    return (
      <EditDiffView
        toolName="Write"
        filePath={inp.file_path as string}
        newString={typeof inp.content === 'string' ? inp.content : ''}
      />
    )
  }

  // Read: show file path + range if partial
  if (toolName === 'Read' && inp && typeof inp.file_path === 'string') {
    const offset = inp.offset != null ? Number(inp.offset) : null
    const limit = inp.limit != null ? Number(inp.limit) : null
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        <div>
          <div style={labelStyle}>File</div>
          <div style={filePathStyle}>{inp.file_path as string}</div>
        </div>
        {(offset != null || limit != null) && (
          <div>
            <div style={labelStyle}>Range</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>
              {offset != null && limit != null && `lines ${offset + 1}–${offset + limit} (offset ${offset}, limit ${limit})`}
              {offset != null && limit == null && `from line ${offset + 1} (offset ${offset})`}
              {offset == null && limit != null && `first ${limit} lines`}
            </div>
          </div>
        )}
      </div>
    )
  }

  // Default: dump the input as formatted JSON
  return <BodyContent text={prettyJson(input ?? {})} />
}

export default function ToolCallBlock({ message, metadata, result, resultMetadata }: Props) {
  const [expanded, setExpanded] = useState(false)

  const toolName = (metadata?.name as string) ?? message.content
  const input = metadata?.input as Record<string, unknown> | undefined
  // For Task tool calls with a subagent_type, display the subagent type as the name
  const displayName =
    toolName === 'Task' && typeof input?.subagent_type === 'string'
      ? input.subagent_type
      : toolName
  const inputSummary = getInputSummary(toolName, metadata?.input)
  const isCancelled = resultMetadata?.cancelled === true
  const isError = !isCancelled && resultMetadata?.is_error === true
  const isPending = result === null

  // Colour scheme: pending = orange, cancelled = gray, error = red, done = green
  const accentColor = isPending
    ? 'var(--color-tool-call-accent)'
    : isCancelled
      ? 'rgba(107, 114, 128, 0.4)'
      : isError
        ? 'rgba(248, 113, 113, 0.6)'
        : 'var(--color-tool-result-accent)'

  const tintColor = isPending
    ? 'var(--color-tool-call-tint)'
    : isCancelled
      ? 'rgba(107, 114, 128, 0.05)'
      : isError
        ? 'rgba(248, 113, 113, 0.05)'
        : 'var(--color-tool-result-tint)'

  // Status icon
  const icon = isPending ? null : isCancelled ? '—' : isError ? '✗' : '✓'
  const iconColor = isPending ? 'var(--color-claude)' : isCancelled ? '#6b7280' : isError ? '#f87171' : '#4ade80'

  const resultBody = result
    ? typeof resultMetadata?.content === 'string'
      ? resultMetadata.content
      : prettyJson(result.content)
    : null

  return (
    <div style={{ borderLeft: `2px solid ${accentColor}`, background: tintColor, borderRadius: '0 4px 4px 0' }}>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 text-left"
        style={{ height: 32, color: 'var(--color-text-muted)', cursor: 'pointer', background: 'transparent', border: 'none' }}
      >
        {/* Status icon */}
        {isPending
          ? <span className="status-spinner" style={{ width: '0.75rem', height: '0.75rem', flexShrink: 0, borderTopColor: 'var(--color-claude)' }} />
          : <span style={{ fontSize: '0.8rem', flexShrink: 0, color: iconColor }}>{icon}</span>
        }

        {/* Tool name + input summary */}
        <span style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem', minWidth: 0, flex: 1, overflow: 'hidden' }}>
          <span
            className="font-mono"
            style={{ color: iconColor, fontSize: '0.75rem', flexShrink: 0 }}
          >
            {displayName}
          </span>
          {inputSummary && (
            <span style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)', opacity: 0.75 }}>
              {inputSummary}
            </span>
          )}
        </span>

        {/* Status badge */}
        <span style={{
          fontSize: '0.6rem',
          fontWeight: 600,
          letterSpacing: '0.06em',
          padding: '1px 6px',
          borderRadius: 999,
          flexShrink: 0,
          background: isPending ? 'rgba(232, 123, 95, 0.15)' : isCancelled ? 'rgba(107, 114, 128, 0.15)' : isError ? 'rgba(248, 113, 113, 0.15)' : 'rgba(74, 222, 128, 0.12)',
          color: iconColor,
        }}>
          {isPending ? 'RUNNING' : isCancelled ? 'CANCELLED' : isError ? 'FAILED' : 'DONE'}
        </span>

        {/* Chevron */}
        <span style={{ fontSize: '0.6rem', color: 'var(--color-text-muted)', marginLeft: 6, flexShrink: 0, transition: 'transform 0.18s ease', display: 'inline-block', transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}>
          ▼
        </span>
      </button>

      {expanded && (
        <div style={{ padding: '0 0.75rem 0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {/* Input args */}
          <div>
            <div style={{ fontSize: '0.6rem', fontWeight: 600, letterSpacing: '0.06em', color: 'var(--color-text-muted)', marginBottom: '0.25rem', textTransform: 'uppercase' }}>
              Input
            </div>
            <InputBody toolName={toolName} input={metadata?.input} />
          </div>

          {/* Result (once available) */}
          {resultBody !== null && !isCancelled && (
            <div>
              <div style={{ fontSize: '0.6rem', fontWeight: 600, letterSpacing: '0.06em', color: isError ? '#f87171' : '#4ade80', marginBottom: '0.25rem', textTransform: 'uppercase' }}>
                {isError ? 'Error' : 'Output'}
              </div>
              <BodyContent text={resultBody} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
