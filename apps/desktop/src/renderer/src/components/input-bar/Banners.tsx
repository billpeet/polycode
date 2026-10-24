import type { Dispatch, SetStateAction } from 'react'
import { Question, PermissionRequest, RepoLocation } from '../../types/ipc'
import { PlanIcon, QuestionIcon } from './icons'

export function MissingLocationBanner({ location }: { location: RepoLocation }) {
  return (
    <div
      className="mb-3 flex items-center gap-2 rounded-lg px-3 py-2 text-xs"
      style={{
        background: 'color-mix(in srgb, var(--color-danger) 10%, transparent)',
        border: '1px solid color-mix(in srgb, var(--color-danger) 30%, transparent)',
        color: 'var(--color-danger)',
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
  checking,
  onRetry,
}: {
  status?: 'unavailable' | 'error'
  error?: string
  checking?: boolean
  onRetry?: () => void
}) {
  return (
    <div
      className="mb-3 flex items-center gap-2 rounded-lg px-3 py-2 text-xs"
      style={{
        background: 'color-mix(in srgb, var(--color-danger) 10%, transparent)',
        border: '1px solid color-mix(in srgb, var(--color-danger) 30%, transparent)',
        color: 'var(--color-danger)',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span className="flex-1">
        {status === 'error'
          ? `CLI health check failed: ${error ?? 'unknown error'}`
          : 'CLI not found for this provider - install it or switch to a different provider.'}
      </span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={checking}
          className="shrink-0 rounded px-2 py-1 font-medium disabled:opacity-50"
          style={{ border: '1px solid currentColor' }}
        >
          {checking ? 'Checking…' : 'Retry'}
        </button>
      )}
    </div>
  )
}

export function ErrorBanner() {
  return (
    <div
      className="mb-3 flex items-center gap-2 rounded-lg px-3 py-2 text-xs"
      style={{
        background: 'color-mix(in srgb, var(--color-danger) 10%, transparent)',
        border: '1px solid color-mix(in srgb, var(--color-danger) 30%, transparent)',
        color: 'var(--color-danger)',
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
        background: 'linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 15%, transparent) 0%, color-mix(in srgb, var(--color-accent) 8%, transparent) 100%)',
        border: '1px solid color-mix(in srgb, var(--color-accent) 30%, transparent)',
      }}
    >
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: 'color-mix(in srgb, var(--color-accent) 20%, transparent)' }}>
          <PlanIcon className="text-[var(--color-accent)]" />
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
          style={{ background: 'transparent', border: '1px solid var(--color-accent)', color: 'var(--color-accent)' }}
          title="Execute in a fresh Claude session, keeping this planning session as a tab"
        >
          New Context
        </button>
        <button
          onClick={() => onApprove(threadId)}
          className="rounded-lg px-4 py-1.5 text-xs font-medium transition-all hover:scale-105"
          style={{
            background: 'linear-gradient(135deg, var(--color-accent) 0%, var(--color-accent-strong) 100%)',
            color: 'var(--color-on-accent)',
            boxShadow: '0 2px 8px color-mix(in srgb, var(--color-accent) 30%, transparent)',
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
  selectedAnswers: Record<string, string | string[]>
  questionComments: Record<string, string>
  generalComment: string
  setSelectedAnswers: Dispatch<SetStateAction<Record<string, string | string[]>>>
  setQuestionComments: Dispatch<SetStateAction<Record<string, string>>>
  setGeneralComment: Dispatch<SetStateAction<string>>
  onSubmit: () => void
}) {
  return (
    <div
      className="mb-3 max-h-[min(60vh,32rem)] overflow-y-auto rounded-xl px-4 py-3"
      style={{
        background: 'linear-gradient(135deg, color-mix(in srgb, var(--color-info) 15%, transparent) 0%, color-mix(in srgb, var(--color-info) 8%, transparent) 100%)',
        border: '1px solid color-mix(in srgb, var(--color-info) 30%, transparent)',
      }}
    >
      <div className="mb-3 flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: 'color-mix(in srgb, var(--color-info) 20%, transparent)' }}>
          <QuestionIcon className="text-info" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
            The agent needs your input
          </div>
          <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {questions.some((question) => question.allowComments === false) ? 'Choose an offered answer for each question' : 'Select an option or add a comment - all fields are optional'}
          </div>
        </div>
      </div>

      {questions.map((q, qIndex) => (
        <div key={qIndex} className="mt-3">
          {(() => {
            const questionKey = q.id ?? q.question
            return (
              <>
          <div className="mb-2 flex items-start gap-2">
            <span className="rounded px-1.5 py-0.5 text-xs font-medium" style={{ background: 'color-mix(in srgb, var(--color-info) 20%, transparent)', color: 'var(--color-info)' }}>
              {q.header}
            </span>
            <span className="min-w-0 break-words text-sm" style={{ color: 'var(--color-text)' }}>
              {q.question}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {q.options.map((opt, optIndex) => {
              const currentAnswer = selectedAnswers[questionKey]
              const isSelected = Array.isArray(currentAnswer) ? currentAnswer.includes(opt.label) : currentAnswer === opt.label
              return (
                <button
                  key={optIndex}
                  onClick={() =>
                    setSelectedAnswers((prev) => {
                      const current = prev[questionKey]
                      if (!q.multiSelect) {
                        return { ...prev, [questionKey]: current === opt.label ? '' : opt.label }
                      }
                      const currentList = Array.isArray(current) ? current : (current ? [current] : [])
                      const nextList = currentList.includes(opt.label)
                        ? currentList.filter((label) => label !== opt.label)
                        : [...currentList, opt.label]
                      return { ...prev, [questionKey]: nextList }
                    })
                  }
                  className="min-w-0 rounded-lg px-3 py-2 text-left transition-all"
                  style={{
                    background: isSelected ? 'color-mix(in srgb, var(--color-info) 20%, transparent)' : 'var(--color-surface)',
                    border: `1px solid ${isSelected ? 'color-mix(in srgb, var(--color-info) 50%, transparent)' : 'var(--color-border)'}`,
                  }}
                >
                  <div className="break-words text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                    {opt.label}
                  </div>
                  <div className="break-words text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    {opt.description}
                  </div>
                </button>
              )
            })}
          </div>
          {q.allowComments !== false && <input
            type="text"
            value={questionComments[questionKey] ?? ''}
            onChange={(e) => setQuestionComments((prev) => ({ ...prev, [questionKey]: e.target.value }))}
            placeholder="Add a comment for this question... (optional)"
            className="mt-2 w-full rounded-lg px-3 py-1.5 text-xs outline-none"
            style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
          />}
              </>
            )
          })()}
        </div>
      ))}

      {questions.every((question) => question.allowComments !== false) && <div className="mt-3">
        <textarea
          value={generalComment}
          onChange={(e) => setGeneralComment(e.target.value)}
          placeholder="General comments or clarifications... (optional)"
          rows={2}
          className="w-full resize-none rounded-lg px-3 py-2 text-xs outline-none"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
        />
      </div>}

      <div className="mt-3 flex justify-end">
        <button
          onClick={onSubmit}
          disabled={questions.some((question) => question.allowComments === false && !(selectedAnswers[question.id ?? question.question]?.length))}
          className="rounded-lg px-4 py-1.5 text-xs font-medium transition-all hover:scale-105"
          style={{
            background: 'linear-gradient(135deg, var(--color-info) 0%, var(--color-info-strong) 100%)',
            color: 'var(--color-on-accent)',
            boxShadow: '0 2px 8px color-mix(in srgb, var(--color-info) 30%, transparent)',
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
        background: 'linear-gradient(135deg, color-mix(in srgb, var(--color-warning) 15%, transparent) 0%, color-mix(in srgb, var(--color-warning) 8%, transparent) 100%)',
        border: '1px solid color-mix(in srgb, var(--color-warning) 30%, transparent)',
      }}
    >
      <div className="mb-3 flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: 'color-mix(in srgb, var(--color-warning) 20%, transparent)' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-warning)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
            style={{ background: 'color-mix(in srgb, var(--color-warning) 10%, transparent)', color: 'var(--color-text)', border: '1px solid color-mix(in srgb, var(--color-warning) 20%, transparent)' }}
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
            background: 'linear-gradient(135deg, var(--color-warning) 0%, var(--color-warning-strong) 100%)',
            color: 'var(--color-bg)',
            boxShadow: '0 2px 8px color-mix(in srgb, var(--color-warning) 30%, transparent)',
          }}
        >
          Approve & Continue
        </button>
      </div>
    </div>
  )
}
