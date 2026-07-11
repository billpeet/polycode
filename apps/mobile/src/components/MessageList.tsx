import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Animated,
  Easing,
  FlatList,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'
import { parseMetadata, type Message } from '@polycode/shared'
import { colors } from '@/theme/colors'
import { AgentGroupBlock, type AgentGroupMeta, type AgentStatus } from './AgentGroupBlock'
import { Markdown } from './Markdown'
import { ThinkingBlock } from './ThinkingBlock'
import {
  ToolCallBlock,
  canonicalToolName,
  deriveToolStatus,
  type ToolCallProps,
  type ToolResultData,
} from './ToolCallBlock'
import { GROUP_THRESHOLD, ToolCallGroupBlock, toolGroupKey } from './ToolCallGroupBlock'

type ItemKind = 'user' | 'text' | 'thinking' | 'tool_call' | 'tool_group' | 'error' | 'plan' | 'agent' | 'working'

interface RenderItem {
  key: string
  kind: ItemKind
  content: string
  toolCall?: ToolCallProps
  group?: { calls: ToolCallProps[]; groupKey: string }
  agent?: { meta: AgentGroupMeta; entries: RenderItem[] }
}

interface ParsedMsg {
  message: Message
  meta: Record<string, unknown> | null
}

// ── Sub-agent helpers (ported from desktop MessageStream) ────────────────────

function messageParentKey(meta: Record<string, unknown> | null): string | null {
  if (!meta || meta.agent_scope !== 'subagent') return null
  const parent = meta.agent_parent_tool_use_id
  return typeof parent === 'string' && parent ? parent : null
}

/** "Subagent started/completed" lifecycle bubbles — the group header shows status instead. */
function isAgentStatusBubble(meta: Record<string, unknown> | null): boolean {
  return (
    meta?.source === 'claude_task' &&
    (meta.task_event === 'started' || meta.task_event === 'progress' || meta.task_event === 'notification')
  )
}

