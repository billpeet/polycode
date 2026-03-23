import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useMessageStore } from '../stores/messages'
import { useThreadStore } from '../stores/threads'
import MessageBubble from './MessageBubble'
import ToolCallGroupBlock from './ToolCallGroupBlock'
import { Message } from '../types/ipc'
import { estimateEntryHeight } from '../lib/messageHeight'

interface Props {
  threadId: string
  sessionId?: string
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

/** Tools that can be grouped together (mapped to a shared group key). */
const TOOL_GROUP_KEY: Record<string, string> = {
  Read: 'file-access',
  Glob: 'file-access',
  Grep: 'file-access',
  WebSearch: 'web-access',
  WebFetch: 'web-access',
}

function getToolGroupKey(toolName: string): string {
  return TOOL_GROUP_KEY[toolName] ?? toolName
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
    const groupKey = getToolGroupKey(toolName)
    const entryStatus = getEntryStatus(entry)
    // Find the run of consecutive tool entries that share the same group key and status
    let j = i + 1
    while (
      j < flat.length &&
      (flat[j].metadata?.type === 'tool_call' || flat[j].metadata?.type === 'tool_use') &&
      getToolGroupKey((flat[j].metadata?.name as string) ?? flat[j].message.content) === groupKey &&
      getEntryStatus(flat[j]) === entryStatus
    ) {
      j++
    }
    const runLength = j - i
    if (runLength > GROUP_THRESHOLD) {
      const groupEntries = flat.slice(i, j)
      // For mixed groups (different tools sharing a group key), use the group key as display name
      const uniqueTools = new Set(groupEntries.map((e) => (e.metadata?.name as string) ?? e.message.content))
      const displayName = uniqueTools.size > 1 ? groupKey : toolName
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

function renderEntry(entry: MessageEntry | MessageGroup) {
  return entry.kind === 'group' ? (
    <ToolCallGroupBlock group={entry} />
  ) : (
    <MessageBubble entry={entry} />
  )
}

export default function MessageStream({ threadId, sessionId }: Props) {
  // Use session-based messages when sessionId is provided, otherwise fall back to thread-based
  const sessionMessages = useMessageStore((s) => sessionId ? s.messagesBySession[sessionId] : undefined)
  const threadMessages = useMessageStore((s) => s.messagesByThread[threadId])
  const messages = sessionMessages ?? threadMessages ?? EMPTY
  const status = useThreadStore((s) => s.statusMap[threadId] ?? 'idle')
  const containerRef = useRef<HTMLDivElement>(null)
  const tailRef = useRef<HTMLDivElement>(null)
  const shouldFollowBottom = useRef(true)
  const [showLatestButton, setShowLatestButton] = useState(false)
  const [containerWidth, setContainerWidth] = useState<number | null>(null)

  const entries = useMemo(() => pairMessages(messages), [messages])
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

  const nonVirtualizedEntries = entries.slice(virtualizedRowCount)

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
  })

  // Measure non-virtualized tail items after render and store in height cache.
  // These items have no virtualizer measureElement ref, so without this they'd
  // rely purely on the heuristic estimate when they later enter the virtualized zone.
  useLayoutEffect(() => {
    const el = tailRef.current
    if (!el) return
    for (const child of el.children) {
      const key = (child as HTMLElement).dataset.entryKey
      if (key) {
        heightCache.set(key, (child as HTMLElement).offsetHeight)
      }
    }
  })

  // Back up virtualizer ResizeObserver-driven measurements into the persistent cache.
  // This runs on every render so that if TanStack corrects a size via its internal
  // ResizeObserver, we capture it before a future measure() call wipes itemSizeCache.
  useEffect(() => {
    for (const item of rowVirtualizer.getVirtualItems()) {
      const entry = entries[item.index]
      if (entry) {
        heightCache.set(entry.key, item.size)
      }
    }
  })

  function handleScroll(): void {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AUTO_SCROLL_THRESHOLD_PX
    shouldFollowBottom.current = atBottom
    setShowLatestButton(!atBottom)
  }

  const scrollToBottom = useCallback(() => {
    shouldFollowBottom.current = true
    setShowLatestButton(false)
    const el = containerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  const virtualRows = rowVirtualizer.getVirtualItems()

  return (
    <div className="relative flex-1 overflow-hidden" style={{ background: 'var(--color-bg)' }}>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto px-4 py-4"
      >
        {messages.length === 0 && (
          <p className="text-center text-xs pt-8" style={{ color: 'var(--color-text-muted)' }}>
            No messages yet. Send a message to get started.
          </p>
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
                  ref={rowVirtualizer.measureElement}
                  className="absolute left-0 top-0 w-full pb-2"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  {renderEntry(entry)}
                </div>
              )
            })}
          </div>
        )}

        {/* Non-virtualized tail (recent messages + current turn) */}
        <div ref={tailRef}>
          {nonVirtualizedEntries.map((entry) => (
            <div key={entry.key} data-entry-key={entry.key} className="pb-2">
              {renderEntry(entry)}
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
