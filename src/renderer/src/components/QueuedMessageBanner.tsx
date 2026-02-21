import { useThreadStore, QueuedMessage } from '../stores/threads'
import { useMessageStore } from '../stores/messages'
import { useProjectStore } from '../stores/projects'
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

  const projects = useProjectStore((s) => s.projects)
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const project = projects.find((p) => p.id === selectedProjectId)

  const handleCancel = () => {
    clearQueue(threadId)
  }

  const handleInterrupt = async () => {
    if (!project) return

    // Stop current session
    await stop(threadId)

    // Wait a tick for stop to process, then send queued message
    setTimeout(async () => {
      const msg = queuedMessage
      clearQueue(threadId)

      // Append optimistic user message to the correct store based on active session
      const activeSessionId = useSessionStore.getState().activeSessionByThread[threadId]
      if (activeSessionId) {
        useMessageStore.getState().appendUserMessageToSession(activeSessionId, threadId, msg.content)
      } else {
        appendUserMessage(threadId, msg.content)
      }

      await send(threadId, msg.content, project.path, { planMode: msg.planMode })
    }, 100)
  }

  return (
    <div
      className="mb-3 flex items-start gap-3 rounded-xl px-4 py-3"
      style={{
        background: 'linear-gradient(135deg, rgba(168, 85, 247, 0.15) 0%, rgba(168, 85, 247, 0.08) 100%)',
        border: '1px solid rgba(168, 85, 247, 0.3)',
      }}
    >
      <div
        className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg"
        style={{ background: 'rgba(168, 85, 247, 0.2)' }}
      >
        <QueueIcon className="text-purple-400" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
            Message queued
          </span>
          {queuedMessage.planMode && (
            <span
              className="rounded px-1.5 py-0.5 text-xs font-medium"
              style={{ background: 'rgba(232, 123, 95, 0.2)', color: 'var(--color-claude)' }}
            >
              Plan
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
            background: 'linear-gradient(135deg, #a855f7 0%, #9333ea 100%)',
            color: '#fff',
            boxShadow: '0 2px 8px rgba(168, 85, 247, 0.3)',
          }}
        >
          Interrupt & Send
        </button>
      </div>
    </div>
  )
}
