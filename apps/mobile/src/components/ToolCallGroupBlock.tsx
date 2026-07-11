/**
 * Collapsed group of 4+ consecutive same-kind tool calls, ported from the
 * desktop ToolCallGroupBlock (GROUP_THRESHOLD, TOOL_GROUP_KEY, toolNoun).
 */
import { memo, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { colors } from '@/theme/colors'
import {
  STATUS_VISUALS,
  ToolCallBlock,
  deriveToolStatus,
  type ToolCallProps,
  type ToolStatus,
} from './ToolCallBlock'

export const GROUP_THRESHOLD = 3

const TOOL_GROUP_KEY: Record<string, string> = {
  Read: 'file-access',
  Glob: 'file-access',
  Grep: 'file-access',
  WebSearch: 'web-access',
  WebFetch: 'web-access',
}

export function toolGroupKey(toolName: string): string {
  return TOOL_GROUP_KEY[toolName] ?? toolName
}

function toolNoun(name: string, count: number): string {
  const plural = count === 1 ? '' : 's'
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return `${count} file${plural}`
    case 'Bash':
      return `${count} command${plural}`
    case 'Glob':
    case 'Grep':
    case 'WebSearch':
      return `${count} search${count === 1 ? '' : 'es'}`
    case 'WebFetch':
    case 'web-access':
      return `${count} request${plural}`
    case 'Task':
      return `${count} task${plural}`
    case 'file-access':
      return `${count} operation${plural}`
    default:
      return `${count} call${plural}`
  }
}

function aggregateStatus(statuses: ToolStatus[]): ToolStatus {
  if (statuses.some((s) => s === 'pending')) return 'pending'
  if (statuses.some((s) => s === 'cancelled')) return 'cancelled'
  if (statuses.some((s) => s === 'error')) return 'error'
  return 'done'
}

export const ToolCallGroupBlock = memo(function ToolCallGroupBlock(props: {
  calls: ToolCallProps[]
  /** Group key; shown when the group mixes tool names. */
  groupKey: string
  subagent?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const { calls, groupKey } = props

  const names = new Set(
    calls.map((call) => (typeof call.metadata.name === 'string' ? call.metadata.name : call.content || 'tool')),
  )
  const displayName = names.size === 1 ? [...names][0] : groupKey
  const status = aggregateStatus(calls.map((call) => deriveToolStatus(call.result)))
  const visuals = STATUS_VISUALS[status]

  return (
    <View
      style={[
        styles.block,
        { borderLeftColor: visuals.accent, backgroundColor: visuals.tint },
        props.subagent && styles.subagent,
      ]}
    >
      <Pressable onPress={() => setExpanded((v) => !v)} style={styles.header}>
        {visuals.glyph === null ? (
          <ActivityIndicator size={10} color={visuals.color} />
        ) : (
          <Text style={[styles.glyph, { color: visuals.color }]}>{visuals.glyph}</Text>
        )}
        <Text style={[styles.name, { color: visuals.color }]} numberOfLines={1}>
          {displayName}
        </Text>
        <Text style={styles.summary} numberOfLines={1}>
          {toolNoun(displayName, calls.length)}
        </Text>
        <View style={[styles.badge, { backgroundColor: visuals.badgeBg }]}>
          <Text style={[styles.badgeText, { color: visuals.color }]}>{visuals.badge}</Text>
        </View>
        <Text style={[styles.chevron, expanded && { transform: [{ rotate: '180deg' }] }]}>▼</Text>
      </Pressable>
      {expanded ? (
        <View style={styles.children}>
          {calls.map((call, index) => (
            <ToolCallBlock key={index} {...call} subagent={false} />
          ))}
        </View>
      ) : null}
    </View>
  )
})

const styles = StyleSheet.create({
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
  summary: { flex: 1, color: colors.textMuted, fontSize: 11.5, opacity: 0.75 },
  badge: { borderRadius: 999, paddingHorizontal: 6, paddingVertical: 2 },
  badgeText: { fontSize: 8.5, fontWeight: '700', letterSpacing: 0.4 },
  chevron: { color: colors.textMuted, fontSize: 9 },
  children: { paddingLeft: 12, paddingRight: 6, paddingBottom: 8, gap: 3 },
})
