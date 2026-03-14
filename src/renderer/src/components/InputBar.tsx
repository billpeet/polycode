import { useState, useRef, useEffect, KeyboardEvent, useCallback } from 'react'
import { useThreadStore } from '../stores/threads'
import { useMessageStore } from '../stores/messages'
import { useProjectStore } from '../stores/projects'
import { useLocationStore } from '../stores/locations'
import { useToastStore } from '../stores/toast'
import { useSessionStore } from '../stores/sessions'
import {
  Question,
  SearchableFile,
  PendingAttachment,
  SUPPORTED_ATTACHMENT_TYPES,
  MAX_ATTACHMENT_SIZE,
  MAX_ATTACHMENTS_PER_MESSAGE,
  Thread,
  RepoLocation,
  SlashCommand,
  Provider,
} from '../types/ipc'
import FileMentionPopup from './FileMentionPopup'
import YouTrackMentionPopup from './YouTrackMentionPopup'
import SlashCommandPopup from './SlashCommandPopup'
import AttachmentPreview from './AttachmentPreview'
import { useYouTrackStore } from '../stores/youtrack'
import { useSlashCommandStore } from '../stores/slashCommands'
import { useCliHealthStore } from '../stores/cliHealth'
import QueuedMessageBanner from './QueuedMessageBanner'
import ComposerToolbar from './input-bar/ComposerToolbar'
import { CliUnavailableBanner, ErrorBanner, MissingLocationBanner, PlanBanner, QuestionBanner } from './input-bar/Banners'
import { PaperclipIcon, QueueIcon, SendIcon, StopIcon } from './input-bar/icons'

interface Props {
  threadId: string
}

const EMPTY_THREADS: Thread[] = []
const EMPTY_LOCATIONS: RepoLocation[] = []
const EMPTY_SLASH_COMMANDS: SlashCommand[] = []

interface MentionState {
  active: boolean
  startIndex: number
  query: string
  position: { top: number; left: number }
  type: 'file' | 'youtrack'
}

interface SlashState {
  active: boolean
  startIndex: number
  query: string
  position: { top: number; left: number }
}

/** Matches YouTrack issue ID patterns like JS-, JS-123, MYPROJ-42 (all uppercase project code) */
const YOUTRACK_QUERY_REGEX = /^[A-Z][A-Z0-9]*(-[0-9]*)?$/

