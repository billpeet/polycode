import { Message } from '../types/ipc'
import { useState, useMemo, type CSSProperties } from 'react'
import EditDiffView from './EditDiffView'
import MarkdownContent from './MarkdownContent'
import { normalizeShellToolPresentation } from '../../../shared/shell-command'

interface Props {
  message: Message
  metadata: Record<string, unknown> | null
  result: Message | null
  resultMetadata: Record<string, unknown> | null
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g
function stripAnsi(s: string): string { return s.replace(ANSI_RE, '') }

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

function canonicalToolName(toolName: string, metadata?: Record<string, unknown> | null): string {
  const lower = toolName.toLowerCase()
  const kind = typeof metadata?.kind === 'string' ? metadata.kind.toLowerCase() : ''
  if (lower === 'grep' || kind === 'search') return 'Grep'
  if (lower === 'read file' || kind === 'read') return 'Read'
  if (lower === 'edit file' || kind === 'edit') return 'Edit'
  if (lower === 'bash') return 'Bash'
  if (lower === 'terminal' || kind === 'execute') return 'Bash'
  return toolName
}

function getResultSummary(resultMetadata: Record<string, unknown> | null): string | null {
  if (!resultMetadata) return null
  const content = resultMetadata.content
  if (Array.isArray(content)) {
    const diff = content.map((item) => item && typeof item === 'object' ? item as Record<string, unknown> : null)
      .find((item) => item?.type === 'diff' && typeof item.path === 'string')
    if (typeof diff?.path === 'string') {
      return diff.path.length > 120 ? '…' + diff.path.slice(-120) : diff.path
    }
  }
  const rawOutput = resultMetadata.rawOutput
  if (rawOutput && typeof rawOutput === 'object') {
    const out = rawOutput as Record<string, unknown>
    if (typeof out.totalMatches === 'number') return `${out.totalMatches} match${out.totalMatches === 1 ? '' : 'es'}${out.truncated ? ' (truncated)' : ''}`
    if (typeof out.exitCode === 'number') return `exit ${out.exitCode}`
  }
  return null
}

function getInputSummary(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const inp = input as Record<string, unknown>
  const normalizedToolName = toolName.toLowerCase()

  // Task/Agent (subagent): show the description
  if ((toolName === 'Task' || toolName === 'Agent') && typeof inp.description === 'string') {
    return inp.description
  }

  // Read: show file path + optional range annotation
  if ((toolName === 'Read' || toolName === 'Read File') && typeof inp.file_path === 'string') {
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

  // Edit/Write: just show the file path — content/diff is shown in the expanded body
  if ((normalizedToolName === 'edit' || normalizedToolName === 'edit file' || normalizedToolName === 'write') && (typeof inp.file_path === 'string' || typeof inp.path === 'string')) {
    const fp = (typeof inp.file_path === 'string' ? inp.file_path : inp.path) as string
    const suffix = normalizedToolName === 'edit' && Array.isArray(inp.edits) && inp.edits.length > 1
      ? ` (${inp.edits.length} blocks)`
      : ''
    const display = fp.length > 120 ? '…' + fp.slice(-120) : fp
    return display + suffix
  }

  // FileChange: show first file path (or count if multiple)
  if (toolName === 'FileChange' && Array.isArray(inp.changes) && inp.changes.length > 0) {
    const changes = inp.changes as Array<{ path: string; kind: string }>
    if (changes.length === 1) {
      const fp = changes[0].path
      return fp.length > 120 ? '…' + fp.slice(-120) : fp
    }
    return `${changes.length} files`
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

function getRawOutputText(rawOutput: unknown): string | null {
  if (!rawOutput || typeof rawOutput !== 'object') return null
  const out = rawOutput as Record<string, unknown>
  if (typeof out.stdout === 'string' || typeof out.stderr === 'string') {
    const parts: string[] = []
    if (typeof out.stdout === 'string' && out.stdout.trim()) parts.push(out.stdout.trimEnd())
    if (typeof out.stderr === 'string' && out.stderr.trim()) parts.push(out.stderr.trimEnd())
    if (typeof out.exitCode === 'number') parts.push(`exit code: ${out.exitCode}`)
    return parts.join('\n\n')
  }
  if (typeof out.totalMatches === 'number') {
    return `${out.totalMatches} match${out.totalMatches === 1 ? '' : 'es'}${out.truncated ? ' (truncated)' : ''}`
  }
  return prettyJson(rawOutput)
}

function hasMeaningfulInput(input: unknown): boolean {
  if (!input || typeof input !== 'object') return input !== undefined && input !== null && String(input).length > 0
  return Object.keys(input as Record<string, unknown>).length > 0
}

function extractDiffBlocks(resultMetadata: Record<string, unknown> | null): Array<{ path: string; oldText?: string; newText: string }> {
  const content = resultMetadata?.content
  if (!Array.isArray(content)) return []
  return content.flatMap((item) => {
    const rec = item && typeof item === 'object' ? item as Record<string, unknown> : null
    if (rec?.type !== 'diff' || typeof rec.path !== 'string') return []
    return [{
      path: rec.path,
      oldText: typeof rec.oldText === 'string' ? rec.oldText : undefined,
      newText: typeof rec.newText === 'string' ? rec.newText : '',
    }]
  })
}

function BodyContent({ text }: { text: string }) {
  const clean = useMemo(() => stripAnsi(text), [text])
  const parsed = useMemo(() => {
    const lines = clean.split('\n')
    const matches = lines.map((l) => CLAUDE_LINE_RE.exec(l))
    const matchCount = matches.filter(Boolean).length
    if (matchCount < 3 || matchCount < lines.filter((l) => l.trim()).length * 0.8) return null
    return matches.map((m, i) => m ? { num: m[1], code: m[2] } : { num: '', code: lines[i] })
  }, [clean])

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
        {clean}
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

function UnifiedDiffBody({ diff }: { diff: string }) {
  return (
    <pre style={{ margin: 0, maxHeight: 520, overflow: 'auto', fontFamily: 'var(--font-mono)', fontSize: '0.72rem', lineHeight: 1.55 }}>
      {diff.split('\n').map((line, index) => {
        const color = line.startsWith('+') && !line.startsWith('+++')
          ? '#4ade80'
          : line.startsWith('-') && !line.startsWith('---')
            ? '#f87171'
            : line.startsWith('@@')
              ? '#60a5fa'
              : 'var(--color-text-muted)'
        return <div key={index} style={{ color, whiteSpace: 'pre' }}>{line || ' '}</div>
      })}
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

  // Task/Agent (subagent): show prompt as readable text
  if ((toolName === 'Task' || toolName === 'Agent') && inp && typeof inp.prompt === 'string') {
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
          <div style={{ maxHeight: 400, overflowY: 'auto' }}>
            <MarkdownContent content={inp.prompt as string} />
          </div>
        </div>
      </div>
    )
  }

  const normalizedToolName = toolName.toLowerCase()
  const filePath = inp && (typeof inp.file_path === 'string' || typeof inp.path === 'string')
    ? (typeof inp.file_path === 'string' ? inp.file_path : inp.path) as string
    : undefined

  // Shell commands: show the command as shell content and scalar options as separate fields.
  if ((normalizedToolName === 'bash' || normalizedToolName === 'shell' || normalizedToolName === 'powershell') && inp && typeof inp.command === 'string') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
        <div>
          <div style={labelStyle}>Command</div>
          <BodyContent text={inp.command} />
        </div>
        {inp.timeout !== undefined && inp.timeout !== null && (
          <div>
            <div style={labelStyle}>Timeout</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>
              {String(inp.timeout)}
            </div>
          </div>
        )}
        {typeof inp.cwd === 'string' && inp.cwd && (
          <div>
            <div style={labelStyle}>Working directory</div>
            <div style={filePathStyle}>{inp.cwd}</div>
          </div>
        )}
        {Array.isArray(inp.commandActions) && inp.commandActions.length > 0 && (
          <div>
            <div style={labelStyle}>Parsed actions</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
              {(inp.commandActions as Array<Record<string, unknown>>).map((action, index) => (
                <div key={index} style={{ fontFamily: 'var(--font-mono)', fontSize: '0.68rem', color: 'var(--color-text-muted)' }}>
                  {String(action.type ?? 'unknown')}: {String(action.path ?? action.query ?? action.command ?? '')}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  // Edit: show inline diff view. Claude uses file_path/old_string/new_string;
  // Pi uses path plus edits[] with oldText/newText blocks.
  if ((normalizedToolName === 'edit' || normalizedToolName === 'edit file') && inp && filePath) {
    const edits = Array.isArray(inp.edits)
      ? inp.edits.filter((edit): edit is Record<string, unknown> => Boolean(edit) && typeof edit === 'object')
      : []

    if (edits.length > 0) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
          {edits.map((edit, i) => (
            <div key={i}>
              {edits.length > 1 && (
                <div style={{ ...labelStyle, marginBottom: '0.3rem' }}>Edit {i + 1} of {edits.length}</div>
              )}
              <EditDiffView
                toolName="Edit"
                filePath={filePath}
                oldString={typeof edit.oldText === 'string' ? edit.oldText : typeof edit.old_string === 'string' ? edit.old_string : undefined}
                newString={typeof edit.newText === 'string' ? edit.newText : typeof edit.new_string === 'string' ? edit.new_string : ''}
              />
            </div>
          ))}
        </div>
      )
    }

    return (
      <EditDiffView
        toolName="Edit"
        filePath={filePath}
        oldString={typeof inp.old_string === 'string' ? inp.old_string : typeof inp.oldText === 'string' ? inp.oldText : undefined}
        newString={typeof inp.new_string === 'string' ? inp.new_string : typeof inp.newText === 'string' ? inp.newText : ''}
      />
    )
  }

  // Write: show inline diff view (full file as added)
  if (normalizedToolName === 'write' && inp && filePath) {
    return (
      <EditDiffView
        toolName="Write"
        filePath={filePath}
        newString={typeof inp.content === 'string' ? inp.content : ''}
      />
    )
  }

  // Read: show file path + range if partial
  if ((toolName === 'Read' || toolName === 'Read File') && inp && typeof inp.file_path === 'string') {
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

  // FileChange: list each file with its change kind (update / create / delete)
  if (toolName === 'FileChange' && inp && Array.isArray(inp.changes)) {
    const changes = inp.changes as Array<{ path: string; kind: string }>
    const kindColor = (kind: string): string => {
      if (kind === 'create') return '#4ade80'
      if (kind === 'delete') return '#f87171'
      return 'var(--color-text-muted)'  // update / rename / etc.
    }
    const kindLabel = (kind: string): string => {
      if (kind === 'create') return 'created'
      if (kind === 'delete') return 'deleted'
      return 'updated'
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        {changes.map((c, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.6rem', fontWeight: 600, color: kindColor(c.kind), flexShrink: 0, minWidth: '4.5ch' }}>
              {kindLabel(c.kind)}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--color-text-muted)', wordBreak: 'break-all' }}>
              {c.path}
            </span>
          </div>
        ))}
      </div>
    )
  }

  // Default: dump the input as formatted JSON
  return <BodyContent text={prettyJson(input ?? {})} />
}

export default function ToolCallBlock({ message, metadata, result, resultMetadata }: Props) {
  const [expanded, setExpanded] = useState(false)

  const rawToolName = (metadata?.name as string) ?? message.content
  const input = metadata?.input as Record<string, unknown> | undefined
  // Normalize again at presentation time. Stored tool calls and events created
  // by an already-running main process may still carry the legacy `Shell` name.
  const shellCommand = normalizeShellToolPresentation(rawToolName, input?.command)
  const toolName = shellCommand
    ? shellCommand.name
    : canonicalToolName(rawToolName, metadata)
  const presentedInput = shellCommand
    ? { ...input, command: shellCommand.innerCmd }
    : input
  // For Task/Agent tool calls with a subagent_type, display the subagent type as the name
  const displayName =
    (toolName === 'Task' || toolName === 'Agent') && typeof input?.subagent_type === 'string'
      ? input.subagent_type
      : toolName
  const inputSummary = getInputSummary(toolName, presentedInput) ?? getResultSummary(resultMetadata)
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

  const diffBlocks = extractDiffBlocks(resultMetadata)
  const rawOutputText = getRawOutputText(resultMetadata?.rawOutput)
  const showInput = hasMeaningfulInput(metadata?.input)
  const resultBody = result
    ? diffBlocks.length > 0
      ? null
      : rawOutputText ?? (typeof resultMetadata?.content === 'string'
        ? resultMetadata.content
        : result.content.trim().length > 0
          ? result.content
          : 'Completed')
    : null
  const detailEntries = [
    ['cwd', metadata?.cwd ?? input?.cwd],
    ['process', metadata?.process_id ?? input?.processId],
    ['source', metadata?.source ?? input?.source],
    ['duration', typeof resultMetadata?.duration_ms === 'number' ? `${resultMetadata.duration_ms} ms` : typeof metadata?.duration_ms === 'number' ? `${metadata.duration_ms} ms` : null],
    ['exit', resultMetadata?.exit_code ?? metadata?.exit_code],
    ['connector', metadata?.connector_id],
    ['resource', metadata?.resource_uri],
    ['plugin', metadata?.plugin_id],
  ].filter((entry): entry is [string, string | number] => typeof entry[1] === 'string' || typeof entry[1] === 'number')
  const isUnifiedDiff = resultMetadata?.unified_diff === true

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
          {detailEntries.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
              {detailEntries.map(([label, value]) => (
                <span key={label} style={{ fontSize: '0.65rem', fontFamily: 'var(--font-mono)', color: 'var(--color-text-muted)', border: '1px solid var(--color-border)', borderRadius: 4, padding: '1px 5px' }}>
                  {label}: {String(value)}
                </span>
              ))}
            </div>
          )}
          {/* Input args */}
          {showInput && (
            <div>
              <div style={{ fontSize: '0.6rem', fontWeight: 600, letterSpacing: '0.06em', color: 'var(--color-text-muted)', marginBottom: '0.25rem', textTransform: 'uppercase' }}>
                Input
              </div>
              <InputBody toolName={toolName} input={presentedInput} />
            </div>
          )}

          {/* Result (once available) */}
          {diffBlocks.length > 0 && !isCancelled && (
            <div>
              <div style={{ fontSize: '0.6rem', fontWeight: 600, letterSpacing: '0.06em', color: isError ? '#f87171' : '#4ade80', marginBottom: '0.25rem', textTransform: 'uppercase' }}>
                {isError ? 'Error' : 'Changes'}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                {diffBlocks.map((diff, i) => (
                  <EditDiffView
                    key={`${diff.path}-${i}`}
                    toolName="Edit"
                    filePath={diff.path}
                    oldString={diff.oldText}
                    newString={diff.newText}
                  />
                ))}
              </div>
            </div>
          )}

          {resultBody !== null && diffBlocks.length === 0 && !isCancelled && (
            <div>
              <div style={{ fontSize: '0.6rem', fontWeight: 600, letterSpacing: '0.06em', color: isError ? '#f87171' : '#4ade80', marginBottom: '0.25rem', textTransform: 'uppercase' }}>
                {isError ? 'Error' : 'Output'}
              </div>
              {isUnifiedDiff ? <UnifiedDiffBody diff={resultBody} /> : <BodyContent text={resultBody} />}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
