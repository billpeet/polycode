import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react'
import { canonicalToolName, foldMessages } from '@polycode/shared'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useMessageStore } from '../stores/messages'
import { useThreadStore } from '../stores/threads'
import { renderEntry } from './renderEntry'
import AgentPrompt from './AgentPrompt'
import { Message } from '../types/ipc'
import { estimateEntryHeight } from '../lib/messageHeight'

interface Props {
  threadId: string
  sessionId?: string
  /** When set, isolate the view to a single agent group (matched by `AgentGroup.key`). */
  agentFilter?: string | null
  /** Callback to isolate the view to a specific agent group. */
  onIsolateAgent?: (agentKey: string) => void
}

const EMPTY: Message[] = []
const GROUP_THRESHOLD = 3
const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8
const AUTO_SCROLL_THRESHOLD_PX = 64

// Persistent height cache — survives thread switches and re-renders.
// Keyed by entry.key (message id or group id).
const heightCache = new Map<string, number>()
let heightCacheWidth: number | null = null
const WIDTH_CHANGE_THRESHOLD = 16

function safeParseJson(str: string | null): Record<string, unknown> | null {
  if (!str) return null
  try { return JSON.parse(str) } catch { return null }
}

export interface MessageEntry {
  kind: 'single'
  key: string
  message: Message
  metadata: Record<string, unknown> | null
  result: Message | null
  resultMetadata: Record<string, unknown> | null
}

export interface MessageGroup {
  kind: 'group'
  key: string
  toolName: string
  entries: MessageEntry[]
}

export type AgentStatus = 'running' | 'completed' | 'failed' | 'stopped'

export interface AgentGroup {
  kind: 'agent'
  key: string // `agent-${parentToolUseId}` (stable)
  parentToolUseId: string
  taskId?: string
  label: string // humanized subagent_type (fallback: description || 'subagent')
  description?: string // short task description, for disambiguation
  prompt?: string // full prompt sent to the sub-agent (Task tool_call input.prompt)
  status: AgentStatus
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number } // latest task usage
  lastToolName?: string // most recent tool the sub-agent ran (while active)
  entries: (MessageEntry | MessageGroup | AgentGroup)[]
}

export type StreamEntry = MessageEntry | MessageGroup | AgentGroup

/** Tools that can be grouped together (mapped to a shared group key). */
const TOOL_GROUP_KEY: Record<string, string> = {
  Read: 'file-access',
  Glob: 'file-access',
  Grep: 'file-access',
  WebSearch: 'web-access',
  WebFetch: 'web-access',
}

function getToolGroupKey(toolName: string, metadata?: Record<string, unknown> | null): string {
  const canonical = canonicalToolName(toolName, metadata)
  return TOOL_GROUP_KEY[canonical] ?? canonical
}

function getEntryStatus(entry: MessageEntry): string {
  if (entry.result === null) return 'pending'
  if (entry.resultMetadata?.cancelled === true) return 'cancelled'
  if (entry.resultMetadata?.is_error === true) return 'error'
  return 'done'
}

