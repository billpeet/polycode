import { useEffect, useRef } from 'react'
import { useMessageStore } from '../stores/messages'
import MessageBubble from './MessageBubble'
import { Message } from '../types/ipc'

interface Props {
  threadId: string
}

const EMPTY: Message[] = []

export default function MessageStream({ threadId }: Props) {
  const messages = useMessageStore((s) => s.messagesByThread[threadId] ?? EMPTY)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  return (
    <div
      className="flex-1 overflow-y-auto px-4 py-4 space-y-2"
      style={{ background: 'var(--color-bg)' }}
    >
      {messages.length === 0 && (
        <p className="text-center text-xs pt-8" style={{ color: 'var(--color-text-muted)' }}>
          No messages yet. Start the session and send a message.
        </p>
      )}
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      <div ref={bottomRef} />
    </div>
  )
}
