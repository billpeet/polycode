import { useTodoStore, Todo } from '../stores/todos'

const EMPTY_TODOS: Todo[] = []

interface Props {
  threadId: string
}

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
        <span
          className="streaming-dot"
          style={{ background: 'var(--color-claude)', width: 7, height: 7 }}
        />
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

export default function TodoPanel({ threadId }: Props) {
  const todos = useTodoStore((s) => s.todosByThread[threadId] ?? EMPTY_TODOS)
  const completed = todos.filter((t) => t.status === 'completed').length
  const total = todos.length

  return (
    <aside
      className="flex w-64 flex-shrink-0 flex-col border-l overflow-hidden"
      style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
    >
      <div
        className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <span className="text-xs font-semibold" style={{ color: 'var(--color-text)' }}>
          Tasks
        </span>
        {total > 0 && (
          <span className="text-xs tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
            {completed}/{total}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {todos.length === 0 ? (
          <p className="px-4 py-8 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
            No tasks yet.
          </p>
        ) : (
          <ul className="px-3 space-y-0.5 py-2">
            {todos.map((todo, idx) => (
              <li
                key={idx}
                className="flex items-start gap-2.5 rounded px-2 py-2"
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
    </aside>
  )
}
