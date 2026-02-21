import { useMemo, type CSSProperties } from 'react'

interface DiffLine {
  type: 'context' | 'removed' | 'added'
  text: string
  lineNo: number | null
}

interface Props {
  /** For Edit: old_string to replace */
  oldString?: string
  /** For Edit: new_string replacement; for Write: full file content */
  newString: string
  /** File path shown in the header */
  filePath?: string
  /** Tool name — 'Edit' or 'Write' */
  toolName: 'Edit' | 'Write'
}

/** Split a string into lines, dropping a trailing empty element if the string ends with \n. */
function splitLines(s: string): string[] {
  const lines = s.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Build a unified-style diff for an Edit tool call.
 * Shows the leading shared prefix as context, then all removed lines (old),
 * then all added lines (new). No surrounding file context is available so we
 * keep it simple: full old_string → full new_string.
 */
function buildEditDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const result: DiffLine[] = []

  // Leading shared prefix shown as context (up to 3 lines)
  const MAX_CTX = 3
  let ctx = 0
  while (
    ctx < MAX_CTX &&
    ctx < oldLines.length &&
    ctx < newLines.length &&
    oldLines[ctx] === newLines[ctx]
  ) {
    ctx++
  }

  for (let i = 0; i < ctx; i++) {
    result.push({ type: 'context', text: oldLines[i], lineNo: i + 1 })
  }
  for (let i = ctx; i < oldLines.length; i++) {
    result.push({ type: 'removed', text: oldLines[i], lineNo: i + 1 })
  }
  for (let i = ctx; i < newLines.length; i++) {
    result.push({ type: 'added', text: newLines[i], lineNo: null })
  }

  return result
}

/** Build a Write diff — every line is shown as "added". */
function buildWriteDiff(content: string): DiffLine[] {
  return splitLines(content).map((text, i) => ({
    type: 'added' as const,
    text,
    lineNo: i + 1,
  }))
}

/** Keep only the last 3 path segments for a compact display. */
function shortPath(filePath: string): string {
  const sep = filePath.includes('/') ? '/' : '\\'
  const parts = filePath.split(sep).filter(Boolean)
  return parts.slice(-3).join('/')
}

export default function EditDiffView({ oldString, newString, filePath, toolName }: Props) {
  const lines = useMemo<DiffLine[]>(() => {
    if (toolName === 'Write') return buildWriteDiff(newString)
    return buildEditDiff(
      oldString ? splitLines(oldString) : [],
      splitLines(newString),
    )
  }, [toolName, oldString, newString])

  const removedCount = lines.filter((l) => l.type === 'removed').length
  const addedCount = lines.filter((l) => l.type === 'added').length

  return (
    <div style={{
      borderRadius: 6,
      overflow: 'hidden',
      border: '1px solid var(--color-border)',
      fontFamily: 'var(--font-mono)',
      fontSize: '0.72rem',
      lineHeight: 1.6,
    }}>
      {/* Header bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '4px 10px',
        background: '#111',
        borderBottom: '1px solid var(--color-border)',
        gap: '0.75rem',
      }}>
        <span style={{
          color: 'var(--color-text-muted)',
          fontSize: '0.68rem',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
          flex: 1,
        }}>
          {filePath ? shortPath(filePath) : (toolName === 'Write' ? 'new file' : 'edit')}
        </span>
        <span style={{ display: 'flex', gap: '0.5rem', flexShrink: 0, fontSize: '0.65rem', fontWeight: 600 }}>
          {removedCount > 0 && <span style={{ color: '#f87171' }}>−{removedCount}</span>}
          {addedCount > 0 && <span style={{ color: '#4ade80' }}>+{addedCount}</span>}
        </span>
      </div>

      {/* Diff body */}
      <div style={{ background: 'var(--color-code-bg)', maxHeight: 480, overflowY: 'auto', display: 'block' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '2rem' }} />
            <col style={{ width: '3rem' }} />
            <col />
          </colgroup>
          <tbody>
            {lines.map((line, idx) => (
              <DiffLineRow key={idx} line={line} index={idx} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

interface RowProps {
  line: DiffLine
  index: number
}

function DiffLineRow({ line, index }: RowProps) {
  const isRemoved = line.type === 'removed'
  const isAdded = line.type === 'added'

  const rowBg = isRemoved
    ? 'rgba(248, 113, 113, 0.10)'
    : isAdded
      ? 'rgba(74, 222, 128, 0.08)'
      : 'transparent'

  const gutterBg = isRemoved
    ? 'rgba(248, 113, 113, 0.20)'
    : isAdded
      ? 'rgba(74, 222, 128, 0.15)'
      : 'transparent'

  const markerText = isRemoved ? '−' : isAdded ? '+' : ' '
  const markerColor = isRemoved ? '#f87171' : isAdded ? '#4ade80' : 'transparent'

  const textColor = isRemoved
    ? 'rgba(248, 113, 113, 0.85)'
    : isAdded
      ? 'rgba(200, 240, 210, 0.9)'
      : 'var(--color-text-muted)'

  const lineNumColor = isRemoved
    ? 'rgba(248, 113, 113, 0.4)'
    : isAdded
      ? 'rgba(74, 222, 128, 0.35)'
      : 'var(--color-border)'

  const trStyle: CSSProperties = {
    background: rowBg,
    ...(isAdded ? {
      animation: 'diff-line-in 0.15s ease both',
      animationDelay: `${Math.min(index * 8, 200)}ms`,
    } : {}),
  }

  const tdBase: CSSProperties = {
    padding: 0,
    verticalAlign: 'top',
    lineHeight: 1.6,
    whiteSpace: 'pre',
  }

  return (
    <tr style={trStyle}>
      <td style={{ ...tdBase, textAlign: 'center', background: gutterBg, color: markerColor, fontWeight: 700, fontSize: '0.75rem', userSelect: 'none' }}>
        {markerText}
      </td>
      <td style={{ ...tdBase, textAlign: 'right', paddingRight: '0.75rem', color: lineNumColor, userSelect: 'none', fontSize: '0.65rem' }}>
        {line.lineNo ?? ''}
      </td>
      <td style={{ ...tdBase, color: textColor, paddingLeft: '0.5rem', paddingRight: '0.75rem', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {line.text || ' '}
      </td>
    </tr>
  )
}