export default function InputBar({ threadId }: Props) {
  const [isFocused, setIsFocused] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [questions, setQuestions] = useState<Question[]>([])
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string>>({})
  const [questionComments, setQuestionComments] = useState<Record<string, string>>({})
  const [generalComment, setGeneralComment] = useState('')
  const [mention, setMention] = useState<MentionState>({
    active: false,
    startIndex: -1,
    query: '',
    position: { top: 0, left: 0 },
    type: 'file',
  })
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [slashCmd, setSlashCmd] = useState<SlashState>({
    active: false,
    startIndex: -1,
    query: '',
    position: { top: 0, left: 0 },
  })
  const runStartedAt = useThreadStore((s) => s.runStartedAtByThread[threadId] ?? 0)

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
  const projectThreads = useThreadStore((s) => selectedProjectId ? (s.byProject[selectedProjectId] ?? EMPTY_THREADS) : EMPTY_THREADS)
  const currentThread = projectThreads.find((t) => t.id === threadId)
  const projectLocations = useLocationStore((s) => selectedProjectId ? (s.byProject[selectedProjectId] ?? EMPTY_LOCATIONS) : EMPTY_LOCATIONS)
  const location = currentThread?.location_id ? projectLocations.find((l) => l.id === currentThread.location_id) : null
  const addToast = useToastStore((s) => s.add)

  const [locationPathMissing, setLocationPathMissing] = useState(false)

  // Check if the thread's local location path exists
  useEffect(() => {
    if (!location || location.connection_type !== 'local') {
      setLocationPathMissing(false)
      return
    }
    window.api.invoke('locations:pathExists', location.path).then((exists) => {
      setLocationPathMissing(!exists)
    }).catch(() => {})
  }, [location])

  const cliHealth = useCliHealthStore((s) => s.healthByThread[threadId])
  const cliUnavailable = cliHealth?.status === 'unavailable' || cliHealth?.status === 'error'

  // Provider / model / WSL selectors (moved from ThreadHeader)
  const setProviderAndModel = useThreadStore((s) => s.setProviderAndModel)
  const setModel = useThreadStore((s) => s.setModel)
  const setYolo = useThreadStore((s) => s.setYolo)
  const setWsl = useThreadStore((s) => s.setWsl)

  const [availableDistros, setAvailableDistros] = useState<string[]>([])
  const isLocalLocation = location?.connection_type === 'local'
  const isWslSelected = location?.connection_type === 'wsl' || (isLocalLocation && !!currentThread?.use_wsl)
  const showCodexWslWarning = currentThread?.provider === 'codex' && !isWslSelected

  useEffect(() => {
    if (!isLocalLocation) return
    window.api.invoke('wsl:list-distros').then(setAvailableDistros)
  }, [isLocalLocation])

  // Run a CLI health check whenever the effective provider/connection configuration changes
  const checkCliHealth = useCliHealthStore((s) => s.check)
  const clearCliHealth = useCliHealthStore((s) => s.clear)
  useEffect(() => {
    if (!currentThread || !location) {
      clearCliHealth(threadId)
      return
    }
    const provider = (currentThread.provider ?? 'claude-code') as Provider
    const connectionType = location.connection_type
    const effectiveConnectionType = (connectionType === 'local' && currentThread.use_wsl) ? 'wsl' : connectionType
    const wslConfig = connectionType === 'wsl'
      ? (location.wsl ?? null)
      : (connectionType === 'local' && currentThread.use_wsl && currentThread.wsl_distro)
        ? { distro: currentThread.wsl_distro }
        : null
    checkCliHealth(threadId, provider, effectiveConnectionType, location.ssh ?? null, wslConfig)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentThread?.provider, currentThread?.use_wsl, currentThread?.wsl_distro, location?.connection_type, location?.id, threadId])

  const youtrackServers = useYouTrackStore((s) => s.servers)
  const slashCommandsByScope = useSlashCommandStore((s) => s.commandsByScope)
  const fetchSlashCommands = useSlashCommandStore((s) => s.fetch)
  const slashCommands = slashCommandsByScope[selectedProjectId ?? 'global'] ?? slashCommandsByScope['global'] ?? EMPTY_SLASH_COMMANDS
  const sendingRef = useRef(false)

  const isProcessing = status === 'running' || status === 'stopping'
  const isStopping = status === 'stopping'
  const isPlanPending = status === 'plan_pending'
  const isQuestionPending = status === 'question_pending'
  const hasContent = value.trim().length > 0 || attachments.length > 0
  // Can send when idle and has content, location path exists, and CLI is available
  const canSend = !isProcessing && !isPlanPending && !isQuestionPending && hasContent && !locationPathMissing && !cliUnavailable
  // Can queue only when actively running (not while stopping) and no existing queue
  const canQueue = status === 'running' && !queuedMessage && hasContent && !locationPathMissing && !cliUnavailable

  // Elapsed timer while processing
  useEffect(() => {
    if (!isProcessing || !runStartedAt) {
      setElapsedSeconds(0)
      return
    }
    const nextElapsed = Math.floor((Date.now() - runStartedAt) / 1000)
    setElapsedSeconds((prev) => (prev === nextElapsed ? prev : nextElapsed))
    const id = setInterval(() => {
      const elapsed = Math.floor((Date.now() - runStartedAt) / 1000)
      setElapsedSeconds((prev) => (prev === elapsed ? prev : elapsed))
    }, 1000)
    return () => clearInterval(id)
  }, [isProcessing, runStartedAt])

  // Fetch questions when status changes to question_pending
  useEffect(() => {
    if (isQuestionPending) {
      getQuestions(threadId).then((qs) => {
        setQuestions(qs)
        setSelectedAnswers({})
        setQuestionComments({})
        setGeneralComment('')
      })
    } else {
      setQuestions([])
      setSelectedAnswers({})
      setQuestionComments({})
      setGeneralComment('')
    }
  }, [isQuestionPending, threadId, getQuestions])

  useEffect(() => {
    function onFocusInput(): void {
      textareaRef.current?.focus()
    }
    window.addEventListener('focus-input', onFocusInput)
    return () => window.removeEventListener('focus-input', onFocusInput)
  }, [])

  // Fetch slash commands whenever the active project changes
  useEffect(() => {
    fetchSlashCommands(selectedProjectId ?? null)
  }, [selectedProjectId, fetchSlashCommands])

  async function handleSend(): Promise<void> {
    // Guard against concurrent sends (e.g. rapid Enter presses before React re-renders)
    if (sendingRef.current) return

    const trimmed = value.trim()
    if ((!trimmed && attachments.length === 0) || !project) return

    sendingRef.current = true

    // Snapshot state before any async work
    const currentAttachments = attachments
    const currentPlanMode = planMode

    // Clear input immediately so the UI feels responsive before async work completes
    setDraft(threadId, '')
    setAttachments([])
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    try {
      // Save attachments to temp and build @ mentions
      const savedPaths: string[] = []
      for (const att of currentAttachments) {
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

      // If processing, queue the message instead of sending
      if (isProcessing) {
        queueMessage(threadId, finalContent, currentPlanMode)
        if (currentPlanMode) setPlanMode(threadId, false)
        return
      }

      // Append optimistic user message to the correct store based on active session
      const activeSessionId = useSessionStore.getState().activeSessionByThread[threadId]
      if (activeSessionId) {
        useMessageStore.getState().appendUserMessageToSession(activeSessionId, threadId, finalContent)
      } else {
        appendUserMessage(threadId, finalContent)
      }
      await send(threadId, finalContent, { planMode: currentPlanMode })
      if (currentPlanMode) setPlanMode(threadId, false)
    } finally {
      sendingRef.current = false
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    // If mention or slash popup is active, let it handle navigation keys
    if (mention.active || slashCmd.active) {
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
        // These are handled by the popup's document keydown listener
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

  // Detect '@' trigger for file or YouTrack mentions, and '/' trigger for slash commands
  const checkForMention = useCallback((text: string, cursorPos: number) => {
    const textBeforeCursor = text.slice(0, cursorPos)
    const el = textareaRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const popupPosition = { top: rect.top - 8, left: rect.left }

    // ── Slash command detection ──────────────────────────────────────────────
    const lastSlashIndex = textBeforeCursor.lastIndexOf('/')
    if (lastSlashIndex !== -1) {
      const charBeforeSlash = lastSlashIndex > 0 ? text[lastSlashIndex - 1] : ' '
      const slashQuery = text.slice(lastSlashIndex + 1, cursorPos)
      if (/\s/.test(charBeforeSlash) || lastSlashIndex === 0) {
        if (!slashQuery.includes(' ') && !slashQuery.includes('\n')) {
          setSlashCmd({ active: true, startIndex: lastSlashIndex, query: slashQuery, position: popupPosition })
          setMention((m) => (m.active ? { ...m, active: false } : m))
          return
        }
      }
    }
    setSlashCmd((s) => (s.active ? { ...s, active: false } : s))

    // ── @ mention detection ──────────────────────────────────────────────────
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

    // Determine mention type: YouTrack IDs are all-uppercase project codes (e.g. JS-, JS-123)
    const type: 'youtrack' | 'file' =
      query.length >= 1 && YOUTRACK_QUERY_REGEX.test(query) ? 'youtrack' : 'file'

    setMention({
      active: true,
      startIndex: lastAtIndex,
      query,
      position: popupPosition,
      type,
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

    // Replace @query with @relativePath (append '/' for directories)
    const insertedPath = file.isDirectory ? `${file.relativePath}/` : file.relativePath
    const before = value.slice(0, mention.startIndex)
    const after = value.slice(el.selectionStart)
    const newValue = `${before}@${insertedPath} ${after}`

    setDraft(threadId, newValue)
    setMention({ active: false, startIndex: -1, query: '', position: { top: 0, left: 0 }, type: 'file' })

    // Focus back on textarea and move cursor after inserted path
    requestAnimationFrame(() => {
      el.focus()
      const newCursorPos = mention.startIndex + insertedPath.length + 2 // +2 for '@' and space
      el.selectionStart = el.selectionEnd = newCursorPos
    })
  }, [value, mention.startIndex, threadId, setDraft])

  const closeMention = useCallback(() => {
    setMention({ active: false, startIndex: -1, query: '', position: { top: 0, left: 0 }, type: 'file' })
  }, [])

  const handleSlashSelect = useCallback((cmd: SlashCommand) => {
    const el = textareaRef.current
    if (!el) return

    const before = value.slice(0, slashCmd.startIndex)
    const after = value.slice(el.selectionStart)
    const newValue = `${before}${cmd.prompt}${after}`

    setDraft(threadId, newValue)
    setSlashCmd({ active: false, startIndex: -1, query: '', position: { top: 0, left: 0 } })

    requestAnimationFrame(() => {
      el.focus()
      const cursorPos = slashCmd.startIndex + cmd.prompt.length
      el.selectionStart = el.selectionEnd = cursorPos
      handleInput()
    })
  }, [value, slashCmd.startIndex, threadId, setDraft])

  const closeSlashCmd = useCallback(() => {
    setSlashCmd({ active: false, startIndex: -1, query: '', position: { top: 0, left: 0 } })
  }, [])

  const handleYouTrackSelect = useCallback((issueId: string) => {
    const el = textareaRef.current
    if (!el) return

    const before = value.slice(0, mention.startIndex)
    const after = value.slice(el.selectionStart)
    const newValue = `${before}@${issueId} ${after}`

    setDraft(threadId, newValue)
    setMention({ active: false, startIndex: -1, query: '', position: { top: 0, left: 0 }, type: 'file' })

    requestAnimationFrame(() => {
      el.focus()
      const newCursorPos = mention.startIndex + issueId.length + 2 // +2 for '@' and space
      el.selectionStart = el.selectionEnd = newCursorPos
    })
  }, [value, mention.startIndex, threadId, setDraft])

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

      {locationPathMissing && location && (
        <MissingLocationBanner location={location} />
      )}

      {cliUnavailable && (
        <CliUnavailableBanner status={cliHealth?.status === 'error' ? 'error' : 'unavailable'} error={cliHealth?.error ?? undefined} />
      )}

      {status === 'error' && (
        <ErrorBanner />
      )}

      {isPlanPending && (
        <PlanBanner
          threadId={threadId}
          onReject={rejectPlan}
          onApprove={approvePlan}
          onNewContext={(id) => {
            window.api.invoke('threads:executePlanInNewContext', id)
          }}
        />
      )}

      {isQuestionPending && questions.length > 0 && (
        <QuestionBanner
          questions={questions}
          selectedAnswers={selectedAnswers}
          questionComments={questionComments}
          generalComment={generalComment}
          setSelectedAnswers={setSelectedAnswers}
          setQuestionComments={setQuestionComments}
          setGeneralComment={setGeneralComment}
          onSubmit={() => answerQuestion(threadId, selectedAnswers, questionComments, generalComment)}
        />
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

        <ComposerToolbar
          threadId={threadId}
          planMode={planMode}
          setPlanMode={setPlanMode}
          isProcessing={isProcessing}
          isLocalLocation={isLocalLocation}
          currentThread={currentThread}
          availableDistros={availableDistros}
          setYolo={setYolo}
          setWsl={setWsl}
          setProviderAndModel={setProviderAndModel}
          setModel={setModel}
          showCodexWslWarning={showCodexWslWarning}
          elapsedSeconds={elapsedSeconds}
        />

        {/* Attachment previews above textarea */}
        {attachments.length > 0 && (
          <div className="px-3 pt-3">
            <AttachmentPreview
              attachments={attachments}
              onRemove={removeAttachment}
              disabled={isProcessing}
              inline
            />
          </div>
        )}

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
            placeholder={
              cliUnavailable
                ? 'CLI not available — input disabled'
                : isProcessing
                  ? (queuedMessage ? 'Message already queued...' : 'Type to queue a message...')
                  : 'Ask Claude... (! for shell mode, / for slash commands, @ for files, @JS-123 for YouTrack)'
            }
            disabled={isPlanPending || isQuestionPending || cliUnavailable}
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
              {/* Queue button — hidden while stopping */}
              {!isStopping && (
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
              )}
              {/* Stop button — disabled while already stopping */}
              <button
                onClick={() => !isStopping && stop(threadId)}
                disabled={isStopping}
                className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg transition-all duration-150"
                style={{
                  background: isStopping
                    ? 'var(--color-surface-2)'
                    : 'linear-gradient(135deg, #f87171 0%, #ef4444 100%)',
                  boxShadow: isStopping ? 'none' : '0 2px 8px rgba(248, 113, 113, 0.3)',
                  opacity: isStopping ? 0.5 : 1,
                  cursor: isStopping ? 'not-allowed' : 'pointer',
                }}
                title={isStopping ? 'Stopping…' : 'Stop generation'}
              >
                <StopIcon className={isStopping ? 'text-gray-500' : 'text-white'} />
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
      {mention.active && mention.type === 'file' && location?.path && (
        <FileMentionPopup
          projectPath={location.path}
          query={mention.query}
          onSelect={handleFileSelect}
          onClose={closeMention}
          position={mention.position}
        />
      )}

      {/* YouTrack issue mention popup */}
      {mention.active && mention.type === 'youtrack' && youtrackServers.length > 0 && (
        <YouTrackMentionPopup
          servers={youtrackServers}
          query={mention.query}
          onSelect={handleYouTrackSelect}
          onClose={closeMention}
          position={mention.position}
        />
      )}

      {/* Slash command popup */}
      {slashCmd.active && slashCommands.length > 0 && (
        <SlashCommandPopup
          commands={slashCommands}
          query={slashCmd.query}
          onSelect={handleSlashSelect}
          onClose={closeSlashCmd}
          position={slashCmd.position}
        />
      )}
    </div>
  )
}