function humanizeAgentType(type: string): string {
  return type
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

interface AgentUsage {
  totalTokens?: number
  toolUses?: number
}

function deriveAgentMeta(bucket: ParsedMsg[]): Omit<AgentGroupMeta, 'entryCount' | 'statsLabel'> & {
  usage?: AgentUsage
  lastToolName?: string
} {
  let subagentType: string | undefined
  let description: string | undefined
  let status: AgentStatus = 'running'
  let terminalStatus: AgentStatus | undefined
  let usage: AgentUsage | undefined
  let lastToolName: string | undefined

  for (const { meta } of bucket) {
    if (!meta) continue
    if (typeof meta.agent_subagent_type === 'string' && meta.agent_subagent_type) {
      subagentType = meta.agent_subagent_type
    } else if (typeof meta.subagent_type === 'string' && meta.subagent_type && !subagentType) {
      subagentType = meta.subagent_type
    }
    if (typeof meta.agent_description === 'string' && meta.agent_description) description = meta.agent_description
    if (typeof meta.agent_status === 'string') status = meta.agent_status as AgentStatus
    // A terminal task_notification within the bucket is the authoritative final status.
    if (meta.task_event === 'notification' && typeof meta.status === 'string') {
      terminalStatus = meta.status as AgentStatus
    }
    const u = meta.usage as Record<string, unknown> | undefined
    if (u && typeof u === 'object') {
      usage = {
        totalTokens: typeof u.total_tokens === 'number' ? u.total_tokens : usage?.totalTokens,
        toolUses: typeof u.tool_uses === 'number' ? u.tool_uses : usage?.toolUses,
      }
    }
    if (typeof meta.last_tool_name === 'string' && meta.last_tool_name) lastToolName = meta.last_tool_name
  }

  const label = subagentType ? humanizeAgentType(subagentType) : description || 'subagent'
  return { label, description, status: terminalStatus ?? status, usage, lastToolName }
}

function agentStatsLabel(
  status: AgentStatus,
  usage: AgentUsage | undefined,
  lastToolName: string | undefined,
): string | null {
  const parts: string[] = []
  if (typeof usage?.toolUses === 'number') parts.push(`${usage.toolUses} ${usage.toolUses === 1 ? 'tool' : 'tools'}`)
  if (typeof usage?.totalTokens === 'number' && usage.totalTokens > 0) parts.push(`${formatTokens(usage.totalTokens)} tokens`)
  if (status === 'running' && lastToolName) parts.push(lastToolName)
  return parts.length ? parts.join(' · ') : null
}

// ── Scope classification (pairing + bubble kinds) ────────────────────────────

/** Classify one scope's messages into render items, pairing tool_results by tool_use_id. */
function classifyScope(scope: ParsedMsg[]): RenderItem[] {
  const resultsByToolUseId = new Map<string, ToolResultData>()
  const pairedToolUseIds = new Set<string>()
  for (const { message, meta } of scope) {
    if (meta?.type === 'tool_result' && typeof meta.tool_use_id === 'string') {
      resultsByToolUseId.set(meta.tool_use_id, { content: message.content, metadata: meta })
    }
  }
  for (const { meta } of scope) {
    if (meta?.type === 'tool_call' && typeof meta.id === 'string' && resultsByToolUseId.has(meta.id)) {
      pairedToolUseIds.add(meta.id)
    }
  }

  const items: RenderItem[] = []
  for (const { message, meta } of scope) {
    if (meta?.type === 'tool_call') {
      const toolUseId = typeof meta.id === 'string' ? meta.id : null
      items.push({
        key: message.id,
        kind: 'tool_call',
        content: message.content,
        toolCall: {
          content: message.content,
          metadata: meta,
          result: toolUseId ? (resultsByToolUseId.get(toolUseId) ?? null) : null,
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
        toolCall: {
          content: typeof meta.name === 'string' ? meta.name : 'result',
          metadata: { name: typeof meta.name === 'string' ? meta.name : 'result' },
          result: { content: message.content, metadata: meta },
        },
      })
      continue
    }

    if (meta?.type === 'thinking') {
      if (message.content.trim()) items.push({ key: message.id, kind: 'thinking', content: message.content })
      continue
    }

    if (meta?.type === 'plan_ready') {
      items.push({ key: message.id, kind: 'plan', content: message.content })
      continue
    }

    if (message.role === 'user') {
      items.push({ key: message.id, kind: 'user', content: message.content })
      continue
    }

    if (message.role === 'system' || meta?.type === 'error') {
      items.push({ key: message.id, kind: 'error', content: message.content })
      continue
    }

    if (message.content.trim()) {
      items.push({ key: message.id, kind: 'text', content: message.content })
    }
  }
  return items
}

/** Collapse runs of >GROUP_THRESHOLD consecutive tool calls sharing a group key + status. */
function groupToolRuns(items: RenderItem[]): RenderItem[] {
  const out: RenderItem[] = []
  let run: RenderItem[] = []
  let runKey = ''
  let runStatus = ''

  const flush = () => {
    if (run.length > GROUP_THRESHOLD) {
      out.push({
        key: `group-${run[0].key}`,
        kind: 'tool_group',
        content: '',
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
      if (run.length > 0 && key === runKey && status === runStatus) {
        run.push(item)
        continue
      }
      flush()
      run = [item]
      runKey = key
      runStatus = status
      continue
    }
    flush()
    out.push(item)
  }
  flush()
  return out
}

// ── Top-level build: bucket by sub-agent, splice groups at their anchors ─────

/**
 * Ported from desktop groupByAgent: bucket messages by their immediate
 * agent_parent_tool_use_id, then assemble each scope with child AgentGroups
 * replacing the Task tool_call that spawned them.
 */
function buildItems(messages: Message[]): RenderItem[] {
  const parsed: ParsedMsg[] = messages.map((message) => ({ message, meta: parseMetadata(message.metadata) }))

  const buckets = new Map<string, ParsedMsg[]>()
  const bucketOrder: string[] = []
  const mainMessages: ParsedMsg[] = []

  for (const item of parsed) {
    const parentKey = messageParentKey(item.meta)
    if (parentKey) {
      let bucket = buckets.get(parentKey)
      if (!bucket) {
        bucket = []
        buckets.set(parentKey, bucket)
        bucketOrder.push(parentKey)
      }
      bucket.push(item)
    } else {
      mainMessages.push(item)
    }
  }

  const assembleScope = (scope: ParsedMsg[]): RenderItem[] => {
    const visible = scope.filter((p) => !isAgentStatusBubble(p.meta))
    return groupToolRuns(classifyScope(visible))
  }

  if (buckets.size === 0) {
    return assembleScope(mainMessages)
  }

  const groupCache = new Map<string, RenderItem>()
  const building = new Set<string>() // cycle guard

  const makeGroup = (parentKey: string, anchorInput?: Record<string, unknown>): RenderItem => {
    const cached = groupCache.get(parentKey)
    if (cached) return cached
    building.add(parentKey)
    const bucket = buckets.get(parentKey) ?? []
    const entries = assemble(bucket)
    building.delete(parentKey)
    const derived = deriveAgentMeta(bucket)
    const prompt = typeof anchorInput?.prompt === 'string' ? anchorInput.prompt : undefined
    const group: RenderItem = {
      key: `agent-${parentKey}`,
      kind: 'agent',
      content: '',
      agent: {
        meta: {
          label: derived.label,
          description: derived.description,
          prompt,
          status: derived.status,
          statsLabel: agentStatsLabel(derived.status, derived.usage, derived.lastToolName),
          entryCount: entries.length,
        },
        entries,
      },
    }
    groupCache.set(parentKey, group)
    return group
  }

  const anchorIdOf = (call: ToolCallProps): string | null => {
    const id = call.metadata.id
    return typeof id === 'string' && id ? id : null
  }

  const assemble = (scope: ParsedMsg[]): RenderItem[] => {
    const base = assembleScope(scope)
    const result: RenderItem[] = []
    for (const item of base) {
      if (item.kind === 'tool_call' && item.toolCall) {
        const anchorId = anchorIdOf(item.toolCall)
        if (anchorId && buckets.has(anchorId) && !building.has(anchorId)) {
          // The agent group replaces the Task tool_call that spawned it.
          result.push(makeGroup(anchorId, item.toolCall.metadata.input as Record<string, unknown> | undefined))
          continue
        }
        result.push(item)
        continue
      }
      if (item.kind === 'tool_group' && item.group) {
        result.push(item)
        for (const call of item.group.calls) {
          const anchorId = anchorIdOf(call)
          if (anchorId && buckets.has(anchorId) && !building.has(anchorId)) {
            result.push(makeGroup(anchorId, call.metadata.input as Record<string, unknown> | undefined))
          }
        }
        continue
      }
      result.push(item)
    }
    return result
  }

  const result = assemble(mainMessages)

  // Append any groups whose anchor Task tool_call wasn't found (race / compat).
  for (const parentKey of bucketOrder) {
    if (!groupCache.has(parentKey)) result.push(makeGroup(parentKey))
  }

  return result
}

function shareContent(content: string): void {
  void Share.share({ message: content }).catch(() => undefined)
}

/** Bouncing-dots indicator shown while the agent is working (desktop parity). */
const WorkingIndicator = memo(function WorkingIndicator() {
  const dots = useRef([new Animated.Value(0), new Animated.Value(0), new Animated.Value(0)]).current

  useEffect(() => {
    const animations = dots.map((dot, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * 140),
          Animated.timing(dot, { toValue: -6, duration: 280, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.timing(dot, { toValue: 0, duration: 280, easing: Easing.in(Easing.quad), useNativeDriver: true }),
          Animated.delay((2 - index) * 140 + 160),
        ]),
      ),
    )
    animations.forEach((animation) => animation.start())
    return () => animations.forEach((animation) => animation.stop())
  }, [dots])

  return (
    <View style={styles.workingRow}>
      {dots.map((dot, index) => (
        <Animated.View key={index} style={[styles.workingDot, { transform: [{ translateY: dot }] }]} />
      ))}
    </View>
  )
})

const Row = memo(function Row({ item }: { item: RenderItem }) {
  switch (item.kind) {
    case 'working':
      return <WorkingIndicator />
    case 'user':
      return (
        <View style={styles.userRow}>
          <Pressable style={styles.userBubble} onLongPress={() => shareContent(item.content)}>
            <Text style={styles.userText} selectable>
              {item.content}
            </Text>
          </Pressable>
        </View>
      )
    case 'thinking':
      return <ThinkingBlock content={item.content} />
    case 'tool_call':
      return item.toolCall ? <ToolCallBlock {...item.toolCall} /> : null
    case 'tool_group':
      return item.group ? <ToolCallGroupBlock calls={item.group.calls} groupKey={item.group.groupKey} /> : null
    case 'agent':
      return item.agent ? (
        <AgentGroupBlock meta={item.agent.meta}>
          {item.agent.entries.map((entry) => (
            <Row key={entry.key} item={entry} />
          ))}
        </AgentGroupBlock>
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
        <View style={styles.assistantRow}>
          <Pressable style={styles.assistantBubble} onLongPress={() => shareContent(item.content)}>
            <Markdown>{item.content}</Markdown>
          </Pressable>
        </View>
      )
  }
})

/** Mirrors desktop MessageStream: 64px follow threshold + "↓ Latest" pill. */
const AUTO_SCROLL_THRESHOLD_PX = 64

const WORKING_ITEM: RenderItem = { key: '__working', kind: 'working', content: '' }

export function MessageList(props: { messages: Message[]; working?: boolean }) {
  const items = useMemo(() => buildItems(props.messages), [props.messages])
  const reversed = useMemo(() => {
    const list = [...items].reverse()
    // Inverted list: index 0 renders at the visual bottom.
    if (props.working) list.unshift(WORKING_ITEM)
    return list
  }, [items, props.working])
  const listRef = useRef<FlatList<RenderItem>>(null)
  const [showLatest, setShowLatest] = useState(false)
  // Desktop MessageStream parity: while the user is at (or near) the bottom,
  // stay pinned there through streaming — even when regrouping re-keys items
  // and the list loses its scroll anchor.
  const followBottom = useRef(true)
  // Only user-initiated drags may release the bottom pin. Programmatic
  // adjustments (maintainVisibleContentPosition, our own scrollToOffset)
  // also emit onScroll events — treating those as user intent is what made
  // the list silently stop following during streaming.
  const dragging = useRef(false)

  // Inverted list: contentOffset.y === 0 is the visual bottom.
  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const atBottom = event.nativeEvent.contentOffset.y < AUTO_SCROLL_THRESHOLD_PX
    if (dragging.current || atBottom) followBottom.current = atBottom
    setShowLatest((prev) => (prev === !atBottom ? prev : !atBottom))
  }, [])

  const handleScrollBeginDrag = useCallback(() => {
    dragging.current = true
  }, [])

  const handleScrollEndDrag = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    dragging.current = false
    followBottom.current = event.nativeEvent.contentOffset.y < AUTO_SCROLL_THRESHOLD_PX
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
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={handleScrollEndDrag}
        scrollEventThrottle={48}
        onContentSizeChange={handleContentSizeChange}
        // MVCP anchors the previously-visible item, which on an inverted list
        // actively pushes the offset away from 0 as new items prepend — so it
        // must be OFF while following the bottom. Enable it only when the
        // user has scrolled up, to keep their reading position stable while
        // streamed chunks resize items (anchor ≥1 skips the growing newest
        // item).
        maintainVisibleContentPosition={showLatest ? { minIndexForVisible: 1 } : undefined}
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
  workingRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    paddingHorizontal: 6,
    paddingTop: 10,
    paddingBottom: 4,
    height: 30,
  },
  workingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.claude,
  },
})