/** Pair tool_call messages with their matching tool_result by tool_use_id. */
function pairMessages(messages: Message[]): (MessageEntry | MessageGroup)[] {
  // Build a lookup of tool_result messages by tool_use_id
  const resultByToolUseId = new Map<string, Message>()
  for (const msg of messages) {
    const meta = safeParseJson(msg.metadata)
    if (meta?.type === 'tool_result') {
      const id = meta.tool_use_id as string | undefined
      if (id) resultByToolUseId.set(id, msg)
    }
  }

  const flat: MessageEntry[] = []
  const consumedIds = new Set<string>()

  for (const msg of messages) {
    const meta = safeParseJson(msg.metadata)

    // Skip tool_results that have been paired — they'll be rendered inside their call
    if (meta?.type === 'tool_result') {
      const id = meta.tool_use_id as string | undefined
      if (id && consumedIds.has(id)) continue
    }

    if (meta?.type === 'tool_call' || meta?.type === 'tool_use') {
      const toolUseId = meta.id as string | undefined
      const result = toolUseId ? resultByToolUseId.get(toolUseId) ?? null : null
      if (result && toolUseId) consumedIds.add(toolUseId)
      flat.push({
        kind: 'single',
        key: msg.id,
        message: msg,
        metadata: meta,
        result,
        resultMetadata: safeParseJson(result?.metadata ?? null),
      })
    } else {
      flat.push({
        kind: 'single',
        key: msg.id,
        message: msg,
        metadata: meta,
        result: null,
        resultMetadata: null,
      })
    }
  }

  // Group consecutive tool call entries with the same tool name when count > threshold
  const grouped: (MessageEntry | MessageGroup)[] = []
  let i = 0
  while (i < flat.length) {
    const entry = flat[i]
    const isToolCall = entry.metadata?.type === 'tool_call' || entry.metadata?.type === 'tool_use'
    if (!isToolCall) {
      grouped.push(entry)
      i++
      continue
    }
    const toolName = (entry.metadata?.name as string) ?? entry.message.content
    const groupKey = getToolGroupKey(toolName, entry.metadata)
    const entryStatus = getEntryStatus(entry)
    // Find the run of consecutive tool entries that share the same group key and status
    let j = i + 1
    while (
      j < flat.length &&
      (flat[j].metadata?.type === 'tool_call' || flat[j].metadata?.type === 'tool_use') &&
      getToolGroupKey((flat[j].metadata?.name as string) ?? flat[j].message.content, flat[j].metadata) === groupKey &&
      getEntryStatus(flat[j]) === entryStatus
    ) {
      j++
    }
    const runLength = j - i
    if (runLength > GROUP_THRESHOLD) {
      const groupEntries = flat.slice(i, j)
      // For mixed groups (different tools sharing a group key), use the group key as display name
      const uniqueTools = new Set(groupEntries.map((e) => canonicalToolName((e.metadata?.name as string) ?? e.message.content, e.metadata)))
      const displayName = uniqueTools.size > 1 ? groupKey : canonicalToolName(toolName, entry.metadata)
      grouped.push({
        kind: 'group',
        key: `group-${entry.key}`,
        toolName: displayName,
        entries: groupEntries,
      })
    } else {
      for (let k = i; k < j; k++) grouped.push(flat[k])
    }
    i = j
  }

  return grouped
}

/** The parent Task tool_use id that groups a sub-agent's messages, or null for main scope. */
function messageParentKey(metadata: Record<string, unknown> | null): string | null {
  if (!metadata || metadata.agent_scope !== 'subagent') return null
  // Older Codex tracking could mistake an `interacted` activity targeting the
  // existing root thread for a newly spawned child. Genuine child paths are
  // below /root (for example /root/reviewer), never /root itself.
  if (metadata.codex_agent_path === '/root') return null
  const parent = metadata.agent_parent_tool_use_id
  return typeof parent === 'string' && parent ? parent : null
}

/**
 * `task_started` / `task_progress` / `task_notification` bubbles ("Subagent
 * started/update/completed") duplicate the AgentGroup header's status and usage, so they
 * are hidden from the transcript. They are still kept in the bucket for status and usage
 * derivation (see deriveAgentMeta).
 */
function isAgentStatusBubble(metadata: Record<string, unknown> | null): boolean {
  return (
    (metadata?.source === 'claude_task' || metadata?.source === 'codex_subagent') &&
    (metadata.task_event === 'started' ||
      metadata.task_event === 'progress' ||
      metadata.task_event === 'notification' ||
      metadata.task_event === 'interacted' ||
      metadata.task_event === 'interrupted')
  )
}

