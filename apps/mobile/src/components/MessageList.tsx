import { memo, useCallback, useMemo, useRef, useState } from 'react'
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'
import { parseMetadata, type Message } from '@polycode/shared'
import { colors } from '@/theme/colors'
import { Markdown } from './Markdown'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallBlock, deriveToolStatus, type ToolCallProps, type ToolResultData } from './ToolCallBlock'
import { GROUP_THRESHOLD, ToolCallGroupBlock, toolGroupKey } from './ToolCallGroupBlock'
import { canonicalToolName } from './ToolCallBlock'

type ItemKind = 'user' | 'text' | 'thinking' | 'tool_call' | 'tool_group' | 'error' | 'plan'

interface RenderItem {
  key: string
  kind: ItemKind
  content: string
  subagent: boolean
  toolCall?: ToolCallProps
  group?: { calls: ToolCallProps[]; groupKey: string }
}

function isSubagent(meta: Record<string, unknown> | null): boolean {
  if (!meta) return false
  return Boolean(meta.agent_scope === 'subagent' || meta.agent_task_id || meta.agent_parent_tool_use_id)
}

/**
 * Build render items from raw messages:
 * 1. pair each tool_result with its tool_call by tool_use_id,
 * 2. classify bubbles (text/thinking/plan/error/tool),
 * 3. group 4+ consecutive same-kind, same-status tool calls (desktop parity).
 */
