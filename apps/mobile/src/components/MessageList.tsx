import { memo, useMemo } from 'react'
import { FlatList, StyleSheet, Text, View } from 'react-native'
import { parseMetadata, type Message } from '@polycode/shared'
import { Markdown } from './Markdown'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallBlock, type ToolCallData } from './ToolCallBlock'
import { colors } from '@/theme/colors'

type ItemKind = 'user' | 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'error' | 'plan'

interface RenderItem {
  key: string
  kind: ItemKind
  content: string
  subagent: boolean
  toolCall?: ToolCallData
}

function isSubagent(meta: Record<string, unknown> | null): boolean {
  if (!meta) return false
  return Boolean(meta.agent_scope === 'subagent' || meta.agent_task_id || meta.agent_parent_tool_use_id)
}

/**
 * Build render items from raw messages: pairs each tool_result with its
 * tool_call by tool_use_id so results render inside the call block, and
 * classifies the remaining bubbles.
 */
function buildItems(messages: Message[]): RenderItem[] {
  const parsed = messages.map((message) => ({ message, meta: parseMetadata(message.metadata) }))

  // tool_use_id → result payload
  const resultsByToolUseId = new Map<string, { content: string; isError: boolean; cancelled: boolean }>()
  for (const { message, meta } of parsed) {
    if (meta?.type === 'tool_result' && typeof meta.tool_use_id === 'string') {
      resultsByToolUseId.set(meta.tool_use_id, {
        content: message.content,
        isError: Boolean(meta.is_error),
        cancelled: Boolean(meta.cancelled),
      })
    }
  }

  const items: RenderItem[] = []
  for (const { message, meta } of parsed) {
    const subagent = isSubagent(meta)

    if (meta?.type === 'tool_call') {
      const toolUseId = typeof meta.id === 'string' ? meta.id : null
      items.push({
        key: message.id,
        kind: 'tool_call',
        content: message.content,
        subagent,
        toolCall: {
          name: typeof meta.name === 'string' ? meta.name : message.content || 'tool',
          input: (meta.input as Record<string, unknown> | undefined) ?? undefined,
          result: toolUseId ? resultsByToolUseId.get(toolUseId) : undefined,
        },
      })
      continue
    }

    if (meta?.type === 'tool_result') {
      // Rendered inside its tool_call block; only show orphans.
      if (typeof meta.tool_use_id === 'string' && parsed.some((p) => p.meta?.type === 'tool_call' && p.meta.id === meta.tool_use_id)) {
        continue
      }
      items.push({
        key: message.id,
        kind: 'tool_result',
        content: message.content,
        subagent,
        toolCall: {
          name: 'result',
          result: { content: message.content, isError: Boolean(meta.is_error), cancelled: Boolean(meta.cancelled) },
        },
      })
      continue
    }

    if (meta?.type === 'thinking') {
      if (message.content.trim()) items.push({ key: message.id, kind: 'thinking', content: message.content, subagent })
      continue
    }

    if (meta?.type === 'plan_ready') {
      items.push({ key: message.id, kind: 'plan', content: message.content, subagent })
      continue
    }

    if (message.role === 'user') {
      items.push({ key: message.id, kind: 'user', content: message.content, subagent: false })
      continue
    }

    if (message.role === 'system' || meta?.type === 'error') {
      items.push({ key: message.id, kind: 'error', content: message.content, subagent })
      continue
    }

    if (message.content.trim()) {
      items.push({ key: message.id, kind: 'text', content: message.content, subagent })
    }
  }
  return items
}

const Row = memo(function Row({ item }: { item: RenderItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <View style={styles.userRow}>
          <View style={styles.userBubble}>
            <Text style={styles.userText} selectable>
              {item.content}
            </Text>
          </View>
        </View>
      )
    case 'thinking':
      return <ThinkingBlock content={item.content} subagent={item.subagent} />
    case 'tool_call':
    case 'tool_result':
      return item.toolCall ? <ToolCallBlock data={item.toolCall} subagent={item.subagent} /> : null
    case 'error':
      return (
        <View style={styles.errorBlock}>
          <Text style={styles.errorText} selectable>
            {item.content}
          </Text>
        </View>
      )
    case 'plan':
      return (
        <View style={styles.planBlock}>
          <Text style={styles.planLabel}>Plan</Text>
          <Markdown>{item.content}</Markdown>
        </View>
      )
    case 'text':
    default:
      return (
        <View style={item.subagent ? styles.subagentText : undefined}>
          <Markdown>{item.content}</Markdown>
        </View>
      )
  }
})

export function MessageList(props: { messages: Message[] }) {
  const items = useMemo(() => buildItems(props.messages), [props.messages])
  const reversed = useMemo(() => [...items].reverse(), [items])

  return (
    <FlatList
      data={reversed}
      inverted
      keyExtractor={(item) => item.key}
      renderItem={({ item }) => <Row item={item} />}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    />
  )
}

const styles = StyleSheet.create({
  content: { padding: 14, gap: 8 },
  userRow: { flexDirection: 'row', justifyContent: 'flex-end' },
  userBubble: {
    backgroundColor: colors.surface2,
    borderRadius: 14,
    borderBottomRightRadius: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    maxWidth: '85%',
  },
  userText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  errorBlock: {
    backgroundColor: 'rgba(248, 113, 113, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(248, 113, 113, 0.35)',
    borderRadius: 8,
    padding: 10,
  },
  errorText: { color: colors.danger, fontSize: 13, fontFamily: 'monospace' },
  planBlock: {
    borderWidth: 1,
    borderColor: colors.info,
    borderRadius: 10,
    padding: 12,
    backgroundColor: 'rgba(96, 165, 250, 0.06)',
  },
  planLabel: { color: colors.info, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  subagentText: { marginLeft: 16, opacity: 0.9 },
})
