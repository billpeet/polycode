import { useThreadStore } from '../../stores/threads'
import { Todo, useTodoStore } from '../../stores/todos'
import { SectionHeader } from './shared'

const EMPTY_TODOS: Todo[] = []

function StatusIcon({ status }: { status: Todo['status'] }) {
  if (status === 'completed') {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: 'rgba(74, 222, 128, 0.15)',
          border: '1.5px solid #4ade80',
          color: '#4ade80',
          fontSize: '0.55rem',
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        ✓
      </span>
    )
  }

  if (status === 'in_progress') {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 16,
          height: 16,
          flexShrink: 0,
        }}
      >
        <span className="streaming-dot" style={{ background: 'var(--color-claude)', width: 7, height: 7 }} />
      </span>
    )
  }

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 16,
        height: 16,
        borderRadius: '50%',
        border: '1.5px solid var(--color-border)',
        flexShrink: 0,
      }}
    />
  )
}

export default function TasksSection({
  threadId,
  collapsed,
  onToggle,
}: {
  threadId: string
  collapsed: boolean
  onToggle: () => void
}) {
  const todos = useTodoStore((s) => s.todosByThread[threadId] ?? EMPTY_TODOS)
  const threadStatus = useThreadStore((s) => s.statusMap[threadId] ?? 'idle')
  const completed = todos.filter((t) => t.status === 'completed').length
  const total = todos.length
  const hasInProgress = todos.some((t) => t.status === 'in_progress')

  const badge = total > 0 ? `${completed}/${total}` : undefined
  const showProgressBar = collapsed && total > 0 && threadStatus === 'running'
  const progress = total > 0 ? (completed / total) * 100 : 0

  return (
    <div className="flex-shrink-0">
      <SectionHeader
        label="Tasks"
        collapsed={collapsed}
        onToggle={onToggle}
        badge={badge}
        badgeActive={hasInProgress}
      />
      {showProgressBar && (
        <div style={{ height: 2, background: 'var(--color-border)' }}>
          <div
            style={{
              height: '100%',
              width: `${progress}%`,
              background: hasInProgress ? 'var(--color-claude)' : '#4ade80',
              transition: 'width 0.4s ease',
            }}
          />
        </div>
      )}
      {!collapsed && (
        <div>
          {todos.length === 0 ? (
            <p className="px-4 py-6 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
              No tasks yet.
            </p>
          ) : (
            <ul className="px-3 space-y-0.5 py-2">
              {todos.map((todo, idx) => (
                <li
                  key={idx}
                  className="flex items-start gap-2.5 rounded px-2 py-1.5"
                  style={{
                    background: todo.status === 'in_progress' ? 'rgba(232, 123, 95, 0.07)' : 'transparent',
                    opacity: todo.status === 'completed' ? 0.45 : 1,
                    transition: 'opacity 0.2s, background 0.2s',
                  }}
                >
                  <StatusIcon status={todo.status} />
                  <span
                    className="text-xs leading-relaxed min-w-0 break-words"
                    style={{
                      color: 'var(--color-text)',
                      textDecoration: todo.status === 'completed' ? 'line-through' : 'none',
                    }}
                  >
                    {todo.status === 'in_progress' ? todo.activeForm : todo.content}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
