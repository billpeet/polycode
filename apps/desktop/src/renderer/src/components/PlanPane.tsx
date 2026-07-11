import { usePlanStore } from '../stores/plans'
import MarkdownContent from './MarkdownContent'

export default function PlanPane({ threadId }: { threadId: string }) {
  const plan = usePlanStore((s) => s.planByThread[threadId] ?? null)
  const setVisible = usePlanStore((s) => s.setVisible)

  if (!plan) {
    return (
      <div className="flex items-center justify-center h-full text-xs" style={{ color: 'var(--color-text-muted)' }}>
        No plan file loaded.
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2 flex-shrink-0 border-b"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-claude)', flexShrink: 0 }}>
            <rect x="3" y="1" width="10" height="14" rx="1" />
            <path d="M6 4h4M6 7h4M6 10h2" />
          </svg>
          <span
            className="text-xs font-medium truncate"
            style={{ color: 'var(--color-text)' }}
            title={plan.path}
          >
            {plan.name}
          </span>
        </div>
        <button
          onClick={() => setVisible(threadId, false)}
          className="rounded p-0.5 hover:opacity-70 transition-opacity flex-shrink-0"
          style={{ color: 'var(--color-text-muted)', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 }}
          title="Close plan viewer"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div
        className="flex-1 overflow-y-auto px-4 py-3"
        style={{ background: 'var(--color-bg)' }}
      >
        <MarkdownContent content={plan.content} />
      </div>
    </div>
  )
}
