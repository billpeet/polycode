import { useState, useRef, useEffect, KeyboardEvent } from 'react'
import { useThreadStore } from '../stores/threads'
import { useMessageStore } from '../stores/messages'
import { useProjectStore } from '../stores/projects'
import { Question } from '../types/ipc'

interface Props {
  threadId: string
}

function SendIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 2L11 13" />
      <path d="M22 2L15 22L11 13L2 9L22 2Z" />
    </svg>
  )
}

function StopIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  )
}

function PlanIcon({ className }: { className?: string }) {
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
      <path d="M9 11L12 14L22 4" />
      <path d="M21 12V19C21 20.1 20.1 21 19 21H5C3.9 21 3 20.1 3 19V5C3 3.9 3.9 3 5 3H16" />
    </svg>
  )
}

function QuestionIcon({ className }: { className?: string }) {
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
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

export default function InputBar({ threadId }: Props) {
  const [planMode, setPlanMode] = useState(false)
  const [isFocused, setIsFocused] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [questions, setQuestions] = useState<Question[]>([])
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string>>({})

  const send = useThreadStore((s) => s.send)
  const stop = useThreadStore((s) => s.stop)
  const approvePlan = useThreadStore((s) => s.approvePlan)
  const rejectPlan = useThreadStore((s) => s.rejectPlan)
  const getQuestions = useThreadStore((s) => s.getQuestions)
  const answerQuestion = useThreadStore((s) => s.answerQuestion)
  const status = useThreadStore((s) => s.statusMap[threadId] ?? 'idle')
  const value = useThreadStore((s) => s.draftByThread[threadId] ?? '')
  const setDraft = useThreadStore((s) => s.setDraft)
  const appendUserMessage = useMessageStore((s) => s.appendUserMessage)

  const projects = useProjectStore((s) => s.projects)
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const project = projects.find((p) => p.id === selectedProjectId)

  const isProcessing = status === 'running'
  const isPlanPending = status === 'plan_pending'
  const isQuestionPending = status === 'question_pending'
  const canSend = !isProcessing && !isPlanPending && !isQuestionPending && value.trim().length > 0

  // Fetch questions when status changes to question_pending
  useEffect(() => {
    if (isQuestionPending) {
      getQuestions(threadId).then((qs) => {
        setQuestions(qs)
        setSelectedAnswers({})
      })
    } else {
      setQuestions([])
      setSelectedAnswers({})
    }
  }, [isQuestionPending, threadId, getQuestions])

  useEffect(() => {
    function onFocusInput(): void {
      textareaRef.current?.focus()
    }
    window.addEventListener('focus-input', onFocusInput)
    return () => window.removeEventListener('focus-input', onFocusInput)
  }, [])

  async function handleSend(): Promise<void> {
    const trimmed = value.trim()
    if (!trimmed || isProcessing || !project) return

    setDraft(threadId, '')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    appendUserMessage(threadId, trimmed)
    await send(threadId, trimmed, project.path, { planMode })
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    // Ctrl+J inserts newline (Unix terminal convention)
    if (e.key === 'j' && e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault()
      insertNewline()
      return
    }

    // Backslash+Enter inserts newline (CLI convention)
    if (e.key === 'Enter' && value.endsWith('\\')) {
      e.preventDefault()
      // Remove the trailing backslash and add newline
      setDraft(threadId, value.slice(0, -1) + '\n')
      return
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  function insertNewline(): void {
    const el = textareaRef.current
    if (!el) return

    const start = el.selectionStart
    const end = el.selectionEnd
    const newValue = value.slice(0, start) + '\n' + value.slice(end)
    setDraft(threadId, newValue)

    // Move cursor after the newline
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + 1
      handleInput()
    })
  }

  function handleInput(): void {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  return (
    <div className="relative flex-shrink-0 px-4 pb-4 pt-2" style={{ background: 'var(--color-bg)' }}>
      {/* Gradient fade above input */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-6 -translate-y-full"
        style={{
          background: 'linear-gradient(to top, var(--color-bg), transparent)',
        }}
      />

      {/* Error banner */}
      {status === 'error' && (
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
      )}

      {/* Plan approval banner */}
      {isPlanPending && (
        <div
          className="mb-3 flex items-center justify-between rounded-xl px-4 py-3"
          style={{
            background: 'linear-gradient(135deg, rgba(232, 123, 95, 0.15) 0%, rgba(232, 123, 95, 0.08) 100%)',
            border: '1px solid rgba(232, 123, 95, 0.3)',
          }}
        >
          <div className="flex items-center gap-3">
            <div
              className="flex h-8 w-8 items-center justify-center rounded-lg"
              style={{ background: 'rgba(232, 123, 95, 0.2)' }}
            >
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
              onClick={() => rejectPlan(threadId)}
              className="rounded-lg px-3 py-1.5 text-xs font-medium transition-all hover:opacity-80"
              style={{
                background: 'transparent',
                border: '1px solid var(--color-border)',
                color: 'var(--color-text-muted)',
              }}
            >
              Reject
            </button>
            <button
              onClick={() => approvePlan(threadId)}
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
      )}

      {/* Question banner */}
      {isQuestionPending && questions.length > 0 && (
        <div
          className="mb-3 rounded-xl px-4 py-3"
          style={{
            background: 'linear-gradient(135deg, rgba(99, 179, 237, 0.15) 0%, rgba(99, 179, 237, 0.08) 100%)',
            border: '1px solid rgba(99, 179, 237, 0.3)',
          }}
        >
          <div className="mb-3 flex items-center gap-3">
            <div
              className="flex h-8 w-8 items-center justify-center rounded-lg"
              style={{ background: 'rgba(99, 179, 237, 0.2)' }}
            >
              <QuestionIcon className="text-blue-400" />
            </div>
            <div>
              <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                Claude needs your input
              </div>
              <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                Select an option for each question below
              </div>
            </div>
          </div>

          {questions.map((q, qIndex) => (
            <div key={qIndex} className="mt-3">
              <div className="mb-2 flex items-center gap-2">
                <span
                  className="rounded px-1.5 py-0.5 text-xs font-medium"
                  style={{ background: 'rgba(99, 179, 237, 0.2)', color: '#63b3ed' }}
                >
                  {q.header}
                </span>
                <span className="text-sm" style={{ color: 'var(--color-text)' }}>
                  {q.question}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {q.options.map((opt, optIndex) => {
                  const isSelected = selectedAnswers[q.question] === opt.label
                  return (
                    <button
                      key={optIndex}
                      onClick={() =>
                        setSelectedAnswers((prev) => ({ ...prev, [q.question]: opt.label }))
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
            </div>
          ))}

          <div className="mt-4 flex justify-end">
            <button
              onClick={() => answerQuestion(threadId, selectedAnswers)}
              disabled={Object.keys(selectedAnswers).length < questions.length}
              className="rounded-lg px-4 py-1.5 text-xs font-medium transition-all hover:scale-105 disabled:opacity-50 disabled:hover:scale-100"
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
      )}

      {/* Main input container */}
      <div
        className="relative rounded-xl transition-all duration-200"
        style={{
          background: 'var(--color-surface)',
          border: `1px solid ${isFocused ? 'var(--color-claude)' : 'var(--color-border)'}`,
          boxShadow: isFocused
            ? '0 0 0 3px rgba(232, 123, 95, 0.1), 0 4px 12px rgba(0, 0, 0, 0.2)'
            : '0 2px 8px rgba(0, 0, 0, 0.15)',
        }}
      >
        {/* Top row: Plan toggle */}
        <div
          className="flex items-center gap-2 px-3 pt-2"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          <button
            onClick={() => setPlanMode(!planMode)}
            disabled={isProcessing}
            title={planMode ? 'Plan mode: ON — Claude will create a plan before executing' : 'Plan mode: OFF — Claude will execute directly'}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-all duration-150 disabled:opacity-30 mb-2"
            style={{
              background: planMode ? 'rgba(232, 123, 95, 0.15)' : 'transparent',
              color: planMode ? 'var(--color-claude)' : 'var(--color-text-muted)',
              border: `1px solid ${planMode ? 'rgba(232, 123, 95, 0.3)' : 'transparent'}`,
            }}
          >
            <PlanIcon />
            Plan
          </button>
          <span className="mb-2 text-xs" style={{ color: 'var(--color-text-muted)', opacity: 0.5 }}>
            |
          </span>
          <span className="mb-2 text-xs" style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}>
            Shift+Enter for newline
          </span>
        </div>

        {/* Textarea row */}
        <div className="flex items-end gap-3 px-3 py-3">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setDraft(threadId, e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            rows={1}
            placeholder="Ask Claude anything..."
            disabled={isProcessing}
            className="flex-1 resize-none bg-transparent text-sm leading-relaxed outline-none"
            style={{
              color: 'var(--color-text)',
              maxHeight: '200px',
              minHeight: '24px',
            }}
          />

          {/* Send / Stop button */}
          {isProcessing ? (
            <button
              onClick={() => stop(threadId)}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg transition-all duration-150 hover:scale-105"
              style={{
                background: 'linear-gradient(135deg, #f87171 0%, #ef4444 100%)',
                boxShadow: '0 2px 8px rgba(248, 113, 113, 0.3)',
              }}
              title="Stop generation"
            >
              <StopIcon className="text-white" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!canSend}
              className="input-send-btn flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg transition-all duration-150 disabled:cursor-not-allowed"
              style={{
                background: canSend
                  ? 'linear-gradient(135deg, var(--color-claude) 0%, #d06a50 100%)'
                  : 'var(--color-surface-2)',
                boxShadow: canSend ? '0 2px 8px rgba(232, 123, 95, 0.3)' : 'none',
                opacity: canSend ? 1 : 0.4,
              }}
              title="Send message (Enter)"
            >
              <SendIcon className={canSend ? 'text-white' : 'text-gray-500'} />
            </button>
          )}
        </div>
      </div>

      {/* Keyboard hint */}
      <div className="mt-2 flex items-center justify-center gap-4 text-xs" style={{ color: 'var(--color-text-muted)', opacity: 0.5 }}>
        <span>
          <kbd className="rounded px-1 py-0.5" style={{ background: 'var(--color-surface-2)' }}>Enter</kbd> send
        </span>
        <span>
          <kbd className="rounded px-1 py-0.5" style={{ background: 'var(--color-surface-2)' }}>Ctrl+J</kbd> newline
        </span>
      </div>
    </div>
  )
}