function buildItems(messages: Message[]): RenderItem[] {
  const parsed = messages.map((message) => ({ message, meta: parseMetadata(message.metadata) }))

  // tool_use_id → result payload
  const resultsByToolUseId = new Map<string, ToolResultData>()
  const pairedToolUseIds = new Set<string>()
  for (const { message, meta } of parsed) {
    if (meta?.type === 'tool_result' && typeof meta.tool_use_id === 'string') {
      resultsByToolUseId.set(meta.tool_use_id, { content: message.content, metadata: meta })
    }
  }
  for (const { meta } of parsed) {
    if (meta?.type === 'tool_call' && typeof meta.id === 'string' && resultsByToolUseId.has(meta.id)) {
      pairedToolUseIds.add(meta.id)
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
          content: message.content,
          metadata: meta,
          result: toolUseId ? (resultsByToolUseId.get(toolUseId) ?? null) : null,
          subagent,
        },
      })
      continue
    }

    if (meta?.type === 'tool_result') {
      // Rendered inside its tool_call block; only show orphans.
      if (typeof meta.tool_use_id === 'string' && pairedToolUseIds.has(meta.tool_use_id)) continue
      items.push({
        key: message.id,
        kind: 'tool_call',
        content: message.content,
        subagent,
        toolCall: {
          content: typeof meta.name === 'string' ? meta.name : 'result',
          metadata: { name: typeof meta.name === 'string' ? meta.name : 'result' },
          result: { content: message.content, metadata: meta },
          subagent,
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

  return groupToolRuns(items)
}

/** Collapse runs of >GROUP_THRESHOLD consecutive tool calls sharing a group key + status. */
function groupToolRuns(items: RenderItem[]): RenderItem[] {
  const out: RenderItem[] = []
  let run: RenderItem[] = []
  let runKey = ''
  let runStatus = ''
  let runSubagent = false

  const flush = () => {
    if (run.length > GROUP_THRESHOLD) {
      out.push({
        key: `group-${run[0].key}`,
        kind: 'tool_group',
        content: '',
        subagent: runSubagent,
        group: { calls: run.map((item) => item.toolCall!), groupKey: runKey },
      })
    } else {
      out.push(...run)
    }
    run = []
  }

  for (const item of items) {
    if (item.kind === 'tool_call' && item.toolCall) {
      const rawName = typeof item.toolCall.metadata.name === 'string' ? item.toolCall.metadata.name : item.content
      const key = toolGroupKey(canonicalToolName(rawName, item.toolCall.metadata))
      const status = deriveToolStatus(item.toolCall.result)
      if (run.length > 0 && key === runKey && status === runStatus && item.subagent === runSubagent) {
        run.push(item)
        continue
      }
      flush()
      run = [item]
      runKey = key
      runStatus = status
      runSubagent = item.subagent
      continue
    }
    flush()
    out.push(item)
  }
  flush()
  return out
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
      return item.toolCall ? <ToolCallBlock {...item.toolCall} /> : null
    case 'tool_group':
      return item.group ? (
        <ToolCallGroupBlock calls={item.group.calls} groupKey={item.group.groupKey} subagent={item.subagent} />
      ) : null
    case 'error':
      return (
        <View style={styles.errorBlock}>
          <Text style={styles.errorText} selectable>
            <Text style={{ fontWeight: '700' }}>Error: </Text>
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
        <View style={[styles.assistantRow, item.subagent && styles.subagentText]}>
          <View style={styles.assistantBubble}>
            <Markdown>{item.content}</Markdown>
          </View>
        </View>
      )
  }
})

/** Mirrors desktop MessageStream: 64px follow threshold + "↓ Latest" pill. */
const AUTO_SCROLL_THRESHOLD_PX = 64

export function MessageList(props: { messages: Message[] }) {
  const items = useMemo(() => buildItems(props.messages), [props.messages])
  const reversed = useMemo(() => [...items].reverse(), [items])
  const listRef = useRef<FlatList<RenderItem>>(null)
  const [showLatest, setShowLatest] = useState(false)
  // Desktop MessageStream parity: while the user is at (or near) the bottom,
  // stay pinned there through streaming — even when regrouping re-keys items
  // and the list loses its scroll anchor.
  const followBottom = useRef(true)

  // Inverted list: contentOffset.y === 0 is the visual bottom.
  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const atBottom = event.nativeEvent.contentOffset.y < AUTO_SCROLL_THRESHOLD_PX
    followBottom.current = atBottom
    setShowLatest((prev) => (prev === !atBottom ? prev : !atBottom))
  }, [])

  const scrollToBottom = useCallback(() => {
    followBottom.current = true
    listRef.current?.scrollToOffset({ offset: 0, animated: true })
    setShowLatest(false)
  }, [])

  const handleContentSizeChange = useCallback(() => {
    if (followBottom.current) {
      listRef.current?.scrollToOffset({ offset: 0, animated: false })
    }
  }, [])

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        ref={listRef}
        data={reversed}
        inverted
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => <Row item={item} />}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        onScroll={handleScroll}
        scrollEventThrottle={48}
        onContentSizeChange={handleContentSizeChange}
        // Keeps the viewport stable while streamed chunks resize items when
        // the user has scrolled up.
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      />
      {showLatest ? (
        <Pressable onPress={scrollToBottom} style={({ pressed }) => [styles.latestButton, pressed && { opacity: 0.8 }]}>
          <Text style={styles.latestButtonText}>↓ Latest</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  content: { padding: 14, gap: 8 },
  userRow: { flexDirection: 'row', justifyContent: 'flex-end' },
  userBubble: {
    backgroundColor: colors.claude,
    borderRadius: 10,
    paddingHorizontal: 13,
    paddingVertical: 8,
    maxWidth: '85%',
  },
  userText: { color: '#ffffff', fontSize: 14.5, lineHeight: 21 },
  assistantRow: { flexDirection: 'row', justifyContent: 'flex-start' },
  assistantBubble: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 13,
    paddingVertical: 6,
    maxWidth: '94%',
    flexShrink: 1,
  },
  errorBlock: {
    backgroundColor: '#3b0000',
    borderWidth: 1,
    borderColor: '#7f1d1d',
    borderRadius: 8,
    padding: 10,
  },
  errorText: { color: '#f87171', fontSize: 12.5, fontFamily: 'monospace', lineHeight: 18 },
  planBlock: {
    borderWidth: 1,
    borderColor: colors.info,
    borderRadius: 10,
    padding: 12,
    backgroundColor: 'rgba(96, 165, 250, 0.06)',
  },
  planLabel: {
    color: colors.info,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  subagentText: { marginLeft: 16, opacity: 0.9 },
  latestButton: {
    position: 'absolute',
    bottom: 14,
    right: 14,
    backgroundColor: colors.claude,
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 7,
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  latestButtonText: { color: '#fff', fontSize: 12.5, fontWeight: '600' },
})
