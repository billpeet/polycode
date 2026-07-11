/**
 * Tool-call block with per-tool formatting ported from the desktop
 * ToolCallBlock.tsx: canonical tool names, input summaries, Edit/Write diff
 * views, Bash command blocks, Read ranges, FileChange lists, result output
 * with stdout/stderr/exit-code extraction and result diff blocks.
 */
import { memo, useState, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { stripAnsi } from '@/lib/diff'
import { colors } from '@/theme/colors'
import { EditDiffView } from './EditDiffView'
import { Markdown } from './Markdown'

// ── Shared helpers (mirror desktop logic) ────────────────────────────────────

export function canonicalToolName(toolName: string, metadata?: Record<string, unknown> | null): string {
  const lower = toolName.toLowerCase()
  const kind = typeof metadata?.kind === 'string' ? metadata.kind.toLowerCase() : ''
  if (lower === 'grep' || kind === 'search') return 'Grep'
  if (lower === 'read file' || kind === 'read') return 'Read'
  if (lower === 'edit file' || kind === 'edit') return 'Edit'
  if (lower === 'bash') return 'Bash'
  if (lower === 'terminal' || kind === 'execute') return 'Bash'
  return toolName
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function getInputSummary(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const inp = input as Record<string, unknown>
  const normalized = toolName.toLowerCase()

  if ((toolName === 'Task' || toolName === 'Agent') && typeof inp.description === 'string') {
    return inp.description
  }

  if ((toolName === 'Read' || toolName === 'Read File') && typeof inp.file_path === 'string') {
    const fp = inp.file_path
    const offset = inp.offset != null ? Number(inp.offset) : null
    const limit = inp.limit != null ? Number(inp.limit) : null
    let suffix = ''
    if (offset != null && limit != null) suffix = ` +${offset} [${limit} lines]`
    else if (offset != null) suffix = ` +${offset}`
    else if (limit != null) suffix = ` [${limit} lines]`
    const display = fp.length > 100 ? '…' + fp.slice(-100) : fp
    return display + suffix
  }

  if (
    (normalized === 'edit' || normalized === 'edit file' || normalized === 'write') &&
    (typeof inp.file_path === 'string' || typeof inp.path === 'string')
  ) {
    const fp = (typeof inp.file_path === 'string' ? inp.file_path : inp.path) as string
    const suffix =
      normalized === 'edit' && Array.isArray(inp.edits) && inp.edits.length > 1 ? ` (${inp.edits.length} blocks)` : ''
    const display = fp.length > 120 ? '…' + fp.slice(-120) : fp
    return display + suffix
  }

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
    const val = inp[key]
    if (typeof val === 'string' && val) {
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

function getResultSummary(resultMetadata: Record<string, unknown> | null): string | null {
  if (!resultMetadata) return null
  const content = resultMetadata.content
  if (Array.isArray(content)) {
    const diff = content
      .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>) : null))
      .find((item) => item?.type === 'diff' && typeof item.path === 'string')
    if (typeof diff?.path === 'string') {
      return diff.path.length > 120 ? '…' + diff.path.slice(-120) : diff.path
    }
  }
  const rawOutput = resultMetadata.rawOutput
  if (rawOutput && typeof rawOutput === 'object') {
    const out = rawOutput as Record<string, unknown>
    if (typeof out.totalMatches === 'number')
      return `${out.totalMatches} match${out.totalMatches === 1 ? '' : 'es'}${out.truncated ? ' (truncated)' : ''}`
    if (typeof out.exitCode === 'number') return `exit ${out.exitCode}`
  }
  return null
}

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

function extractDiffBlocks(
  resultMetadata: Record<string, unknown> | null,
): Array<{ path: string; oldText?: string; newText: string }> {
  const content = resultMetadata?.content
  if (!Array.isArray(content)) return []
  return content.flatMap((item) => {
    const rec = item && typeof item === 'object' ? (item as Record<string, unknown>) : null
    if (rec?.type !== 'diff' || typeof rec.path !== 'string') return []
    return [
      {
        path: rec.path,
        oldText: typeof rec.oldText === 'string' ? rec.oldText : undefined,
        newText: typeof rec.newText === 'string' ? rec.newText : '',
      },
    ]
  })
}

// ── Status visuals ───────────────────────────────────────────────────────────

export type ToolStatus = 'pending' | 'cancelled' | 'error' | 'done'

export function deriveToolStatus(result: ToolResultData | null | undefined): ToolStatus {
  if (!result) return 'pending'
  if (result.metadata?.cancelled === true) return 'cancelled'
  if (result.metadata?.is_error === true) return 'error'
  return 'done'
}

export const STATUS_VISUALS: Record<
  ToolStatus,
  { glyph: string | null; color: string; badge: string; badgeBg: string; accent: string; tint: string }
> = {
  pending: {
    glyph: null,
    color: colors.claude,
    badge: 'RUNNING',
    badgeBg: 'rgba(232, 123, 95, 0.15)',
    accent: 'rgba(232, 123, 95, 0.5)',
    tint: 'rgba(232, 123, 95, 0.06)',
  },
  cancelled: {
    glyph: '—',
    color: '#6b7280',
    badge: 'CANCELLED',
    badgeBg: 'rgba(107, 114, 128, 0.15)',
    accent: 'rgba(107, 114, 128, 0.4)',
    tint: 'rgba(107, 114, 128, 0.05)',
  },
  error: {
    glyph: '✗',
    color: '#f87171',
    badge: 'FAILED',
    badgeBg: 'rgba(248, 113, 113, 0.15)',
    accent: 'rgba(248, 113, 113, 0.6)',
    tint: 'rgba(248, 113, 113, 0.05)',
  },
  done: {
    glyph: '✓',
    color: '#4ade80',
    badge: 'DONE',
    badgeBg: 'rgba(74, 222, 128, 0.12)',
    accent: 'rgba(74, 222, 128, 0.45)',
    tint: 'rgba(74, 222, 128, 0.05)',
  },
}

// ── Body pieces ──────────────────────────────────────────────────────────────

const CLAUDE_LINE_RE = /^ *(\d+)→(.*)$/
const MAX_BODY_LINES = 300
/** Desktop caps expanded bodies at ~400px with inner scroll — same here. */
export const BLOCK_BODY_MAX_HEIGHT = 400

/** Plain output body: ANSI-stripped, Claude numbered-line gutter when detected. */
function BodyContent({ text }: { text: string }) {
  const clean = stripAnsi(text)
  const lines = clean.split('\n')
  const shown = lines.slice(0, MAX_BODY_LINES)
  const hidden = lines.length - shown.length

  const matches = shown.map((l) => CLAUDE_LINE_RE.exec(l))
  const matchCount = matches.filter(Boolean).length
  const useGutter = matchCount >= 3 && matchCount >= shown.filter((l) => l.trim()).length * 0.8

  return (
    <View>
      {useGutter ? (
        shown.map((line, i) => {
          const m = matches[i]
          return (
            <View key={i} style={{ flexDirection: 'row' }}>
              <Text style={bodyStyles.gutter}>{m ? m[1] : ''}</Text>
              <Text style={bodyStyles.code} numberOfLines={1}>
                {m ? m[2] : line}
              </Text>
            </View>
          )
        })
      ) : (
        <Text style={bodyStyles.pre} selectable>
          {shown.join('\n')}
        </Text>
      )}
      {hidden > 0 ? <Text style={bodyStyles.more}>… {hidden} more lines</Text> : null}
    </View>
  )
}

function FieldLabel({ children }: { children: string }) {
  return <Text style={bodyStyles.label}>{children}</Text>
}

function MonoValue({ children }: { children: string }) {
  return (
    <Text style={bodyStyles.mono} selectable>
      {children}
    </Text>
  )
}

/** Tool-specific expanded input body (ported from desktop InputBody). */
function InputBody({ toolName, input }: { toolName: string; input: unknown }) {
  const inp = input && typeof input === 'object' ? (input as Record<string, unknown>) : null
  const normalized = toolName.toLowerCase()
  const filePath =
    inp && (typeof inp.file_path === 'string' || typeof inp.path === 'string')
      ? ((typeof inp.file_path === 'string' ? inp.file_path : inp.path) as string)
      : undefined

  // Task/Agent: subagent + prompt as markdown
  if ((toolName === 'Task' || toolName === 'Agent') && inp && typeof inp.prompt === 'string') {
    return (
      <View style={{ gap: 8 }}>
        {typeof inp.subagent_type === 'string' ? (
          <View>
            <FieldLabel>Subagent</FieldLabel>
            <MonoValue>{inp.subagent_type}</MonoValue>
          </View>
        ) : null}
        <View>
          <FieldLabel>Prompt</FieldLabel>
          <Markdown>{inp.prompt}</Markdown>
        </View>
      </View>
    )
  }

  // Shell commands
  if ((normalized === 'bash' || normalized === 'shell') && inp && typeof inp.command === 'string') {
    return (
      <View style={{ gap: 8 }}>
        <View>
          <FieldLabel>Command</FieldLabel>
          <BodyContent text={inp.command} />
        </View>
        {inp.timeout !== undefined && inp.timeout !== null ? (
          <View>
            <FieldLabel>Timeout</FieldLabel>
            <MonoValue>{String(inp.timeout)}</MonoValue>
          </View>
        ) : null}
      </View>
    )
  }

  // Edit: inline diff (Claude old_string/new_string, Pi edits[] oldText/newText)
  if ((normalized === 'edit' || normalized === 'edit file') && inp && filePath) {
    const edits = Array.isArray(inp.edits)
      ? inp.edits.filter((edit): edit is Record<string, unknown> => Boolean(edit) && typeof edit === 'object')
      : []

    if (edits.length > 0) {
      return (
        <View style={{ gap: 10 }}>
          {edits.map((edit, i) => (
            <View key={i} style={{ gap: 4 }}>
              {edits.length > 1 ? <FieldLabel>{`Edit ${i + 1} of ${edits.length}`}</FieldLabel> : null}
              <EditDiffView
                toolName="Edit"
                filePath={filePath}
                oldString={
                  typeof edit.oldText === 'string'
                    ? edit.oldText
                    : typeof edit.old_string === 'string'
                      ? edit.old_string
                      : undefined
                }
                newString={
                  typeof edit.newText === 'string' ? edit.newText : typeof edit.new_string === 'string' ? edit.new_string : ''
                }
              />
            </View>
          ))}
        </View>
      )
    }

    return (
      <EditDiffView
        toolName="Edit"
        filePath={filePath}
        oldString={
          typeof inp.old_string === 'string' ? inp.old_string : typeof inp.oldText === 'string' ? inp.oldText : undefined
        }
        newString={
          typeof inp.new_string === 'string' ? inp.new_string : typeof inp.newText === 'string' ? inp.newText : ''
        }
      />
    )
  }

  // Write: whole file as added
  if (normalized === 'write' && inp && filePath) {
    return <EditDiffView toolName="Write" filePath={filePath} newString={typeof inp.content === 'string' ? inp.content : ''} />
  }

  // Read: file + range
  if ((toolName === 'Read' || toolName === 'Read File') && inp && typeof inp.file_path === 'string') {
    const offset = inp.offset != null ? Number(inp.offset) : null
    const limit = inp.limit != null ? Number(inp.limit) : null
    return (
      <View style={{ gap: 8 }}>
        <View>
          <FieldLabel>File</FieldLabel>
          <MonoValue>{inp.file_path}</MonoValue>
        </View>
        {offset != null || limit != null ? (
          <View>
            <FieldLabel>Range</FieldLabel>
            <MonoValue>
              {offset != null && limit != null
                ? `lines ${offset + 1}–${offset + limit} (offset ${offset}, limit ${limit})`
                : offset != null
                  ? `from line ${offset + 1} (offset ${offset})`
                  : `first ${limit} lines`}
            </MonoValue>
          </View>
        ) : null}
      </View>
    )
  }

  // FileChange: change list with kind coloring
  if (toolName === 'FileChange' && inp && Array.isArray(inp.changes)) {
    const changes = inp.changes as Array<{ path: string; kind: string }>
    const kindColor = (kind: string) => (kind === 'create' ? '#4ade80' : kind === 'delete' ? '#f87171' : colors.textMuted)
    const kindLabel = (kind: string) => (kind === 'create' ? 'created' : kind === 'delete' ? 'deleted' : 'updated')
    return (
      <View style={{ gap: 4 }}>
        {changes.map((change, i) => (
          <View key={i} style={{ flexDirection: 'row', gap: 8, alignItems: 'baseline' }}>
            <Text style={{ fontSize: 10, fontWeight: '600', color: kindColor(change.kind), minWidth: 44 }}>
              {kindLabel(change.kind)}
            </Text>
            <Text style={[bodyStyles.mono, { flex: 1 }]}>{change.path}</Text>
          </View>
        ))}
      </View>
    )
  }

  // Default: pretty JSON
  return <BodyContent text={prettyJson(input ?? {})} />
}

// ── The block ────────────────────────────────────────────────────────────────

export interface ToolResultData {
  content: string
  metadata: Record<string, unknown> | null
}

export interface ToolCallProps {
  /** Message content — fallback tool name. */
  content: string
  /** tool_call metadata (name, input, kind, subagent_type…). */
  metadata: Record<string, unknown>
  /** Paired tool_result; null/undefined = still running. */
  result?: ToolResultData | null
  subagent?: boolean
}

function hasMeaningfulInput(input: unknown): boolean {
  if (!input || typeof input !== 'object') return input !== undefined && input !== null && String(input).length > 0
  return Object.keys(input as Record<string, unknown>).length > 0
}

function Section({ label, color, children }: { label: string; color: string; children: ReactNode }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={[bodyStyles.label, { color }]}>{label}</Text>
      {children}
    </View>
  )
}

