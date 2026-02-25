import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useMessageStore } from '../stores/messages'
import { useThreadStore } from '../stores/threads'
import MessageBubble from './MessageBubble'
import ToolCallGroupBlock from './ToolCallGroupBlock'
import { Message } from '../types/ipc'

interface Props {
  threadId: string
  sessionId?: string
}

const EMPTY: Message[] = []
const GROUP_THRESHOLD = 3

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

export default function MessageStream({ threadId, sessionId }: Props) {
  // Use session-based messages when sessionId is provided, otherwise fall back to thread-based
  const sessionMessages = useMessageStore((s) => sessionId ? s.messagesBySession[sessionId] : undefined)
  const threadMessages = useMessageStore((s) => s.messagesByThread[threadId])
  const messages = sessionMessages ?? threadMessages ?? EMPTY
  const status = useThreadStore((s) => s.statusMap[threadId] ?? 'idle')
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [userScrolled, setUserScrolled] = useState(false)
  const isScrolledToBottom = useRef(true)

  const entries = useMemo(() => pairMessages(messages), [messages])

  const scrollToBottom = useCallback((smooth = true) => {
    bottomRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'instant' })
    setUserScrolled(false)
    isScrolledToBottom.current = true
  }, [])

  function handleScroll(): void {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    isScrolledToBottom.current = atBottom
    setUserScrolled(!atBottom)
  }

  useEffect(() => {
    if (!userScrolled) {
      scrollToBottom(messages.length <= 1)
    }
  }, [messages.length, userScrolled, scrollToBottom])

  useEffect(() => {
    setUserScrolled(false)
    scrollToBottom(false)
  }, [threadId, scrollToBottom])

  const isAwaitingResponse = status === 'running'

  return (
    <div className="relative flex-1 overflow-hidden" style={{ background: 'var(--color-bg)' }}>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto px-4 py-4 space-y-2"
      >
        {messages.length === 0 && (
          <p className="text-center text-xs pt-8" style={{ color: 'var(--color-text-muted)' }}>
            No messages yet. Send a message to get started.
          </p>
        )}
        {entries.map((entry) =>
          entry.kind === 'group' ? (
            <ToolCallGroupBlock key={entry.key} group={entry} />
          ) : (
            <MessageBubble key={entry.key} entry={entry} />
          )
        )}

        {/* Streaming indicator */}
        {isAwaitingResponse && (
          <div className="flex items-center gap-2 py-1 pl-1">
            <span className="flex gap-1">
              <span className="streaming-dot" style={{ animationDelay: '0ms' }} />
              <span className="streaming-dot" style={{ animationDelay: '160ms' }} />
              <span className="streaming-dot" style={{ animationDelay: '320ms' }} />
            </span>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {userScrolled && (
        <button
          onClick={() => scrollToBottom(true)}
          className="absolute bottom-4 right-4 rounded-full px-3 py-1.5 text-xs font-medium shadow-lg transition-opacity hover:opacity-90"
          style={{ background: 'var(--color-claude)', color: '#fff' }}
        >
          ↓ Latest
        </button>
      )}
    </div>
  )
}
