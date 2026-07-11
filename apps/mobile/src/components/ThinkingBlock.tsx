import { memo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors } from '@/theme/colors'

export const ThinkingBlock = memo(function ThinkingBlock(props: { content: string; subagent?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const preview = props.content.replace(/\s+/g, ' ').trim()

  return (
    <Pressable onPress={() => setExpanded((v) => !v)}>
      <View style={[styles.block, props.subagent && styles.subagent]}>
        <View style={styles.header}>
          <Text style={styles.label}>Thinking</Text>
          <Text style={styles.chevron}>{expanded ? '▾' : '▸'}</Text>
        </View>
        <Text style={styles.content} numberOfLines={expanded ? undefined : 2} selectable={expanded}>
          {expanded ? props.content : preview}
        </Text>
      </View>
    </Pressable>
  )
})

const styles = StyleSheet.create({
  block: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingVertical: 7,
    paddingHorizontal: 10,
    backgroundColor: colors.surface,
    opacity: 0.85,
  },
  subagent: { marginLeft: 16 },
  header: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 },
  label: { color: colors.textMuted, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  chevron: { color: colors.textMuted, fontSize: 12 },
  content: { color: colors.textMuted, fontSize: 13, fontStyle: 'italic', lineHeight: 19 },
})
