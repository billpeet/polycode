import { useState, useRef, useEffect, useCallback } from 'react'
import type { Editor } from '@tiptap/react'
import { useThreadStore } from '../stores/threads'
import { useMessageStore } from '../stores/messages'
import { useProjectStore } from '../stores/projects'
import { useLocationStore } from '../stores/locations'
import { useToastStore } from '../stores/toast'
import { useSessionStore } from '../stores/sessions'
import {
  Question,
  QuestionAnswerValue,
  PermissionRequest,
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
import ComposerEditor, { ComposerTrigger } from './input-bar/ComposerEditor'
import FormatToolbar from './input-bar/FormatToolbar'
import { composerHighlightPluginKey } from './input-bar/composerHighlight'
import { CliUnavailableBanner, ErrorBanner, MissingLocationBanner, PermissionBanner, PlanBanner, QuestionBanner } from './input-bar/Banners'
import { PaperclipIcon, QueueIcon, SendIcon, StopIcon } from './input-bar/icons'
import { formatErrorDetails } from '../lib/errorDetails'

interface Props {
  threadId: string
}

const EMPTY_THREADS: Thread[] = []
const EMPTY_LOCATIONS: RepoLocation[] = []
const EMPTY_SLASH_COMMANDS: SlashCommand[] = []

/** An active '@'/'/' trigger plus the popup anchor position. */
interface PopupState extends ComposerTrigger {
  position: { top: number; left: number }
}

export default function InputBar({ threadId }: Props) {
  const [isFocused, setIsFocused] = useState(false)
  const [editor, setEditor] = useState<Editor | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [questions, setQuestions] = useState<Question[]>([])
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, QuestionAnswerValue>>({})
  const [questionComments, setQuestionComments] = useState<Record<string, string>>({})
  const [generalComment, setGeneralComment] = useState('')
  const [permissions, setPermissions] = useState<PermissionRequest[]>([])
  const [popup, setPopup] = useState<PopupState | null>(null)
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [selectedSkills, setSelectedSkills] = useState<Array<{ name: string; path: string; invocation: string }>>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const runStartedAt = useThreadStore((s) => s.runStartedAtByThread[threadId] ?? 0)

  const send = useThreadStore((s) => s.send)
  const stop = useThreadStore((s) => s.stop)
  const approvePlan = useThreadStore((s) => s.approvePlan)
  const rejectPlan = useThreadStore((s) => s.rejectPlan)
  const getQuestions = useThreadStore((s) => s.getQuestions)
  const answerQuestion = useThreadStore((s) => s.answerQuestion)
  const getPermissions = useThreadStore((s) => s.getPermissions)
  const approvePermissions = useThreadStore((s) => s.approvePermissions)
  const denyPermissions = useThreadStore((s) => s.denyPermissions)
  const status = useThreadStore((s) => s.statusMap[threadId] ?? 'idle')
  const value = useThreadStore((s) => s.draftByThread[threadId] ?? '')
  const setDraft = useThreadStore((s) => s.setDraft)
  const planMode = useThreadStore((s) => s.planModeByThread[threadId] ?? false)
  const setPlanMode = useThreadStore((s) => s.setPlanMode)
  const fastMode = useThreadStore((s) => s.fastModeByThread[threadId] ?? false)
  const setFastMode = useThreadStore((s) => s.setFastMode)
  const queueMessage = useThreadStore((s) => s.queueMessage)
  const queuedMessage = useThreadStore((s) => s.queuedMessageByThread[threadId] ?? null)
  const appendUserMessage = useMessageStore((s) => s.appendUserMessage)

  const projects = useProjectStore((s) => s.projects)
  const threadProjectId = useThreadStore((s) =>
    Object.entries(s.byProject).find(([, threads]) => threads?.some((t) => t.id === threadId))?.[0] ?? null
  )
  const project = projects.find((p) => p.id === threadProjectId)
  const projectThreads = useThreadStore((s) => threadProjectId ? (s.byProject[threadProjectId] ?? EMPTY_THREADS) : EMPTY_THREADS)
  const currentThread = projectThreads.find((t) => t.id === threadId)
  const isPendingThread = !!currentThread?.is_pending
  const projectLocations = useLocationStore((s) => threadProjectId ? (s.byProject[threadProjectId] ?? EMPTY_LOCATIONS) : EMPTY_LOCATIONS)
  const location = currentThread?.location_id ? projectLocations.find((l) => l.id === currentThread.location_id) : null
  const addToast = useToastStore((s) => s.add)

  const [locationPathMissing, setLocationPathMissing] = useState(false)

  useEffect(() => {
    setSelectedSkills([])
  }, [threadId])

  // Check if the thread's local location path exists
  useEffect(() => {
    if (isPendingThread) return
    if (!location || location.connection_type !== 'local') {
      setLocationPathMissing(false)
      return
    }
    window.api.invoke('locations:pathExists', location.path).then((exists) => {
      setLocationPathMissing(!exists)
    }).catch(() => {})
  }, [location, isPendingThread])

  const cliHealth = useCliHealthStore((s) => s.healthByThread[threadId])
  const cliUnavailable = cliHealth?.status === 'unavailable' || cliHealth?.status === 'error'

  // Provider / model / WSL selectors (moved from ThreadHeader)
  const setProviderAndModel = useThreadStore((s) => s.setProviderAndModel)
  const setModel = useThreadStore((s) => s.setModel)
  const setReasoningLevel = useThreadStore((s) => s.setReasoningLevel)
  const setCodexPersonality = useThreadStore((s) => s.setCodexPersonality)
  const setCodexReasoningSummary = useThreadStore((s) => s.setCodexReasoningSummary)
  const setCursorThinking = useThreadStore((s) => s.setCursorThinking)
  const setCursorContext = useThreadStore((s) => s.setCursorContext)
  const setPermissionMode = useThreadStore((s) => s.setPermissionMode)
  const setWsl = useThreadStore((s) => s.setWsl)

  const [availableDistros, setAvailableDistros] = useState<string[]>([])
  const isLocalLocation = location?.connection_type === 'local'

  useEffect(() => {
    if (isPendingThread) return
    if (!isLocalLocation) return
    const timeoutId = window.setTimeout(() => {
      window.api.invoke('wsl:list-distros').then(setAvailableDistros).catch(() => {})
    }, 250)
    return () => window.clearTimeout(timeoutId)
  }, [isLocalLocation, isPendingThread])

  // Run a CLI health check whenever the effective provider/connection configuration changes
  const checkCliHealth = useCliHealthStore((s) => s.check)
  const clearCliHealth = useCliHealthStore((s) => s.clear)
  useEffect(() => {
    if (isPendingThread) {
      clearCliHealth(threadId)
      return
    }
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
    const timeoutId = window.setTimeout(() => {
      checkCliHealth(threadId, provider, effectiveConnectionType, location.ssh ?? null, wslConfig)
    }, 750)
    return () => window.clearTimeout(timeoutId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentThread?.provider, currentThread?.use_wsl, currentThread?.wsl_distro, location?.connection_type, location?.id, threadId, isPendingThread, clearCliHealth, checkCliHealth])

  const youtrackServers = useYouTrackStore((s) => s.servers)
  const slashCommandsByScope = useSlashCommandStore((s) => s.commandsByScope)
  const fetchSlashCommands = useSlashCommandStore((s) => s.fetch)
  const slashCommands = slashCommandsByScope[threadProjectId ?? 'global'] ?? slashCommandsByScope['global'] ?? EMPTY_SLASH_COMMANDS
  const sendingRef = useRef(false)

  const isProcessing = status === 'running' || status === 'stopping'
  const isStopping = status === 'stopping'
  const isPlanPending = status === 'plan_pending'
  const isQuestionPending = status === 'question_pending'
  const isPermissionPending = status === 'permission_pending'
  const supportsLiveInput = currentThread?.provider === 'claude-code' || currentThread?.provider === 'codex' || currentThread?.provider === 'pi'
  const hasContent = value.trim().length > 0 || attachments.length > 0
  // Can send when idle and has content, location path exists, and CLI is available
  const canSend = !isPendingThread && !isProcessing && !isPlanPending && !isQuestionPending && !isPermissionPending && hasContent && !locationPathMissing && !cliUnavailable
  // Can queue only when actively running (not while stopping) and no existing queue
  const canQueue = !isPendingThread && status === 'running' && !queuedMessage && hasContent && !locationPathMissing && !cliUnavailable
  const canInject = !isPendingThread && status === 'running' && supportsLiveInput && hasContent && !locationPathMissing && !cliUnavailable

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

  // Fetch permissions when status changes to permission_pending
  useEffect(() => {
    if (isPermissionPending) {
      getPermissions(threadId).then(setPermissions)
    } else {
      setPermissions([])
    }
  }, [isPermissionPending, threadId, getPermissions])

  useEffect(() => {
    function onFocusInput(): void {
      editor?.commands.focus()
    }
    window.addEventListener('focus-input', onFocusInput)
    return () => window.removeEventListener('focus-input', onFocusInput)
  }, [editor])

  // Keep the composer's known command/skill invocations up to date so it can
  // highlight them, and refresh the highlight decorations when the list changes.
  const knownCommandsRef = useRef<ReadonlySet<string>>(new Set())
  useEffect(() => {
    knownCommandsRef.current = new Set(slashCommands.map((c) => c.invocation ?? `/${c.name}`))
    if (editor && !editor.isDestroyed) {
      editor.view.dispatch(editor.state.tr.setMeta(composerHighlightPluginKey, true))
    }
  }, [slashCommands, editor])
  const getKnownCommands = useCallback(() => knownCommandsRef.current, [])

  // Fetch slash commands and harness skills whenever the active project/provider/location changes
  useEffect(() => {
    const provider = (currentThread?.provider ?? 'claude-code') as Provider
    const cwd = location?.connection_type === 'local' ? location.path : null
    fetchSlashCommands(threadProjectId ?? null, provider, cwd)
  }, [threadProjectId, currentThread?.provider, location?.connection_type, location?.path, fetchSlashCommands])

  async function handleSend(): Promise<void> {
    // Guard against concurrent sends (e.g. rapid Enter presses before React re-renders)
    if (sendingRef.current || isPendingThread) return

    const trimmed = value.trim()
    if ((!trimmed && attachments.length === 0) || !project) return

    sendingRef.current = true

    // Snapshot state before any async work
    const currentAttachments = attachments
    const currentSkills = selectedSkills.filter((skill) => trimmed.includes(skill.invocation))
    const currentPlanMode = planMode
    const currentFastMode = fastMode
    const clientUserMessageId = globalThis.crypto.randomUUID()

    // Clear input immediately so the UI feels responsive before async work completes
    setDraft(threadId, '')
    setAttachments([])
    setSelectedSkills([])

    try {
      // Save attachments to temp and build @ mentions
      const savedAttachments: Array<{ path: string; type: PendingAttachment['type'] }> = []
      for (const att of currentAttachments) {
        if (att.dataUrl) {
          const { tempPath } = await window.api.invoke(
            'attachments:save',
            att.dataUrl,
            att.name,
            threadId
          )
          savedAttachments.push({ path: tempPath, type: att.type })
        } else if (att.tempPath) {
          savedAttachments.push({ path: att.tempPath, type: att.type })
        }
      }

      // Build final message with @ mentions for attachments
      let finalContent = trimmed
      if (savedAttachments.length > 0) {
        const mentions = savedAttachments.map(({ path }) => `@${path}`).join(' ')
        finalContent = finalContent ? `${mentions}\n\n${trimmed}` : mentions
      }
      const sendOptions = {
        planMode: currentPlanMode,
        fastMode: currentFastMode,
        clientUserMessageId,
        attachments: savedAttachments
          .filter((attachment) => attachment.type === 'image')
          .map((attachment) => ({ path: attachment.path, detail: 'auto' as const })),
        skills: currentSkills,
      }

      // Claude, Codex, and Pi support live input while the provider is still running.
      if (canInject) {
        const activeSessionId = useSessionStore.getState().activeSessionByThread[threadId]
        if (activeSessionId) {
          useMessageStore.getState().appendUserMessageToSession(activeSessionId, threadId, finalContent, clientUserMessageId)
        } else {
          appendUserMessage(threadId, finalContent, clientUserMessageId)
        }
        await send(threadId, finalContent, sendOptions)
        if (currentPlanMode) setPlanMode(threadId, false)
        return
      }

      // Providers without live input support still queue the message.
      if (isProcessing) {
        queueMessage(threadId, finalContent, sendOptions)
        if (currentPlanMode) setPlanMode(threadId, false)
        return
      }

      // Append optimistic user message to the correct store based on active session
      const activeSessionId = useSessionStore.getState().activeSessionByThread[threadId]
      if (activeSessionId) {
        useMessageStore.getState().appendUserMessageToSession(activeSessionId, threadId, finalContent, clientUserMessageId)
      } else {
        appendUserMessage(threadId, finalContent, clientUserMessageId)
      }
      await send(threadId, finalContent, sendOptions)
      if (currentPlanMode) setPlanMode(threadId, false)
    } finally {
      sendingRef.current = false
    }
  }

  const handleDraftChange = useCallback((markdown: string) => {
    setDraft(threadId, markdown)
  }, [threadId, setDraft])

  // The composer reports '@'/'/' triggers; anchor the popup above the input container
  const handleTriggerChange = useCallback((trigger: ComposerTrigger | null) => {
    if (!trigger) {
      setPopup(null)
      return
    }
    const rect = containerRef.current?.getBoundingClientRect()
    const position = rect ? { top: rect.top - 8, left: rect.left } : { top: 0, left: 0 }
    setPopup({ ...trigger, position })
  }, [])

  const closePopup = useCallback(() => {
    setPopup(null)
  }, [])

  /**
   * Replace the active trigger range ('@query' or '/query') with the given text.
   * Newlines become hard breaks so multi-line prompts insert correctly.
   */
  const insertAtTrigger = useCallback((text: string) => {
    if (!editor || !popup) return
    const content: Array<{ type: string; text?: string }> = []
    text.split('\n').forEach((part, i) => {
      if (i > 0) content.push({ type: 'hardBreak' })
      if (part.length > 0) content.push({ type: 'text', text: part })
    })
    editor.chain().focus().insertContentAt({ from: popup.from, to: popup.to }, content).run()
    setPopup(null)
  }, [editor, popup])

  const handleFileSelect = useCallback((file: SearchableFile) => {
    // Replace @query with @relativePath (append '/' for directories)
    const insertedPath = file.isDirectory ? `${file.relativePath}/` : file.relativePath
    insertAtTrigger(`@${insertedPath} `)
  }, [insertAtTrigger])

  const handleYouTrackSelect = useCallback((issueId: string) => {
    insertAtTrigger(`@${issueId} `)
  }, [insertAtTrigger])

  const handleSlashSelect = useCallback((cmd: SlashCommand) => {
    // Track selected skills so send() can pass them to the provider
    if (cmd.kind === 'skill' && cmd.path) {
      setSelectedSkills((skills) => skills.some((skill) => skill.path === cmd.path)
        ? skills
        : [...skills, { name: cmd.name, path: cmd.path!, invocation: cmd.invocation ?? cmd.prompt }])
    }
    insertAtTrigger(cmd.prompt)
  }, [insertAtTrigger])

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
      addToast({
        type: 'error',
        title: 'Unsupported Attachment',
        message: `Unsupported file type: ${file.type || 'unknown'}`,
        details: formatErrorDetails({
          action: 'attachment:add',
          threadId,
          fileName: file.name,
          mimeType: file.type || null,
          size: file.size,
          supportedTypes: Object.keys(SUPPORTED_ATTACHMENT_TYPES),
        }),
      })
      return
    }

    // Validate size
    if (file.size > MAX_ATTACHMENT_SIZE) {
      addToast({
        type: 'error',
        title: 'Attachment Too Large',
        message: `File too large: ${file.name} (max 5MB)`,
        details: formatErrorDetails({
          action: 'attachment:add',
          threadId,
          fileName: file.name,
          mimeType: file.type || null,
          size: file.size,
          maxSize: MAX_ATTACHMENT_SIZE,
        }),
      })
      return
    }

    // Validate count
    if (attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      addToast({
        type: 'error',
        title: 'Attachment Limit Reached',
        message: `Maximum ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`,
        details: formatErrorDetails({
          action: 'attachment:add',
          threadId,
          currentCount: attachments.length,
          maxCount: MAX_ATTACHMENTS_PER_MESSAGE,
          fileName: file.name,
        }),
      })
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
      addToast({
        type: 'error',
        title: 'Attachment Read Failed',
        message: 'Could not read file',
        details: formatErrorDetails({ action: 'attachments:getFileInfo', threadId, filePath }),
      })
      return
    }

    // Validate type
    if (!Object.keys(SUPPORTED_ATTACHMENT_TYPES).includes(info.mimeType)) {
      addToast({
        type: 'error',
        title: 'Unsupported Attachment',
        message: `Unsupported file type: ${info.mimeType}`,
        details: formatErrorDetails({
          action: 'attachment:addFromPath',
          threadId,
          filePath,
          mimeType: info.mimeType,
          size: info.size,
          supportedTypes: Object.keys(SUPPORTED_ATTACHMENT_TYPES),
        }),
      })
      return
    }

    // Validate size
    if (info.size > MAX_ATTACHMENT_SIZE) {
      addToast({
        type: 'error',
        title: 'Attachment Too Large',
        message: 'File too large (max 5MB)',
        details: formatErrorDetails({
          action: 'attachment:addFromPath',
          threadId,
          filePath,
          mimeType: info.mimeType,
          size: info.size,
          maxSize: MAX_ATTACHMENT_SIZE,
        }),
      })
      return
    }

    // Validate count
    if (attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      addToast({
        type: 'error',
        title: 'Attachment Limit Reached',
        message: `Maximum ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`,
        details: formatErrorDetails({
          action: 'attachment:addFromPath',
          threadId,
          currentCount: attachments.length,
          maxCount: MAX_ATTACHMENTS_PER_MESSAGE,
          filePath,
        }),
      })
      return
    }

    // Copy to temp and get path
    const { tempPath, id, dataUrl: savedDataUrl } = await window.api.invoke('attachments:saveFromPath', filePath, threadId) as { tempPath: string; id: string; dataUrl?: string }
    const typeInfo = SUPPORTED_ATTACHMENT_TYPES[info.mimeType as keyof typeof SUPPORTED_ATTACHMENT_TYPES]
    const fileName = filePath.split(/[\\/]/).pop() ?? 'file'

    // For images, read as data URL for preview
    let dataUrl: string | undefined
    if (typeInfo.type === 'image') {
      dataUrl = savedDataUrl
      const result = dataUrl ? null : await window.api.invoke('files:read', tempPath)
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

  async function handlePasteImages(files: File[]): Promise<void> {
    for (const file of files) {
      try {
        await addAttachment(file)
      } catch (err) {
        addToast({
          type: 'error',
          title: 'Paste Attachment Failed',
          message: err instanceof Error ? err.message : 'Failed to add pasted attachment',
          details: formatErrorDetails({ action: 'attachment:paste', threadId, mimeType: file.type, fileName: file.name, size: file.size }, err),
          duration: 0,
        })
      }
    }
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
      try {
        await addAttachment(file)
      } catch (err) {
        addToast({
          type: 'error',
          title: 'Drop Attachment Failed',
          message: err instanceof Error ? err.message : 'Failed to add dropped attachment',
          details: formatErrorDetails({ action: 'attachment:drop', threadId, fileName: file.name, mimeType: file.type, size: file.size }, err),
          duration: 0,
        })
      }
    }
  }

  async function handleFilePick(): Promise<void> {
    const paths = await window.api.invoke('dialog:open-files')
    for (const filePath of paths) {
      try {
        await addAttachmentFromPath(filePath)
      } catch (err) {
        addToast({
          type: 'error',
          title: 'Attachment Failed',
          message: err instanceof Error ? err.message : 'Failed to add attachment',
          details: formatErrorDetails({ action: 'attachment:filePicker', threadId, filePath }, err),
          duration: 0,
        })
      }
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

      {isPermissionPending && permissions.length > 0 && (
        <PermissionBanner
          threadId={threadId}
          permissions={permissions}
          onApprove={approvePermissions}
          onDeny={denyPermissions}
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
        ref={containerRef}
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
          fastMode={fastMode}
          setFastMode={setFastMode}
          isProcessing={isProcessing}
          isLocalLocation={isLocalLocation}
          currentThread={currentThread}
          availableDistros={availableDistros}
          setPermissionMode={setPermissionMode}
          setWsl={setWsl}
          setProviderAndModel={setProviderAndModel}
          setModel={setModel}
          setReasoningLevel={setReasoningLevel}
          setCodexPersonality={setCodexPersonality}
          setCodexReasoningSummary={setCodexReasoningSummary}
          setCursorThinking={setCursorThinking}
          setCursorContext={setCursorContext}
          elapsedSeconds={elapsedSeconds}
        />

        {/* Rich text formatting toolbar */}
        <FormatToolbar
          editor={editor}
          disabled={isPlanPending || isQuestionPending || isPermissionPending || cliUnavailable}
        />

        {/* Attachment previews above the composer */}
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

        {/* Composer row */}
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

          <ComposerEditor
            value={value}
            onChange={handleDraftChange}
            onSend={handleSend}
            onTriggerChange={handleTriggerChange}
            onPasteImages={handlePasteImages}
            onFocusChange={setIsFocused}
            onEditorReady={setEditor}
            getKnownCommands={getKnownCommands}
            placeholder={
              isPendingThread
                ? 'Creating thread... you can type while it loads'
                : cliUnavailable
                ? 'CLI not available — input disabled'
                : isProcessing
                  ? supportsLiveInput
                    ? 'Type to send immediately...'
                    : (queuedMessage ? 'Message already queued...' : 'Type to queue a message...')
                  : 'Ask Claude... (! for shell mode, / for slash commands, @ for files, @JS-123 for YouTrack)'
            }
            disabled={isPlanPending || isQuestionPending || isPermissionPending || cliUnavailable}
          />

          {/* Send / Queue / Stop buttons */}
          {isProcessing ? (
            <>
              {!isStopping && supportsLiveInput && (
                <button
                  onClick={handleSend}
                  disabled={!canInject}
                  className="input-send-btn flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg transition-all duration-150 disabled:cursor-not-allowed"
                  style={{
                    background: canInject
                      ? 'linear-gradient(135deg, var(--color-claude) 0%, #d06a50 100%)'
                      : 'var(--color-surface-2)',
                    boxShadow: canInject ? '0 2px 8px rgba(232, 123, 95, 0.3)' : 'none',
                    opacity: canInject ? 1 : 0.4,
                  }}
                  title="Send message immediately (Enter)"
                >
                  <SendIcon className={canInject ? 'text-white' : 'text-gray-500'} />
                </button>
              )}
              {/* Queue button — hidden while stopping or when live input is supported */}
              {!isStopping && !supportsLiveInput && (
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
              {currentThread?.provider === 'codex' && (
                <button
                  onClick={() => !isStopping && stop(threadId, true)}
                  disabled={isStopping}
                  className="flex h-9 flex-shrink-0 items-center justify-center rounded-lg px-2 text-[0.65rem] font-semibold transition-all duration-150"
                  style={{
                    background: isStopping ? 'var(--color-surface-2)' : 'rgba(239, 68, 68, 0.18)',
                    border: '1px solid rgba(248, 113, 113, 0.45)',
                    color: isStopping ? '#6b7280' : '#f87171',
                    opacity: isStopping ? 0.5 : 1,
                  }}
                  title="Stop this turn and terminate all background processes from the Codex thread"
                >
                  Stop + BG
                </button>
              )}
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
          <kbd className="rounded px-1 py-0.5" style={{ background: 'var(--color-surface-2)' }}>Shift+Enter</kbd> newline
        </span>
      </div>

      {/* File mention popup */}
      {popup?.kind === 'file' && location?.path && (
        <FileMentionPopup
          projectPath={location.path}
          query={popup.query}
          onSelect={handleFileSelect}
          onClose={closePopup}
          position={popup.position}
        />
      )}

      {/* YouTrack issue mention popup */}
      {popup?.kind === 'youtrack' && youtrackServers.length > 0 && (
        <YouTrackMentionPopup
          servers={youtrackServers}
          query={popup.query}
          onSelect={handleYouTrackSelect}
          onClose={closePopup}
          position={popup.position}
        />
      )}

      {/* Slash command popup */}
      {popup?.kind === 'slash' && slashCommands.length > 0 && (
        <SlashCommandPopup
          commands={slashCommands}
          query={popup.query}
          onSelect={handleSlashSelect}
          onClose={closePopup}
          position={popup.position}
        />
      )}
    </div>
  )
}
