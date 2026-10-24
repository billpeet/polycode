import { useSessionStore, EMPTY_SESSIONS } from '../stores/sessions'

interface Props {
  threadId: string
}

export default function SessionTabs({ threadId }: Props) {
  const sessions = useSessionStore((s) => s.sessionsByThread[threadId] ?? EMPTY_SESSIONS)
  const activeSessionId = useSessionStore((s) => s.activeSessionByThread[threadId])
  const switchSession = useSessionStore((s) => s.switchSession)

  // Don't show tabs if only one session
  if (sessions.length <= 1) {
    return null
  }

  return (
    <div
      className="flex items-center gap-1 px-4 py-2 overflow-x-auto"
      style={{
        borderBottom: '1px solid var(--color-border)',
        background: 'var(--color-surface)'
      }}
    >
      {sessions.map((session) => {
        const isActive = session.id === activeSessionId
        return (
          <button
            key={session.id}
            onClick={() => {
              if (!isActive) {
                switchSession(threadId, session.id)
              }
            }}
            className="px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap"
            style={{
              background: isActive ? 'color-mix(in srgb, var(--color-accent) 15%, transparent)' : 'transparent',
              color: isActive ? 'var(--color-accent)' : 'var(--color-text-muted)',
              border: `1px solid ${isActive ? 'color-mix(in srgb, var(--color-accent) 30%, transparent)' : 'var(--color-border)'}`
            }}
          >
            {session.name}
          </button>
        )
      })}
    </div>
  )
}
