import { useEffect, useRef, useState, useCallback } from 'react'
import { useMessageStore } from '../stores/messages'
import { useThreadStore } from '../stores/threads'
import MessageBubble from './MessageBubble'
import { Message } from '../types/ipc'

interface Props {
  threadId: string
}

const EMPTY: Message[] = []

export default function MessageStream({ threadId }: Props) {
  const messages = useMessageStore((s) => s.messagesByThread[threadId] ?? EMPTY)
  const status = useThreadStore((s) => s.statusMap[threadId] ?? 'idle')
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [userScrolled, setUserScrolled] = useState(false)
  const isScrolledToBottom = useRef(true)

  const scrollToBottom = useCallback((smooth = true) => {
    bottomRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'instant' })
    setUserScrolled(false)
    isScrolledToBottom.current = true
  }, [])

  // Detect user scrolling up
  function handleScroll(): void {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    isScrolledToBottom.current = atBottom
    setUserScrolled(!atBottom)
  }

  // Auto-scroll on new messages unless user has scrolled up
  useEffect(() => {
    if (!userScrolled) {
      scrollToBottom(messages.length <= 1)
    }
  }, [messages.length, userScrolled, scrollToBottom])

  // Scroll to bottom instantly when switching threads
  useEffect(() => {
    setUserScrolled(false)
    scrollToBottom(false)
  }, [threadId, scrollToBottom])

  const lastMessage = messages[messages.length - 1]
  const isAwaitingResponse = status === 'running' && lastMessage?.role === 'user'

  return (
    <div className="relative flex-1 overflow-hidden" style={{ background: 'var(--color-bg)' }}>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto px-4 py-4 space-y-2"
      >
        {messages.length === 0 && (
          <p className="text-center text-xs pt-8" style={{ color: 'var(--color-text-muted)' }}>
            No messages yet. Start the session and send a message.
          </p>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
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

      {/* Scroll-to-bottom button */}
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
