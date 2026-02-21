import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useMessageStore } from '../stores/messages'
import { useThreadStore } from '../stores/threads'
import MessageBubble from './MessageBubble'
import { Message } from '../types/ipc'

interface Props {
  threadId: string
}

const EMPTY: Message[] = []

function safeParseJson(str: string | null): Record<string, unknown> | null {
  if (!str) return null
  try { return JSON.parse(str) } catch { return null }
}

export interface MessageEntry {
  key: string
  message: Message
  metadata: Record<string, unknown> | null
  result: Message | null
  resultMetadata: Record<string, unknown> | null
}

/** Pair tool_call messages with their matching tool_result by tool_use_id. */
function pairMessages(messages: Message[]): MessageEntry[] {
  // Build a lookup of tool_result messages by tool_use_id
  const resultByToolUseId = new Map<string, Message>()
  for (const msg of messages) {
    const meta = safeParseJson(msg.metadata)
    if (meta?.type === 'tool_result') {
      const id = meta.tool_use_id as string | undefined
      if (id) resultByToolUseId.set(id, msg)
    }
  }

  const entries: MessageEntry[] = []
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
      entries.push({
        key: msg.id,
        message: msg,
        metadata: meta,
        result,
        resultMetadata: safeParseJson(result?.metadata ?? null),
      })
    } else {
      entries.push({
        key: msg.id,
        message: msg,
        metadata: meta,
        result: null,
        resultMetadata: null,
      })
    }
  }

  return entries
}

export default function MessageStream({ threadId }: Props) {
  const messages = useMessageStore((s) => s.messagesByThread[threadId] ?? EMPTY)
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
        {entries.map((entry) => (
          <MessageBubble key={entry.key} entry={entry} />
        ))}

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