/** Turn a hyphen/underscore agent type into a human-readable label ("general-purpose" → "General Purpose"). */
function humanizeAgentType(type: string): string {
  return type
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/** Derive the display label, description, task id, status and usage for an agent group from its messages' metadata. */
function deriveAgentMeta(bucketMessages: Message[]): {
  label: string
  description?: string
  taskId?: string
  status: AgentStatus
  usage?: AgentGroup['usage']
  lastToolName?: string
} {
  let subagentType: string | undefined
  let description: string | undefined
  let taskId: string | undefined
  let status: AgentStatus = 'running'
  let terminalStatus: AgentStatus | undefined
  let usage: AgentGroup['usage']
  let lastToolName: string | undefined

  for (const msg of bucketMessages) {
    const meta = safeParseJson(msg.metadata)
    if (!meta) continue
    if (typeof meta.agent_subagent_type === 'string' && meta.agent_subagent_type) {
      subagentType = meta.agent_subagent_type
    } else if (typeof meta.subagent_type === 'string' && meta.subagent_type && !subagentType) {
      subagentType = meta.subagent_type
    }
    if (typeof meta.agent_description === 'string' && meta.agent_description) description = meta.agent_description
    if (typeof meta.agent_task_id === 'string' && meta.agent_task_id) taskId = meta.agent_task_id
    if (typeof meta.agent_status === 'string') status = meta.agent_status as AgentStatus
    // A terminal task_notification within the bucket is the authoritative final status.
    if (meta.task_event === 'notification' && typeof meta.status === 'string') {
      terminalStatus = meta.status as AgentStatus
    }
    // task_progress / task_notification carry running usage totals (last one wins —
    // the terminal notification holds the authoritative final totals).
    const u = meta.usage as Record<string, unknown> | undefined
    if (u && typeof u === 'object') {
      usage = {
        totalTokens: typeof u.total_tokens === 'number' ? u.total_tokens : usage?.totalTokens,
        toolUses: typeof u.tool_uses === 'number' ? u.tool_uses : usage?.toolUses,
        durationMs: typeof u.duration_ms === 'number' ? u.duration_ms : usage?.durationMs,
      }
    }
    if (typeof meta.last_tool_name === 'string' && meta.last_tool_name) lastToolName = meta.last_tool_name
  }

  const label = subagentType ? humanizeAgentType(subagentType) : description || 'subagent'
  return { label, description, taskId, status: terminalStatus ?? status, usage, lastToolName }
}

/**
 * Bucket messages by sub-agent (using explicit `agent_*` metadata, never adjacency)
 * and render each bucket as a collapsible AgentGroup, anchored at the Task tool_call
 * that spawned it. Nested sub-agents nest inside their parent group.
 *
 * Implementation: flat-bucket every message by its *immediate* parent tool_use id
 * (all depths at once), then recursively assemble each scope — a bucket's paired
 * entries with child groups spliced in at the Task tool_call that spawned them. A
 * cycle guard + build cache guarantee termination even on malformed metadata.
 */
export function groupByAgent(messages: Message[]): StreamEntry[] {
  const buckets = new Map<string, Message[]>()
  const bucketOrder: string[] = []
  const bucketFirstPosition = new Map<string, number>()
  const messagePosition = new Map<string, number>()
  const mainMessages: Message[] = []

  for (const [position, msg] of messages.entries()) {
    messagePosition.set(msg.id, position)
    const meta = safeParseJson(msg.metadata)
    const parentKey = messageParentKey(meta)
    if (parentKey) {
      let bucket = buckets.get(parentKey)
      if (!bucket) {
        bucket = []
        buckets.set(parentKey, bucket)
        bucketOrder.push(parentKey)
        bucketFirstPosition.set(parentKey, position)
      }
      bucket.push(msg)
    } else {
      mainMessages.push(msg)
    }
  }

  // No sub-agents at all → plain paired list.
  if (buckets.size === 0) {
    const visible = foldMessages(
      mainMessages.filter((message) => !isAgentStatusBubble(safeParseJson(message.metadata)))
    )
    return pairMessages(visible)
  }

  const groupCache = new Map<string, AgentGroup>()
  const building = new Set<string>() // cycle guard for the current assembly path

  const makeGroup = (parentKey: string, anchorInput?: Record<string, unknown>): AgentGroup => {
    const cached = groupCache.get(parentKey)
    if (cached) return cached
    building.add(parentKey)
    const bucketMessages = buckets.get(parentKey) ?? []
    const entries = assemble(bucketMessages)
    building.delete(parentKey)
    const { label, description, taskId, status, usage, lastToolName } = deriveAgentMeta(bucketMessages)
    // The full prompt sent to the sub-agent lives on the spawning Task tool_call's input.
    const prompt = typeof anchorInput?.prompt === 'string'
      ? anchorInput.prompt
      : typeof anchorInput?.message === 'string'
        ? anchorInput.message
        : undefined
    const group: AgentGroup = {
      kind: 'agent',
      key: `agent-${parentKey}`,
      parentToolUseId: parentKey,
      taskId,
      label,
      description,
      prompt,
      status,
      usage,
      lastToolName,
      entries,
    }
    groupCache.set(parentKey, group)
    return group
  }

  // Splice child AgentGroups into a scope's paired entries at their anchor Task tool_call.
  const assemble = (scopeMessages: Message[]): StreamEntry[] => {
    // Hide redundant "Subagent started/completed" status bubbles — the group header shows status.
    // Compact again after bucketing: concurrent agents can interleave their raw
    // deltas, breaking global adjacency even when this agent produced one stream.
    const visible = foldMessages(
      scopeMessages.filter((m) => !isAgentStatusBubble(safeParseJson(m.metadata)))
    )
    const paired = pairMessages(visible)
    const result: StreamEntry[] = []
    for (const entry of paired) {
      if (entry.kind === 'single') {
        const isToolCall = entry.metadata?.type === 'tool_call' || entry.metadata?.type === 'tool_use'
        const anchorId = isToolCall ? (entry.metadata?.id as string | undefined) : undefined
        if (anchorId && buckets.has(anchorId) && !building.has(anchorId)) {
          result.push(makeGroup(anchorId, entry.metadata?.input as Record<string, unknown> | undefined))
          continue
        }
        result.push(entry)
      } else {
        // ToolCallGroupBlock: emit it, then splice any agent groups anchored inside it.
        result.push(entry)
        for (const sub of entry.entries) {
          const anchorId = sub.metadata?.id as string | undefined
          if (anchorId && buckets.has(anchorId) && !building.has(anchorId)) {
            result.push(makeGroup(anchorId, sub.metadata?.input as Record<string, unknown> | undefined))
          }
        }
      }
    }
    return result
  }

  const result = assemble(mainMessages)

  const entryPosition = (entry: StreamEntry): number => {
    if (entry.kind === 'single') return messagePosition.get(entry.message.id) ?? Number.MAX_SAFE_INTEGER
    if (entry.kind === 'group') {
      return entry.entries.length > 0
        ? messagePosition.get(entry.entries[0].message.id) ?? Number.MAX_SAFE_INTEGER
        : Number.MAX_SAFE_INTEGER
    }
    return bucketFirstPosition.get(entry.parentToolUseId) ?? Number.MAX_SAFE_INTEGER
  }

  // If an anchor is absent (restored history, protocol race, or older data),
  // keep the group at the position of its first child event instead of moving
  // it below later main-agent output.
  for (const parentKey of bucketOrder) {
    if (!groupCache.has(parentKey)) {
      const group = makeGroup(parentKey)
      const position = bucketFirstPosition.get(parentKey) ?? Number.MAX_SAFE_INTEGER
      const insertionIndex = result.findIndex((entry) => entryPosition(entry) > position)
      if (insertionIndex === -1) result.push(group)
      else result.splice(insertionIndex, 0, group)
    }
  }

  return result
}

/** Recursively find an AgentGroup by its stable `key`. */
export function findAgentGroup(entries: StreamEntry[], key: string): AgentGroup | null {
  for (const entry of entries) {
    if (entry.kind === 'agent') {
      if (entry.key === key) return entry
      const nested = findAgentGroup(entry.entries, key)
      if (nested) return nested
    }
  }
  return null
}

/** Compact token count: 39777 → "39.8k". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** One-line usage summary for an agent group, e.g. "3 tools · 39.8k tokens" (null if none). */
export function agentStatsLabel(group: AgentGroup): string | null {
  const parts: string[] = []
  const toolUses = group.usage?.toolUses
  if (typeof toolUses === 'number') parts.push(`${toolUses} ${toolUses === 1 ? 'tool' : 'tools'}`)
  const tokens = group.usage?.totalTokens
  if (typeof tokens === 'number' && tokens > 0) parts.push(`${formatTokens(tokens)} tokens`)
  if (group.status === 'running' && group.lastToolName) parts.push(group.lastToolName)
  return parts.length ? parts.join(' · ') : null
}

/** Collect all currently-active (running) agent groups, flattened across nesting. */
export function collectActiveAgents(entries: StreamEntry[]): AgentGroup[] {
  const active: AgentGroup[] = []
  const walk = (list: StreamEntry[]): void => {
    for (const entry of list) {
      if (entry.kind === 'agent') {
        if (entry.status === 'running') active.push(entry)
        walk(entry.entries)
      }
    }
  }
  walk(entries)
  return active
}

export default function MessageStream({ threadId, sessionId, agentFilter, onIsolateAgent }: Props) {
  // Use session-based messages when sessionId is provided, otherwise fall back to thread-based
  const sessionMessages = useMessageStore((s) => sessionId ? s.messagesBySession[sessionId] : undefined)
  const threadMessages = useMessageStore((s) => s.messagesByThread[threadId])
  const messages = sessionMessages ?? threadMessages ?? EMPTY
  const status = useThreadStore((s) => s.statusMap[threadId] ?? 'idle')
  const containerRef = useRef<HTMLDivElement>(null)
  const tailRef = useRef<HTMLDivElement>(null)
  const shouldFollowBottom = useRef(true)
  const lastScrollTopRef = useRef(0)
  const [showLatestButton, setShowLatestButton] = useState(false)
  const [containerWidth, setContainerWidth] = useState<number | null>(null)

  const allEntries = useMemo(() => groupByAgent(messages), [messages])
  const isolatedGroup = useMemo(
    () => (agentFilter ? findAgentGroup(allEntries, agentFilter) : null),
    [allEntries, agentFilter]
  )
  const entries = useMemo(
    () => (isolatedGroup ? isolatedGroup.entries : allEntries),
    [isolatedGroup, allEntries]
  )
  const isStreaming = status === 'running'

  // Compute how many rows to virtualize (all except the tail + current streaming turn)
  const virtualizedRowCount = useMemo(() => {
    const tailStart = Math.max(entries.length - ALWAYS_UNVIRTUALIZED_TAIL_ROWS, 0)

    if (!isStreaming) return tailStart

    // During streaming, also keep the current turn unvirtualized.
    // Walk backwards from the tail to find the user message that started this turn.
    let turnStart = tailStart
    for (let idx = tailStart - 1; idx >= 0; idx--) {
      const e = entries[idx]
      if (e.kind === 'single' && e.message.role === 'user') {
        turnStart = idx
        break
      }
      if (e.kind === 'single' && e.message.role === 'assistant') {
        // Hit a previous assistant message boundary — stop
        break
      }
    }
    return Math.min(turnStart, tailStart)
  }, [entries, isStreaming])

  const nonVirtualizedEntries = useMemo(
    () => entries.slice(virtualizedRowCount),
    [entries, virtualizedRowCount]
  )

  // Track container width for height estimation
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((obs) => {
      const width = obs[0]?.contentRect.width ?? null
      setContainerWidth(width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // TanStack Virtual intentionally returns non-memoizable functions; React Compiler
  // safely skips this component, and replacing the virtualizer would regress long threads.
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: virtualizedRowCount,
    getScrollElement: () => containerRef.current,
    getItemKey: (index: number) => entries[index]?.key ?? index,
    estimateSize: (index: number) => {
      const entry = entries[index]
      if (!entry) return 96
      const cached = heightCache.get(entry.key)
      if (cached != null) return cached
      return estimateEntryHeight(entry, containerWidth)
    },
    overscan: 5,
  })

  // Prevent scroll adjustment when near bottom (avoids jumps during streaming)
  useEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (_item, _delta, instance) => {
      const viewportHeight = instance.scrollRect?.height ?? 0
      const scrollOffset = instance.scrollOffset ?? 0
      const remainingDistance = instance.getTotalSize() - (scrollOffset + viewportHeight)
      return remainingDistance > AUTO_SCROLL_THRESHOLD_PX
    }
    return () => {
      rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined
    }
  }, [rowVirtualizer])

  // Re-measure when container width changes; clear height cache if width shifted significantly
  useEffect(() => {
    if (containerWidth != null) {
      if (
        heightCacheWidth != null &&
        Math.abs(containerWidth - heightCacheWidth) > WIDTH_CHANGE_THRESHOLD
      ) {
        heightCache.clear()
      }
      heightCacheWidth = containerWidth
      rowVirtualizer.measure()
    }
  }, [containerWidth, rowVirtualizer])

  // Reset to "follow bottom" when thread changes
  useEffect(() => {
    shouldFollowBottom.current = true
    lastScrollTopRef.current = 0
    setShowLatestButton(false)
  }, [threadId])

  // After every render, if following bottom, pin scroll there.
  // useLayoutEffect runs synchronously after DOM mutations, so even as the
  // virtualizer re-measures items across multiple frames, each render cycle
  // will chase the correct scrollHeight.
  useLayoutEffect(() => {
    if (!shouldFollowBottom.current) return
    const el = containerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    lastScrollTopRef.current = el.scrollTop
  })

  // Keep non-virtualized tail heights current. Tail rows can change height after
  // initial paint (for example after markdown/code styling settles), and stale
  // cached heights cause overlap once those rows move into the virtualized zone.
  useEffect(() => {
    const el = tailRef.current
    if (!el) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const node = entry.target as HTMLElement
        const key = node.dataset.entryKey
        if (key) {
          // Use the border-box height (includes the wrapper's pb-2 spacing).
          // contentRect excludes padding, which left every row ~8px short once
          // it moved into the virtualized zone — a systematic overlap source.
          const height = entry.borderBoxSize?.[0]?.blockSize ?? node.getBoundingClientRect().height
          if (height > 0) heightCache.set(key, height)
        }
      }
    })

    for (const child of el.children) {
      const node = child as HTMLElement
      const key = node.dataset.entryKey
      if (key) {
        heightCache.set(key, node.getBoundingClientRect().height)
      }
      observer.observe(node)
    }

    return () => observer.disconnect()
  }, [nonVirtualizedEntries])

  // NOTE: there used to be a requestAnimationFrame(rowVirtualizer.measure())
  // pass here that re-ran whenever entries.length / virtualizedRowCount changed.
  // That was the main overlap bug: measure() discards every real DOM
  // measurement, and mounted rows are NOT re-measured afterwards (their
  // ResizeObservers only fire on actual size changes, and measureElement refs
  // only fire on mount). So on every new message, mounted rows silently fell
  // back to heightCache estimates — an underestimated long row then overlapped
  // the rows below it until it was scrolled out of overscan and remounted.
  // Mount-time measureElement + TanStack's per-element ResizeObserver already
  // cover fresh rows and later size changes; the only measure() we still need
  // is the width-change one above.

  const measureVirtualRow = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    rowVirtualizer.measureElement(node)

    const key = node.dataset.entryKey
    if (!key) return

    // Persist only real DOM measurements. Do not copy virtualizer item sizes into
    // heightCache: those can still be estimates, and caching an underestimate is
    // what causes long rows to overlap following rows after a thread switch.
    const cacheHeight = () => {
      const height = node.getBoundingClientRect().height
      if (height > 0) heightCache.set(key, height)
    }
    cacheHeight()
    requestAnimationFrame(cacheHeight)
  }, [rowVirtualizer])

  function handleScroll(): void {
    const el = containerRef.current
    if (!el) return
    const prevScrollTop = lastScrollTopRef.current
    lastScrollTopRef.current = el.scrollTop
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AUTO_SCROLL_THRESHOLD_PX
    if (atBottom) {
      shouldFollowBottom.current = true
    } else if (el.scrollTop < prevScrollTop - 1) {
      // Only an upward scroll can disengage follow-bottom. While following, the
      // only things that move scrollTop are our own pin (always to the bottom),
      // browser clamping (also always to the bottom), and the user scrolling
      // up. Scroll events caused by layout jumps — row re-measurement, a tool
      // group collapsing, a long message popping in — leave scrollTop in place
      // while scrollHeight changes, so they can no longer kick the view out of
      // follow mode; the follow-bottom layout effect re-pins on the next render.
      shouldFollowBottom.current = false
    }
    setShowLatestButton(!atBottom && !shouldFollowBottom.current)
  }

  const scrollToBottom = useCallback(() => {
    shouldFollowBottom.current = true
    setShowLatestButton(false)
    const el = containerRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
      lastScrollTopRef.current = el.scrollTop
    }
  }, [])

  const virtualRows = rowVirtualizer.getVirtualItems()

  return (
    <div className="relative flex-1 overflow-hidden" style={{ background: 'var(--color-bg)' }}>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto px-4 py-4"
        // Scroll anchoring fights manual bottom-pinning and translateY-positioned
        // virtual rows — the browser "helpfully" adjusts scrollTop on layout
        // jumps, firing scroll events we didn't cause.
        style={{ overflowAnchor: 'none' }}
      >
        {messages.length === 0 && (
          <p className="text-center text-xs pt-8" style={{ color: 'var(--color-text-muted)' }}>
            No messages yet. Send a message to get started.
          </p>
        )}

        {/* Isolated sub-agent header: label, description, and the full prompt it was given */}
        {isolatedGroup && (
          <div className="mb-3 pb-3" style={{ borderBottom: '1px solid var(--color-border)' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.6rem', fontWeight: 600, letterSpacing: '0.06em', color: 'var(--color-text-muted)' }}>SUBAGENT</span>
              <span className="font-mono" style={{ fontSize: '0.8rem', color: 'var(--color-claude)' }}>{isolatedGroup.label}</span>
              {isolatedGroup.description && (
                <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>{isolatedGroup.description}</span>
              )}
              {agentStatsLabel(isolatedGroup) && (
                <span style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)', opacity: 0.85, marginLeft: 'auto' }}>
                  {agentStatsLabel(isolatedGroup)}
                </span>
              )}
            </div>
            {isolatedGroup.prompt && (
              <div style={{ marginTop: 6 }}>
                <AgentPrompt prompt={isolatedGroup.prompt} defaultOpen />
              </div>
            )}
          </div>
        )}

        {/* Virtualized rows (historical messages) */}
        {virtualizedRowCount > 0 && (
          <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
            {virtualRows.map((virtualRow) => {
              const entry = entries[virtualRow.index]
              if (!entry) return null
              return (
                <div
                  key={`v:${entry.key}`}
                  data-index={virtualRow.index}
                  data-entry-key={entry.key}
                  ref={measureVirtualRow}
                  className="absolute left-0 top-0 w-full pb-2"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  {renderEntry(entry, { onIsolateAgent })}
                </div>
              )
            })}
          </div>
        )}

        {/* Non-virtualized tail (recent messages + current turn) */}
        <div ref={tailRef}>
          {nonVirtualizedEntries.map((entry) => (
            <div key={entry.key} data-entry-key={entry.key} className="pb-2">
              {renderEntry(entry, { onIsolateAgent })}
            </div>
          ))}
        </div>

        {/* Streaming indicator */}
        {isStreaming && (
          <div className="flex items-center gap-2 py-1 pl-1">
            <span className="flex gap-1">
              <span className="streaming-dot" style={{ animationDelay: '0ms' }} />
              <span className="streaming-dot" style={{ animationDelay: '160ms' }} />
              <span className="streaming-dot" style={{ animationDelay: '320ms' }} />
            </span>
          </div>
        )}

      </div>

      {showLatestButton && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 right-4 rounded-full px-3 py-1.5 text-xs font-medium shadow-lg transition-opacity hover:opacity-90"
          style={{ background: 'var(--color-claude)', color: '#fff' }}
        >
          ↓ Latest
        </button>
      )}
    </div>
  )
}
