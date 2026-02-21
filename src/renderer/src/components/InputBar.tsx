import { useState, useRef, useEffect, KeyboardEvent, useCallback } from 'react'
import { useThreadStore } from '../stores/threads'
import { useMessageStore } from '../stores/messages'
import { useProjectStore } from '../stores/projects'
import { useToastStore } from '../stores/toast'
import {
  Question,
  SearchableFile,
  PendingAttachment,
  SUPPORTED_ATTACHMENT_TYPES,
  MAX_ATTACHMENT_SIZE,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from '../types/ipc'
import FileMentionPopup from './FileMentionPopup'
import AttachmentPreview from './AttachmentPreview'
import QueuedMessageBanner from './QueuedMessageBanner'

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

function PaperclipIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}

function QueueIcon({ className }: { className?: string }) {
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
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  )
}

interface MentionState {
  active: boolean
  startIndex: number
  query: string
  position: { top: number; left: number }
}

export default function InputBar({ threadId }: Props) {
  const [isFocused, setIsFocused] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [questions, setQuestions] = useState<Question[]>([])
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string>>({})
  const [mention, setMention] = useState<MentionState>({
    active: false,
    startIndex: -1,
    query: '',
    position: { top: 0, left: 0 },
  })
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [isDragOver, setIsDragOver] = useState(false)

  const send = useThreadStore((s) => s.send)
  const stop = useThreadStore((s) => s.stop)
  const approvePlan = useThreadStore((s) => s.approvePlan)
  const rejectPlan = useThreadStore((s) => s.rejectPlan)
  const getQuestions = useThreadStore((s) => s.getQuestions)
  const answerQuestion = useThreadStore((s) => s.answerQuestion)
  const status = useThreadStore((s) => s.statusMap[threadId] ?? 'idle')
  const value = useThreadStore((s) => s.draftByThread[threadId] ?? '')
  const setDraft = useThreadStore((s) => s.setDraft)
  const planMode = useThreadStore((s) => s.planModeByThread[threadId] ?? false)
  const setPlanMode = useThreadStore((s) => s.setPlanMode)
  const queueMessage = useThreadStore((s) => s.queueMessage)
  const queuedMessage = useThreadStore((s) => s.queuedMessageByThread[threadId] ?? null)
  const appendUserMessage = useMessageStore((s) => s.appendUserMessage)

  const projects = useProjectStore((s) => s.projects)
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const project = projects.find((p) => p.id === selectedProjectId)
  const addToast = useToastStore((s) => s.add)

  const isProcessing = status === 'running'
  const isPlanPending = status === 'plan_pending'
  const isQuestionPending = status === 'question_pending'
  const hasContent = value.trim().length > 0 || attachments.length > 0
  // Can send when idle and has content
  const canSend = !isProcessing && !isPlanPending && !isQuestionPending && hasContent
  // Can queue when processing (and no existing queue) and has content
  const canQueue = isProcessing && !queuedMessage && hasContent

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
    if ((!trimmed && attachments.length === 0) || !project) return

    // Save attachments to temp and build @ mentions
    const savedPaths: string[] = []
    for (const att of attachments) {
      if (att.dataUrl) {
        const { tempPath } = await window.api.invoke(
          'attachments:save',
          att.dataUrl,
          att.name,
          threadId
        )
        savedPaths.push(tempPath)
      } else if (att.tempPath) {
        savedPaths.push(att.tempPath)
      }
    }

    // Build final message with @ mentions for attachments
    let finalContent = trimmed
    if (savedPaths.length > 0) {
      const mentions = savedPaths.map((p) => `@${p}`).join(' ')
      finalContent = finalContent ? `${mentions}\n\n${trimmed}` : mentions
    }

    // Clear state
    setDraft(threadId, '')
    setAttachments([])
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    // If processing, queue the message instead of sending
    if (isProcessing) {
      queueMessage(threadId, finalContent, planMode)
      if (planMode) setPlanMode(threadId, false)
      return
    }

    appendUserMessage(threadId, finalContent)
    await send(threadId, finalContent, project.path, { planMode })
    if (planMode) setPlanMode(threadId, false)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    // If mention popup is active, let it handle navigation keys
    if (mention.active) {
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
        // These are handled by FileMentionPopup's document keydown listener
        return
      }
    }

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

  // Detect '@' trigger for file mentions
  const checkForMention = useCallback((text: string, cursorPos: number) => {
    // Find the '@' before the cursor
    const textBeforeCursor = text.slice(0, cursorPos)
    const lastAtIndex = textBeforeCursor.lastIndexOf('@')

    if (lastAtIndex === -1) {
      setMention((m) => m.active ? { ...m, active: false } : m)
      return
    }

    // Check if '@' is at start or preceded by whitespace
    const charBefore = lastAtIndex > 0 ? text[lastAtIndex - 1] : ' '
    if (!/\s/.test(charBefore) && lastAtIndex > 0) {
      setMention((m) => m.active ? { ...m, active: false } : m)
      return
    }

    // Extract query after '@'
    const query = text.slice(lastAtIndex + 1, cursorPos)

    // Don't trigger if query contains spaces (user moved past the mention)
    if (query.includes(' ')) {
      setMention((m) => m.active ? { ...m, active: false } : m)
      return
    }

    // Calculate popup position
    const el = textareaRef.current
    if (!el) return

    const rect = el.getBoundingClientRect()
    // Position above the input area
    const position = {
      top: rect.top - 8, // Will be adjusted by popup to appear above
      left: rect.left,
    }

    setMention({
      active: true,
      startIndex: lastAtIndex,
      query,
      position,
    })
  }, [])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value
    setDraft(threadId, newValue)
    checkForMention(newValue, e.target.selectionStart)
  }, [threadId, setDraft, checkForMention])

  const handleFileSelect = useCallback((file: SearchableFile) => {
    const el = textareaRef.current
    if (!el) return

    // Replace @query with @relativePath
    const before = value.slice(0, mention.startIndex)
    const after = value.slice(el.selectionStart)
    const newValue = `${before}@${file.relativePath} ${after}`

    setDraft(threadId, newValue)
    setMention({ active: false, startIndex: -1, query: '', position: { top: 0, left: 0 } })

    // Focus back on textarea and move cursor after inserted path
    requestAnimationFrame(() => {
      el.focus()
      const newCursorPos = mention.startIndex + file.relativePath.length + 2 // +2 for '@' and space
      el.selectionStart = el.selectionEnd = newCursorPos
    })
  }, [value, mention.startIndex, threadId, setDraft])

  const closeMention = useCallback(() => {
    setMention({ active: false, startIndex: -1, query: '', position: { top: 0, left: 0 } })
  }, [])

  // ── Attachment handlers ─────────────────────────────────────────────────────

  function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  async function addAttachment(file: File): Promise<void> {
    // Validate type
    if (!Object.keys(SUPPORTED_ATTACHMENT_TYPES).includes(file.type)) {
      addToast({ message: `Unsupported file type: ${file.type}`, type: 'error' })
      return
    }

    // Validate size
    if (file.size > MAX_ATTACHMENT_SIZE) {
      addToast({ message: `File too large: ${file.name} (max 5MB)`, type: 'error' })
      return
    }

    // Validate count
    if (attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      addToast({ message: `Maximum ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`, type: 'error' })
      return
    }

    // Read as data URL for preview
    const dataUrl = await readFileAsDataUrl(file)
    const typeInfo = SUPPORTED_ATTACHMENT_TYPES[file.type as keyof typeof SUPPORTED_ATTACHMENT_TYPES]

    const pending: PendingAttachment = {
      id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: file.name,
      type: typeInfo.type,
      mimeType: file.type,
      size: file.size,
      dataUrl,
    }

    setAttachments((prev) => [...prev, pending])
  }

  async function addAttachmentFromPath(filePath: string): Promise<void> {
    const info = await window.api.invoke('attachments:getFileInfo', filePath)
    if (!info) {
      addToast({ message: 'Could not read file', type: 'error' })
      return
    }

    // Validate type
    if (!Object.keys(SUPPORTED_ATTACHMENT_TYPES).includes(info.mimeType)) {
      addToast({ message: `Unsupported file type: ${info.mimeType}`, type: 'error' })
      return
    }

    // Validate size
    if (info.size > MAX_ATTACHMENT_SIZE) {
      addToast({ message: 'File too large (max 5MB)', type: 'error' })
      return
    }

    // Validate count
    if (attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      addToast({ message: `Maximum ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`, type: 'error' })
      return
    }

    // Copy to temp and get path
    const { tempPath, id } = await window.api.invoke('attachments:saveFromPath', filePath, threadId)
    const typeInfo = SUPPORTED_ATTACHMENT_TYPES[info.mimeType as keyof typeof SUPPORTED_ATTACHMENT_TYPES]
    const fileName = filePath.split(/[\\/]/).pop() ?? 'file'

    // For images, read as data URL for preview
    let dataUrl: string | undefined
    if (typeInfo.type === 'image') {
      const result = await window.api.invoke('files:read', tempPath)
      if (result) {
        // Read the temp file as base64 for preview
        const base64 = await fetch(`file://${tempPath}`)
          .then((r) => r.blob())
          .then((blob) => readFileAsDataUrl(blob as unknown as File))
          .catch(() => undefined)
        dataUrl = base64
      }
    }

    const pending: PendingAttachment = {
      id,
      name: fileName,
      type: typeInfo.type,
      mimeType: info.mimeType,
      size: info.size,
      tempPath,
      dataUrl,
    }

    setAttachments((prev) => [...prev, pending])
  }

  function removeAttachment(id: string): void {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }

  async function handlePaste(e: React.ClipboardEvent): Promise<void> {
    const items = e.clipboardData.items
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) {
          await addAttachment(file)
        }
        return
      }
    }
    // Let default paste happen for text
  }

  function handleDragOver(e: React.DragEvent): void {
    e.preventDefault()
    e.stopPropagation()
    if (!isDragOver) setIsDragOver(true)
  }

  function handleDragLeave(e: React.DragEvent): void {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }

  async function handleDrop(e: React.DragEvent): Promise<void> {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    const files = Array.from(e.dataTransfer.files)
    for (const file of files) {
      await addAttachment(file)
    }
  }

  async function handleFilePick(): Promise<void> {
    const paths = await window.api.invoke('dialog:open-files')
    for (const filePath of paths) {
      await addAttachmentFromPath(filePath)
    }
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
              onClick={() => {
                if (project) {
                  window.api.invoke('threads:executePlanInNewContext', threadId, project.path)
                }
              }}
              className="rounded-lg px-3 py-1.5 text-xs font-medium transition-all hover:scale-105"
              style={{
                background: 'transparent',
                border: '1px solid var(--color-claude)',
                color: 'var(--color-claude)',
              }}
              title="Execute in a fresh Claude session, keeping this planning session as a tab"
            >
              New Context
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

      {/* Queued message banner */}
      {queuedMessage && (
        <QueuedMessageBanner threadId={threadId} queuedMessage={queuedMessage} />
      )}

      {/* Main input container with drop zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className="relative rounded-xl transition-all duration-200"
        style={{
          background: isDragOver ? 'rgba(232, 123, 95, 0.05)' : 'var(--color-surface)',
          border: `1px solid ${isFocused || isDragOver ? 'var(--color-claude)' : 'var(--color-border)'}`,
          boxShadow: isFocused || isDragOver
            ? '0 0 0 3px rgba(232, 123, 95, 0.1), 0 4px 12px rgba(0, 0, 0, 0.2)'
            : '0 2px 8px rgba(0, 0, 0, 0.15)',
        }}
      >
        {/* Drop overlay */}
        {isDragOver && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-black/50">
            <span className="text-sm text-white">Drop files to attach</span>
          </div>
        )}

        {/* Top row: Plan toggle */}
        <div
          className="flex items-center gap-2 px-3 pt-2"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          <button
            onClick={() => setPlanMode(threadId, !planMode)}
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

        {/* Attachment previews */}
        <AttachmentPreview
          attachments={attachments}
          onRemove={removeAttachment}
          disabled={isProcessing}
        />

        {/* Textarea row */}
        <div className="flex items-end gap-2 px-3 py-3">
          {/* Paperclip button */}
          <button
            onClick={handleFilePick}
            disabled={isProcessing}
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg transition-all hover:bg-[var(--color-surface-2)] disabled:opacity-30"
            style={{ color: 'var(--color-text-muted)' }}
            title="Attach files (images, PDFs)"
          >
            <PaperclipIcon />
          </button>

          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            onPaste={handlePaste}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            rows={1}
            placeholder={isProcessing ? (queuedMessage ? 'Message already queued...' : 'Type to queue a message...') : 'Ask Claude anything... (@ to mention files)'}
            disabled={isPlanPending || isQuestionPending}
            className="flex-1 resize-none bg-transparent text-sm leading-relaxed outline-none"
            style={{
              color: 'var(--color-text)',
              maxHeight: '200px',
              minHeight: '24px',
            }}
          />

          {/* Send / Queue / Stop buttons */}
          {isProcessing ? (
            <>
              {/* Queue button */}
              <button
                onClick={handleSend}
                disabled={!canQueue}
                className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg transition-all duration-150 disabled:cursor-not-allowed"
                style={{
                  background: canQueue
                    ? 'linear-gradient(135deg, #a855f7 0%, #9333ea 100%)'
                    : 'var(--color-surface-2)',
                  boxShadow: canQueue ? '0 2px 8px rgba(168, 85, 247, 0.3)' : 'none',
                  opacity: canQueue ? 1 : 0.4,
                }}
                title={queuedMessage ? 'Message already queued' : 'Queue message (Enter)'}
              >
                <QueueIcon className={canQueue ? 'text-white' : 'text-gray-500'} />
              </button>
              {/* Stop button */}
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
            </>
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

      {/* File mention popup */}
      {mention.active && project && (
        <FileMentionPopup
          projectPath={project.path}
          query={mention.query}
          onSelect={handleFileSelect}
          onClose={closeMention}
          position={mention.position}
        />
      )}
    </div>
  )
}
