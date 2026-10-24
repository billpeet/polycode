import { useThreadStore, QueuedMessage } from '../stores/threads'
import { useMessageStore } from '../stores/messages'
import { useSessionStore } from '../stores/sessions'

interface Props {
  threadId: string
  queuedMessage: QueuedMessage
}

function QueueIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  )
}

export default function QueuedMessageBanner({ threadId, queuedMessage }: Props) {
  const clearQueue = useThreadStore((s) => s.clearQueue)
  const stop = useThreadStore((s) => s.stop)
  const send = useThreadStore((s) => s.send)
  const appendUserMessage = useMessageStore((s) => s.appendUserMessage)

  const handleCancel = () => {
    clearQueue(threadId)
  }

  const handleInterrupt = async () => {
    // Stop current session
    await stop(threadId)

    // Wait a tick for stop to process, then send queued message
    setTimeout(async () => {
      const msg = queuedMessage
      clearQueue(threadId)

      // Append optimistic user message to the correct store based on active session
      const activeSessionId = useSessionStore.getState().activeSessionByThread[threadId]
      if (activeSessionId) {
        useMessageStore.getState().appendUserMessageToSession(activeSessionId, threadId, msg.content, msg.options.clientUserMessageId)
      } else {
        appendUserMessage(threadId, msg.content, msg.options.clientUserMessageId)
      }

      await send(threadId, msg.content, msg.options)
    }, 100)
  }

  return (
    <div
      className="mb-3 flex items-start gap-3 rounded-xl px-4 py-3"
      style={{
        background: 'linear-gradient(135deg, color-mix(in srgb, var(--color-purple) 15%, transparent) 0%, color-mix(in srgb, var(--color-purple) 8%, transparent) 100%)',
        border: '1px solid color-mix(in srgb, var(--color-purple) 30%, transparent)',
      }}
    >
      <div
        className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg"
        style={{ background: 'color-mix(in srgb, var(--color-purple) 20%, transparent)' }}
      >
        <QueueIcon className="text-purple" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
            Message queued
          </span>
          {queuedMessage.options.planMode && (
            <span
              className="rounded px-1.5 py-0.5 text-xs font-medium"
              style={{ background: 'color-mix(in srgb, var(--color-accent) 20%, transparent)', color: 'var(--color-accent)' }}
            >
              Plan
            </span>
          )}
          {queuedMessage.options.fastMode && (
            <span
              className="rounded px-1.5 py-0.5 text-xs font-medium"
              style={{ background: 'color-mix(in srgb, var(--color-orange) 20%, transparent)', color: 'var(--color-orange)' }}
            >
              Fast
            </span>
          )}
        </div>
        <div
          className="truncate text-xs"
          style={{ color: 'var(--color-text-muted)', maxWidth: '100%' }}
          title={queuedMessage.content}
        >
          {queuedMessage.content.length > 100
            ? queuedMessage.content.slice(0, 100) + '...'
            : queuedMessage.content}
        </div>
      </div>

      <div className="flex flex-shrink-0 items-center gap-2">
        <button
          onClick={handleCancel}
          className="rounded-lg px-3 py-1.5 text-xs font-medium transition-all hover:opacity-80"
          style={{
            background: 'transparent',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text-muted)',
          }}
        >
          Cancel
        </button>
        <button
          onClick={handleInterrupt}
          className="rounded-lg px-3 py-1.5 text-xs font-medium transition-all hover:scale-105"
          style={{
            background: 'linear-gradient(135deg, var(--color-purple) 0%, var(--color-purple-strong) 100%)',
            color: 'var(--color-on-accent)',
            boxShadow: '0 2px 8px color-mix(in srgb, var(--color-purple) 30%, transparent)',
          }}
        >
          Interrupt & Send
        </button>
      </div>
    </div>
  )
}
