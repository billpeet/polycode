import { memo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors } from '@/theme/colors'

/** Compact one-line summary of a tool call's input. */
function summarizeInput(input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  const preferredKeys = ['command', 'file_path', 'path', 'pattern', 'query', 'prompt', 'description', 'url']
  for (const key of preferredKeys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  try {
    const json = JSON.stringify(input)
    return json === '{}' ? '' : json
  } catch {
    return ''
  }
}

const RESULT_PREVIEW_LIMIT = 4000

export interface ToolCallData {
  name: string
  input?: Record<string, unknown>
  result?: {
    content: string
    isError: boolean
    cancelled: boolean
  }
}

export const ToolCallBlock = memo(function ToolCallBlock(props: { data: ToolCallData; subagent?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const { data } = props
  const summary = summarizeInput(data.input)
  const pending = !data.result
  const failed = data.result?.isError || data.result?.cancelled

  return (
    <Pressable onPress={() => setExpanded((v) => !v)}>
      <View style={[styles.block, props.subagent && styles.subagent]}>
        <View style={styles.header}>
          <Text style={[styles.dot, { color: failed ? colors.danger : pending ? colors.warning : colors.success }]}>
            ●
          </Text>
          <Text style={styles.name}>{data.name}</Text>
          {summary ? (
            <Text style={styles.summary} numberOfLines={1}>
              {summary}
            </Text>
          ) : null}
          <Text style={styles.chevron}>{expanded ? '▾' : '▸'}</Text>
        </View>
        {expanded ? (
          <View style={styles.body}>
            {data.input && Object.keys(data.input).length > 0 ? (
              <Text style={styles.code} selectable>
                {JSON.stringify(data.input, null, 2)}
              </Text>
            ) : null}
            {data.result ? (
              <View style={[styles.result, failed && { borderLeftColor: colors.danger }]}>
                <Text style={styles.code} selectable>
                  {data.result.cancelled
                    ? '(cancelled)'
                    : data.result.content.length > RESULT_PREVIEW_LIMIT
                      ? `${data.result.content.slice(0, RESULT_PREVIEW_LIMIT)}\n… (truncated)`
                      : data.result.content || '(no output)'}
                </Text>
              </View>
            ) : (
              <Text style={styles.pending}>Running…</Text>
            )}
          </View>
        ) : null}
      </View>
    </Pressable>
  )
})

const styles = StyleSheet.create({
  block: {
    backgroundColor: colors.toolCallTint,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 2,
    borderLeftColor: colors.toolCallAccent,
    borderRadius: 8,
    paddingVertical: 7,
    paddingHorizontal: 10,
  },
  subagent: { marginLeft: 16, opacity: 0.9 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { fontSize: 9 },
  name: { color: colors.text, fontSize: 13, fontWeight: '600' },
  summary: { color: colors.textMuted, fontSize: 12, flex: 1, fontFamily: 'monospace' },
  chevron: { color: colors.textMuted, fontSize: 12 },
  body: { marginTop: 8, gap: 8 },
  code: { color: '#c9d1d9', fontFamily: 'monospace', fontSize: 11.5, lineHeight: 16 },
  result: {
    borderLeftWidth: 2,
    borderLeftColor: colors.toolResultAccent,
    paddingLeft: 8,
  },
  pending: { color: colors.textMuted, fontSize: 12, fontStyle: 'italic' },
})
