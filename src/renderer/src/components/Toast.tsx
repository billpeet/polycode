import { useToastStore, Toast } from '../stores/toast'

function ToastItem({ toast }: { toast: Toast }) {
  const remove = useToastStore((s) => s.remove)

  const bg =
    toast.type === 'error'
      ? '#dc2626'
      : toast.type === 'success'
        ? '#16a34a'
        : 'var(--color-surface-2)'

  const color = toast.type === 'info' ? 'var(--color-text)' : '#fff'

  const icon = toast.type === 'error' ? '✕' : toast.type === 'success' ? '✓' : 'ℹ'

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        maxWidth: '320px',
        padding: '0.5rem 0.75rem',
        borderRadius: '9999px',
        background: bg,
        color,
        fontSize: '0.8rem',
        fontWeight: 500,
        boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        animation: 'toast-in 0.18s ease',
      }}
    >
      <span style={{ flexShrink: 0, opacity: 0.85 }}>{icon}</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {toast.message}
      </span>
      <button
        onClick={() => remove(toast.id)}
        style={{
          flexShrink: 0,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: 'inherit',
          opacity: 0.7,
          fontSize: '0.75rem',
          lineHeight: 1,
          padding: '0 2px',
        }}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  )
}

export default function ToastStack() {
  const toasts = useToastStore((s) => s.toasts)

  if (toasts.length === 0) return null

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '1rem',
        right: '1rem',
        zIndex: 100,
        display: 'flex',
        flexDirection: 'column-reverse',
        gap: '0.5rem',
        pointerEvents: 'none',
      }}
    >
      {toasts.map((t) => (
        <div key={t.id} style={{ pointerEvents: 'auto' }}>
          <ToastItem toast={t} />
        </div>
      ))}
    </div>
  )
}
