import { memo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors } from '@/theme/colors'

/** Desktop parity: purple accent, ◌ icon, 200-char collapsed preview. */
const TRUNCATE_LENGTH = 200

export const ThinkingBlock = memo(function ThinkingBlock(props: { content: string; subagent?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const collapsed = props.content.replace(/\s+/g, ' ').trim()
  const preview = collapsed.length > TRUNCATE_LENGTH ? collapsed.slice(0, TRUNCATE_LENGTH) + '…' : collapsed

  return (
    <Pressable onPress={() => setExpanded((v) => !v)}>
      <View style={[styles.block, props.subagent && styles.subagent]}>
        <View style={styles.header}>
          <Text style={styles.icon}>◌</Text>
          <Text style={styles.label}>Thinking</Text>
          <Text style={styles.chevron}>{expanded ? '▾' : '▸'}</Text>
        </View>
        <Text style={styles.content} selectable={expanded}>
          {expanded ? props.content : preview}
        </Text>
      </View>
    </Pressable>
  )
})

const styles = StyleSheet.create({
  block: {
    borderLeftWidth: 2,
    borderLeftColor: 'rgba(139, 92, 246, 0.5)',
    backgroundColor: 'rgba(139, 92, 246, 0.04)',
    borderTopRightRadius: 4,
    borderBottomRightRadius: 4,
    paddingVertical: 7,
    paddingHorizontal: 10,
  },
  subagent: { marginLeft: 16 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3 },
  icon: { color: 'rgba(139, 92, 246, 0.8)', fontSize: 12 },
  label: {
    color: colors.textMuted,
    fontSize: 10.5,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    flex: 1,
  },
  chevron: { color: colors.textMuted, fontSize: 12 },
  content: { color: colors.textMuted, fontSize: 13, fontStyle: 'italic', lineHeight: 19 },
})
