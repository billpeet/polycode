import type { Dispatch, SetStateAction } from 'react'
import { Question, PermissionRequest, RepoLocation } from '../../types/ipc'
import { PlanIcon, QuestionIcon } from './icons'

export function MissingLocationBanner({ location }: { location: RepoLocation }) {
  return (
    <div
      className="mb-3 flex items-center gap-2 rounded-lg px-3 py-2 text-xs"
      style={{
        background: 'rgba(248, 113, 113, 0.1)',
        border: '1px solid rgba(248, 113, 113, 0.3)',
        color: '#f87171',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span>
        Directory not found: <span className="font-mono">{location.path}</span>
        {' '} - update the location or restore the directory.
      </span>
    </div>
  )
}

export function CliUnavailableBanner({
  status,
  error,
}: {
  status?: 'unavailable' | 'error'
  error?: string
}) {
  return (
    <div
      className="mb-3 flex items-center gap-2 rounded-lg px-3 py-2 text-xs"
      style={{
        background: 'rgba(248, 113, 113, 0.1)',
        border: '1px solid rgba(248, 113, 113, 0.3)',
        color: '#f87171',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span>
        {status === 'error'
          ? `CLI health check failed: ${error ?? 'unknown error'}`
          : 'CLI not found for this provider - install it or switch to a different provider.'}
      </span>
    </div>
  )
}

export function ErrorBanner() {
  return (
    <div
      className="mb-3 flex items-center gap-2 rounded-lg px-3 py-2 text-xs"
      style={{
        background: 'rgba(248, 113, 113, 0.1)',
        border: '1px solid rgba(248, 113, 113, 0.3)',
        color: '#f87171',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      Session error. Try sending a new message to restart.
    </div>
  )
}

export function PlanBanner({
  threadId,
  onReject,
  onApprove,
  onNewContext,
}: {
  threadId: string
  onReject: (threadId: string) => void
  onApprove: (threadId: string) => void
  onNewContext: (threadId: string) => void
}) {
  return (
    <div
      className="mb-3 flex items-center justify-between rounded-xl px-4 py-3"
      style={{
        background: 'linear-gradient(135deg, rgba(232, 123, 95, 0.15) 0%, rgba(232, 123, 95, 0.08) 100%)',
        border: '1px solid rgba(232, 123, 95, 0.3)',
      }}
    >
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: 'rgba(232, 123, 95, 0.2)' }}>
          <PlanIcon className="text-[var(--color-claude)]" />
        </div>
        <div>
          <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
            Plan ready for review
          </div>
          <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            Review the plan above, then approve or reject
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onReject(threadId)}
          className="rounded-lg px-3 py-1.5 text-xs font-medium transition-all hover:opacity-80"
          style={{ background: 'transparent', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}
        >
          Reject
        </button>
        <button
          onClick={() => onNewContext(threadId)}
          className="rounded-lg px-3 py-1.5 text-xs font-medium transition-all hover:scale-105"
          style={{ background: 'transparent', border: '1px solid var(--color-claude)', color: 'var(--color-claude)' }}
          title="Execute in a fresh Claude session, keeping this planning session as a tab"
        >
          New Context
        </button>
        <button
          onClick={() => onApprove(threadId)}
          className="rounded-lg px-4 py-1.5 text-xs font-medium transition-all hover:scale-105"
          style={{
            background: 'linear-gradient(135deg, var(--color-claude) 0%, #d06a50 100%)',
            color: '#fff',
            boxShadow: '0 2px 8px rgba(232, 123, 95, 0.3)',
          }}
        >
          Approve & Execute
        </button>
      </div>
    </div>
  )
}

export function QuestionBanner({
  questions,
  selectedAnswers,
  questionComments,
  generalComment,
  setSelectedAnswers,
  setQuestionComments,
  setGeneralComment,
  onSubmit,
}: {
  questions: Question[]
  selectedAnswers: Record<string, string>
  questionComments: Record<string, string>
  generalComment: string
  setSelectedAnswers: Dispatch<SetStateAction<Record<string, string>>>
  setQuestionComments: Dispatch<SetStateAction<Record<string, string>>>
  setGeneralComment: Dispatch<SetStateAction<string>>
  onSubmit: () => void
}) {
  return (
    <div
      className="mb-3 rounded-xl px-4 py-3"
      style={{
        background: 'linear-gradient(135deg, rgba(99, 179, 237, 0.15) 0%, rgba(99, 179, 237, 0.08) 100%)',
        border: '1px solid rgba(99, 179, 237, 0.3)',
      }}
    >
      <div className="mb-3 flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: 'rgba(99, 179, 237, 0.2)' }}>
          <QuestionIcon className="text-blue-400" />
        </div>
        <div>
          <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
            Claude needs your input
          </div>
          <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            Select an option or add a comment - all fields are optional
          </div>
        </div>
      </div>

      {questions.map((q, qIndex) => (
        <div key={qIndex} className="mt-3">
          {(() => {
            const questionKey = q.id ?? q.question
            return (
              <>
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded px-1.5 py-0.5 text-xs font-medium" style={{ background: 'rgba(99, 179, 237, 0.2)', color: '#63b3ed' }}>
              {q.header}
            </span>
            <span className="text-sm" style={{ color: 'var(--color-text)' }}>
              {q.question}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {q.options.map((opt, optIndex) => {
              const isSelected = selectedAnswers[questionKey] === opt.label
              return (
                <button
                  key={optIndex}
                  onClick={() =>
                    setSelectedAnswers((prev) => ({
                      ...prev,
                      [questionKey]: prev[questionKey] === opt.label ? '' : opt.label,
                    }))
                  }
                  className="rounded-lg px-3 py-2 text-left transition-all"
                  style={{
                    background: isSelected ? 'rgba(99, 179, 237, 0.2)' : 'var(--color-surface)',
                    border: `1px solid ${isSelected ? 'rgba(99, 179, 237, 0.5)' : 'var(--color-border)'}`,
                  }}
                >
                  <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                    {opt.label}
                  </div>
                  <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    {opt.description}
                  </div>
                </button>
              )
            })}
          </div>
          <input
            type="text"
            value={questionComments[questionKey] ?? ''}
            onChange={(e) => setQuestionComments((prev) => ({ ...prev, [questionKey]: e.target.value }))}
            placeholder="Add a comment for this question... (optional)"
            className="mt-2 w-full rounded-lg px-3 py-1.5 text-xs outline-none"
            style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
          />
              </>
            )
          })()}
        </div>
      ))}

      <div className="mt-3">
        <textarea
          value={generalComment}
          onChange={(e) => setGeneralComment(e.target.value)}
          placeholder="General comments or clarifications... (optional)"
          rows={2}
          className="w-full resize-none rounded-lg px-3 py-2 text-xs outline-none"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
        />
      </div>

      <div className="mt-3 flex justify-end">
        <button
          onClick={onSubmit}
          className="rounded-lg px-4 py-1.5 text-xs font-medium transition-all hover:scale-105"
          style={{
            background: 'linear-gradient(135deg, #63b3ed 0%, #4299e1 100%)',
            color: '#fff',
            boxShadow: '0 2px 8px rgba(99, 179, 237, 0.3)',
          }}
        >
          Submit Answer{questions.length > 1 ? 's' : ''}
        </button>
      </div>
    </div>
  )
}

export function PermissionBanner({
  threadId,
  permissions,
  onApprove,
  onDeny,
}: {
  threadId: string
  permissions: PermissionRequest[]
  onApprove: (threadId: string, requestId?: string) => void
  onDeny: (threadId: string, requestId?: string) => void
}) {
  const activePermission = permissions[0]

  return (
    <div
      className="mb-3 rounded-xl px-4 py-3"
      style={{
        background: 'linear-gradient(135deg, rgba(251, 191, 36, 0.15) 0%, rgba(251, 191, 36, 0.08) 100%)',
        border: '1px solid rgba(251, 191, 36, 0.3)',
      }}
    >
      <div className="mb-3 flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: 'rgba(251, 191, 36, 0.2)' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </div>
        <div>
          <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
            Permission required
          </div>
          <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            Claude needs approval to perform {permissions.length === 1 ? 'this action' : 'these actions'}
          </div>
        </div>
      </div>

      <div className="mb-3 flex flex-col gap-1.5">
        {permissions.map((p, i) => (
          <div
            key={i}
            className="rounded-lg px-3 py-2 text-xs font-mono"
            style={{ background: 'rgba(251, 191, 36, 0.1)', color: 'var(--color-text)', border: '1px solid rgba(251, 191, 36, 0.2)' }}
          >
            {p.description}
          </div>
        ))}
      </div>

      <div className="flex items-center justify-end gap-2">
        <button
          onClick={() => onDeny(threadId, activePermission?.requestId)}
          className="rounded-lg px-3 py-1.5 text-xs font-medium transition-all hover:opacity-80"
          style={{ background: 'transparent', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}
        >
          Deny
        </button>
        <button
          onClick={() => onApprove(threadId, activePermission?.requestId)}
          className="rounded-lg px-4 py-1.5 text-xs font-medium transition-all hover:scale-105"
          style={{
            background: 'linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)',
            color: '#1a1a1a',
            boxShadow: '0 2px 8px rgba(251, 191, 36, 0.3)',
          }}
        >
          Approve & Continue
        </button>
      </div>
    </div>
  )
}
