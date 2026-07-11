/**
 * Collapsible sub-agent transcript group, ported from the desktop
 * AgentGroupBlock: 🤖 + humanized subagent label, status glyph/badge,
 * usage stats, optional PROMPT section, and the agent's nested entries.
 */
import { memo, useState, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { colors } from '@/theme/colors'
import { Markdown } from './Markdown'

export type AgentStatus = 'running' | 'completed' | 'failed' | 'stopped'

export interface AgentGroupMeta {
  label: string
  description?: string
  prompt?: string
  status: AgentStatus
  statsLabel: string | null
  entryCount: number
}

const STATUS_VISUALS: Record<AgentStatus, { glyph: string | null; color: string; badge: string; badgeBg: string }> = {
  running: { glyph: null, color: colors.claude, badge: 'RUNNING', badgeBg: 'rgba(232, 123, 95, 0.15)' },
  completed: { glyph: '✓', color: '#4ade80', badge: 'DONE', badgeBg: 'rgba(74, 222, 128, 0.12)' },
  failed: { glyph: '✗', color: '#f87171', badge: 'FAILED', badgeBg: 'rgba(248, 113, 113, 0.15)' },
  stopped: { glyph: '—', color: '#6b7280', badge: 'STOPPED', badgeBg: 'rgba(107, 114, 128, 0.15)' },
}

const ENTRIES_MAX_HEIGHT = 480
const PROMPT_MAX_HEIGHT = 300

export const AgentGroupBlock = memo(function AgentGroupBlock(props: { meta: AgentGroupMeta; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false)
  const [showPrompt, setShowPrompt] = useState(false)
  const { meta } = props
  const visuals = STATUS_VISUALS[meta.status]

  return (
    <View style={[styles.block, meta.status === 'running' && styles.blockRunning]}>
      <Pressable onPress={() => setExpanded((v) => !v)} style={styles.header}>
        {visuals.glyph === null ? (
          <ActivityIndicator size={10} color={visuals.color} />
        ) : (
          <Text style={[styles.glyph, { color: visuals.color }]}>{visuals.glyph}</Text>
        )}
        <Text style={styles.robot}>🤖</Text>
        <Text style={[styles.label, { color: visuals.color }]} numberOfLines={1}>
          {meta.label}
        </Text>
        {meta.statsLabel ? (
          <Text style={styles.stats} numberOfLines={1}>
            {meta.statsLabel}
          </Text>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        <View style={[styles.badge, { backgroundColor: visuals.badgeBg }]}>
          <Text style={[styles.badgeText, { color: visuals.color }]}>{visuals.badge}</Text>
        </View>
        <Text style={[styles.chevron, expanded && { transform: [{ rotate: '180deg' }] }]}>▼</Text>
      </Pressable>

      {expanded && meta.description ? (
        <Text style={styles.description} numberOfLines={2}>
          {meta.description}
        </Text>
      ) : null}

      {expanded ? (
        <View style={styles.body}>
          {meta.prompt ? (
            <View style={styles.promptBlock}>
              <Pressable onPress={() => setShowPrompt((v) => !v)} style={styles.promptHeader}>
                <Text style={styles.promptLabel}>PROMPT</Text>
                <Text style={styles.chevron}>{showPrompt ? '▾' : '▸'}</Text>
              </Pressable>
              {showPrompt ? (
                <ScrollView style={{ maxHeight: PROMPT_MAX_HEIGHT }} nestedScrollEnabled>
                  <Markdown>{meta.prompt}</Markdown>
                </ScrollView>
              ) : null}
            </View>
          ) : null}
          <ScrollView style={{ maxHeight: ENTRIES_MAX_HEIGHT }} nestedScrollEnabled contentContainerStyle={{ gap: 6 }}>
            {props.children}
          </ScrollView>
          <Text style={styles.entryCount}>{meta.entryCount} entries</Text>
        </View>
      ) : null}
    </View>
  )
})

const styles = StyleSheet.create({
  block: {
    borderLeftWidth: 2,
    borderLeftColor: 'rgba(232, 123, 95, 0.35)',
    backgroundColor: 'rgba(232, 123, 95, 0.04)',
    borderTopRightRadius: 4,
    borderBottomRightRadius: 4,
  },
  blockRunning: { borderLeftColor: colors.claude },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 9,
    minHeight: 34,
  },
  glyph: { fontSize: 11, width: 12, textAlign: 'center' },
  robot: { fontSize: 12 },
  label: { fontFamily: 'monospace', fontSize: 12, fontWeight: '600', flexShrink: 1, maxWidth: '40%' },
  stats: { flex: 1, color: colors.textMuted, fontSize: 11, opacity: 0.85 },
  badge: { borderRadius: 999, paddingHorizontal: 6, paddingVertical: 2 },
  badgeText: { fontSize: 8.5, fontWeight: '700', letterSpacing: 0.4 },
  chevron: { color: colors.textMuted, fontSize: 9 },
  description: { color: colors.textMuted, fontSize: 11.5, paddingHorizontal: 10, paddingBottom: 4 },
  body: { paddingHorizontal: 8, paddingBottom: 9, gap: 8 },
  promptBlock: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    backgroundColor: colors.surface,
  },
  promptHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  promptLabel: { color: colors.textMuted, fontSize: 9.5, fontWeight: '700', letterSpacing: 0.8 },
  entryCount: { color: colors.textMuted, fontSize: 10.5, fontStyle: 'italic', textAlign: 'right' },
})
