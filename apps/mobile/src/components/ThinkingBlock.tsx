import { memo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { colors } from '@/theme/colors'
import { Markdown } from './Markdown'

/** Desktop parity: purple accent, ◌ icon, 200-char collapsed preview. */
const TRUNCATE_LENGTH = 200
const EXPANDED_MAX_HEIGHT = 320

/**
 * The collapsed one-liner keeps only inline bold, as on the desktop: a full
 * Markdown pass would introduce block layout (headings, lists) into a single
 * truncated line, while dropping the markers would read as stray asterisks.
 */
function InlineBold(props: { text: string }) {
  const parts = props.text.split(/(\*\*[^*]+\*\*)/g)
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith('**') && part.endsWith('**') ? (
          <Text key={index} style={styles.bold}>
            {part.slice(2, -2)}
          </Text>
        ) : (
          part
        ),
      )}
    </>
  )
}

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
        {expanded ? (
          <ScrollView style={{ maxHeight: EXPANDED_MAX_HEIGHT }} nestedScrollEnabled>
            <Markdown variant="thinking">{props.content}</Markdown>
          </ScrollView>
        ) : (
          <Text style={styles.content} numberOfLines={2}>
            <InlineBold text={preview} />
          </Text>
        )}
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
  bold: { fontWeight: '600', color: colors.text },
})