export const ToolCallBlock = memo(function ToolCallBlock(props: ToolCallProps) {
  const [expanded, setExpanded] = useState(false)
  const { metadata, result } = props

  const rawToolName = typeof metadata.name === 'string' ? metadata.name : props.content || 'tool'
  const toolName = canonicalToolName(rawToolName, metadata)
  const input = metadata.input as Record<string, unknown> | undefined
  const displayName =
    (toolName === 'Task' || toolName === 'Agent') && typeof metadata.subagent_type === 'string'
      ? metadata.subagent_type
      : toolName

  const status = deriveToolStatus(result)
  const visuals = STATUS_VISUALS[status]
  const summary = getInputSummary(toolName, input) ?? getResultSummary(result?.metadata ?? null)

  const resultDiffs = status !== 'cancelled' ? extractDiffBlocks(result?.metadata ?? null) : []
  const resultText =
    status !== 'cancelled' && result
      ? (getRawOutputText(result.metadata?.rawOutput) ?? (result.content?.trim() ? result.content : 'Completed'))
      : null

  return (
    <View style={[blockStyles.block, { borderLeftColor: visuals.accent, backgroundColor: visuals.tint }, props.subagent && blockStyles.subagent]}>
      <Pressable onPress={() => setExpanded((v) => !v)} style={blockStyles.header}>
        {visuals.glyph === null ? (
          <ActivityIndicator size={10} color={visuals.color} />
        ) : (
          <Text style={[blockStyles.glyph, { color: visuals.color }]}>{visuals.glyph}</Text>
        )}
        <Text style={[blockStyles.name, { color: visuals.color }]} numberOfLines={1}>
          {displayName}
        </Text>
        {summary ? (
          <Text style={blockStyles.summary} numberOfLines={1}>
            {summary}
          </Text>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        <View style={[blockStyles.badge, { backgroundColor: visuals.badgeBg }]}>
          <Text style={[blockStyles.badgeText, { color: visuals.color }]}>{visuals.badge}</Text>
        </View>
        <Text style={[blockStyles.chevron, expanded && { transform: [{ rotate: '180deg' }] }]}>▼</Text>
      </Pressable>

      {expanded ? (
        <ScrollView
          style={{ maxHeight: BLOCK_BODY_MAX_HEIGHT }}
          nestedScrollEnabled
          contentContainerStyle={blockStyles.body}
        >
          {hasMeaningfulInput(input) ? <InputBody toolName={toolName} input={input} /> : null}

          {resultDiffs.length > 0 ? (
            <Section label={status === 'error' ? 'Error' : 'Changes'} color={status === 'error' ? '#f87171' : '#4ade80'}>
              <View style={{ gap: 8 }}>
                {resultDiffs.map((diff, i) => (
                  <EditDiffView key={i} toolName="Edit" filePath={diff.path} oldString={diff.oldText} newString={diff.newText} />
                ))}
              </View>
            </Section>
          ) : null}

          {resultDiffs.length === 0 && resultText ? (
            <Section label={status === 'error' ? 'Error' : 'Output'} color={status === 'error' ? '#f87171' : colors.textMuted}>
              <BodyContent text={resultText} />
            </Section>
          ) : null}

          {status === 'pending' ? <Text style={blockStyles.pending}>Running…</Text> : null}
        </ScrollView>
      ) : null}
    </View>
  )
})

const blockStyles = StyleSheet.create({
  block: {
    borderLeftWidth: 2,
    borderTopRightRadius: 4,
    borderBottomRightRadius: 4,
  },
  subagent: { marginLeft: 16, opacity: 0.92 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 9,
    minHeight: 32,
  },
  glyph: { fontSize: 11, width: 12, textAlign: 'center' },
  name: { fontFamily: 'monospace', fontSize: 12, fontWeight: '600', flexShrink: 0, maxWidth: '40%' },
  summary: { flex: 1, color: colors.textMuted, fontSize: 11.5, fontFamily: 'monospace', opacity: 0.75 },
  badge: { borderRadius: 999, paddingHorizontal: 6, paddingVertical: 2 },
  badgeText: { fontSize: 8.5, fontWeight: '700', letterSpacing: 0.4 },
  chevron: { color: colors.textMuted, fontSize: 9 },
  body: { paddingHorizontal: 10, paddingBottom: 9, gap: 10 },
  pending: { color: colors.textMuted, fontSize: 12, fontStyle: 'italic' },
})

const bodyStyles = StyleSheet.create({
  label: {
    fontSize: 9.5,
    fontWeight: '600',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: colors.textMuted,
    marginBottom: 2,
  },
  mono: { fontFamily: 'monospace', fontSize: 11.5, color: colors.textMuted },
  pre: { fontFamily: 'monospace', fontSize: 11.5, color: colors.textMuted, lineHeight: 17 },
  code: { fontFamily: 'monospace', fontSize: 11.5, color: colors.textMuted, flex: 1 },
  gutter: {
    fontFamily: 'monospace',
    fontSize: 11.5,
    color: colors.border,
    minWidth: 30,
    textAlign: 'right',
    marginRight: 8,
  },
  more: { color: colors.textMuted, fontSize: 11, fontStyle: 'italic', marginTop: 3 },
})
