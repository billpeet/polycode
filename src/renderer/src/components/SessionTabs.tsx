import { useSessionStore, EMPTY_SESSIONS } from '../stores/sessions'
import { useProjectStore } from '../stores/projects'

interface Props {
  threadId: string
}

export default function SessionTabs({ threadId }: Props) {
  const sessions = useSessionStore((s) => s.sessionsByThread[threadId] ?? EMPTY_SESSIONS)
  const activeSessionId = useSessionStore((s) => s.activeSessionByThread[threadId])
  const switchSession = useSessionStore((s) => s.switchSession)

  const projects = useProjectStore((s) => s.projects)
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const project = projects.find((p) => p.id === selectedProjectId)

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
              if (project && !isActive) {
                switchSession(threadId, session.id, project.path)
              }
            }}
            className="px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap"
            style={{
              background: isActive ? 'rgba(232, 123, 95, 0.15)' : 'transparent',
              color: isActive ? 'var(--color-claude)' : 'var(--color-text-muted)',
              border: `1px solid ${isActive ? 'rgba(232, 123, 95, 0.3)' : 'var(--color-border)'}`
            }}
          >
            {session.name}
          </button>
        )
      })}
    </div>
  )
}
