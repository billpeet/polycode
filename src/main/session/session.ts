import { BrowserWindow } from 'electron'
import { ClaudeDriver } from '../driver/claude'
import { CodexDriver } from '../driver/codex'
import { OpenCodeDriver } from '../driver/opencode'
import { CLIDriver } from '../driver/types'
import { OutputEvent, ThreadStatus, SendOptions, Question, Session as SessionInfo, SshConfig, WslConfig } from '../../shared/types'
import {
  updateThreadStatus,
  updateThreadName,
  insertMessage,
  getThreadModel,
  getThreadProvider,
  getOrCreateActiveSession,
  createSession,
  listSessions,
  setActiveSession,
  updateSessionClaudeId,
  getSessionClaudeId,
  updateThreadUsage,
  cancelPendingToolCalls
} from '../db/queries'
import { generateTitle } from '../claude-sdk'

export class Session {
  readonly threadId: string
  private drivers = new Map<string, CLIDriver>()
  private activeSessionId: string | null = null
  private window: BrowserWindow
  private workingDir: string
  private sshConfig: SshConfig | null
  private wslConfig: WslConfig | null
  private messageCountBySession = new Map<string, number>()
  private planPending = false
  private pendingPlanContent: string | null = null
  private questionPending = false
  private pendingQuestions: Question[] = []
  private stopped = false

  constructor(threadId: string, workingDir: string, window: BrowserWindow, sshConfig?: SshConfig | null, wslConfig?: WslConfig | null) {
    this.threadId = threadId
    this.workingDir = workingDir
    this.window = window
    this.sshConfig = sshConfig ?? null
    this.wslConfig = wslConfig ?? null

    // Load or create initial session
    const session = getOrCreateActiveSession(threadId)
    this.activeSessionId = session.id
    this.initDriver(session.id, session.claude_session_id)
  }

  private initDriver(sessionId: string, externalSessionId: string | null): CLIDriver {
    const model = getThreadModel(this.threadId)
    const provider = getThreadProvider(this.threadId)
    const options = {
      workingDir: this.workingDir,
      threadId: this.threadId,
      model,
      initialSessionId: externalSessionId,
      onSessionId: (sid: string) => updateSessionClaudeId(sessionId, sid),
      ssh: this.sshConfig,
      wsl: this.wslConfig,
    }
    const driver: CLIDriver = provider === 'codex'
      ? new CodexDriver(options)
      : provider === 'opencode'
      ? new OpenCodeDriver(options)
      : new ClaudeDriver(options)
    this.drivers.set(sessionId, driver)
    return driver
  }

  /** Returns true if the ssh/wsl transport config differs from what this session was created with. */
  transportChanged(sshConfig?: SshConfig | null, wslConfig?: WslConfig | null): boolean {
    const newSshHost = sshConfig?.host ?? null
    const curSshHost = this.sshConfig?.host ?? null
    const newWslDistro = wslConfig?.distro ?? null
    const curWslDistro = this.wslConfig?.distro ?? null
    return newSshHost !== curSshHost || newWslDistro !== curWslDistro
  }

  start(): void {
    this.setStatus('idle')
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId
  }

  getSessions(): SessionInfo[] {
    return listSessions(this.threadId)
  }

  switchSession(sessionId: string): void {
    // Stop current driver if running
    if (this.activeSessionId) {
      const currentDriver = this.drivers.get(this.activeSessionId)
      if (currentDriver?.isRunning()) {
        currentDriver.stop()
      }
    }

    this.activeSessionId = sessionId
    setActiveSession(this.threadId, sessionId)

    // Ensure driver exists for this session
    if (!this.drivers.has(sessionId)) {
      const claudeSessionId = getSessionClaudeId(sessionId)
      this.initDriver(sessionId, claudeSessionId)
    }

    // Notify renderer of session switch
    this.window.webContents.send(`thread:session-switched:${this.threadId}`, sessionId)
    this.setStatus('idle')
  }

  createNewSession(name: string): string {
    const session = createSession(this.threadId, name)
    this.initDriver(session.id, null) // Fresh context, no --resume
    return session.id
  }

  /** Execute the pending plan in a new session context */
  executePlanInNewContext(): void {
    if (!this.planPending || !this.pendingPlanContent) return

    const sessions = listSessions(this.threadId)
    const executionCount = sessions.filter((s) => s.name.startsWith('Execution')).length
    // First execution is just "Execution", subsequent ones are "Execution 2", "Execution 3", etc.
    const sessionName = executionCount === 0 ? 'Execution' : `Execution ${executionCount + 1}`
    const newSessionId = this.createNewSession(sessionName)

    // Switch to new session
    this.switchSession(newSessionId)

    // Clear plan pending state
    this.planPending = false
    const planContent = this.pendingPlanContent
    this.pendingPlanContent = null

    // Send the plan to the new context for execution
    this.sendMessage(`Execute this plan:\n\n${planContent}`, { planMode: false })
  }

  sendMessage(content: string, options?: SendOptions): void {
    if (!this.activeSessionId) return

    const driver = this.drivers.get(this.activeSessionId)
    if (!driver) return

    if (driver.isRunning()) {
      console.warn('[Session] sendMessage called while driver is already running — ignoring for thread', this.threadId)
      return
    }

    this.setStatus('running')
    this.stopped = false
    this.planPending = false
    this.pendingPlanContent = null
    this.questionPending = false
    this.pendingQuestions = []

    // Persist to DB with session ID
    insertMessage(this.threadId, 'user', content, undefined, this.activeSessionId)

    const count = (this.messageCountBySession.get(this.activeSessionId) ?? 0) + 1
    this.messageCountBySession.set(this.activeSessionId, count)

    if (count === 1) {
      // Set a provisional title immediately from the message content so the
      // sidebar updates before the AI-generated title arrives.
      const provisional = content.split('\n')[0].trim().slice(0, 80)
      if (provisional) {
        updateThreadName(this.threadId, provisional)
        this.window.webContents.send(`thread:title:${this.threadId}`, provisional)
      }
      this.triggerAutoTitle(content)
    }

    driver.sendMessage(
      content,
      (event: OutputEvent) => this.handleEvent(event),
      (error?: Error) => this.handleDone(error),
      { planMode: options?.planMode }
    )

    // Broadcast the spawned PID to the renderer for visibility
    const pid = driver.getPid()
    this.window.webContents.send(`thread:pid:${this.threadId}`, pid)
  }

  stop(): void {
    this.stopped = true
    if (this.activeSessionId) {
      const driver = this.drivers.get(this.activeSessionId)
      driver?.stop()
    }
    // Do NOT call setStatus('stopped') here — wait for the process to actually
    // exit (the close event fires handleDone which sets the final status).
    // This ensures the UI is never updated while the process is still running.
  }

  isRunning(): boolean {
    if (!this.activeSessionId) return false
    const driver = this.drivers.get(this.activeSessionId)
    return driver?.isRunning() ?? false
  }

  getPid(): number | null {
    if (!this.activeSessionId) return null
    const driver = this.drivers.get(this.activeSessionId)
    return driver?.getPid() ?? null
  }

  /** Approve pending plan and continue execution in the same session */
  approvePlan(): void {
    if (!this.planPending || !this.activeSessionId) return

    const driver = this.drivers.get(this.activeSessionId)
    if (!driver) return

    this.planPending = false
    this.pendingPlanContent = null
    this.setStatus('running')

    driver.sendMessage(
      'Approved. Execute the plan.',
      (event: OutputEvent) => this.handleEvent(event),
      (error?: Error) => this.handleDone(error)
    )
    this.window.webContents.send(`thread:pid:${this.threadId}`, driver.getPid())
  }

  /** Reject pending plan and return to idle */
  rejectPlan(): void {
    if (!this.planPending) return
    this.planPending = false
    this.pendingPlanContent = null
    this.setStatus('idle')

    if (this.activeSessionId) {
      insertMessage(this.threadId, 'system', 'Plan rejected by user.', undefined, this.activeSessionId)
    }

    this.window.webContents.send(`thread:output:${this.threadId}`, {
      type: 'text',
      content: 'Plan rejected.',
      sessionId: this.activeSessionId
    } satisfies OutputEvent)
  }

  /** Get pending questions */
  getPendingQuestions(): Question[] {
    return this.pendingQuestions
  }

  /** Answer pending question and continue execution */
  answerQuestion(answers: Record<string, string>, questionComments: Record<string, string> = {}, generalComment = ''): void {
    if (!this.questionPending || !this.activeSessionId) return

    const driver = this.drivers.get(this.activeSessionId)
    if (!driver) return

    // Build a nice formatted Q&A for display and persistence
    const qaLines: string[] = []
    for (const q of this.pendingQuestions) {
      const answer = answers[q.question]
      if (answer) {
        qaLines.push(`**${q.header}**: ${q.question}`)
        qaLines.push(`→ ${answer}`)
        const comment = questionComments[q.question]
        if (comment?.trim()) {
          qaLines.push(`  ↳ ${comment.trim()}`)
        }
        qaLines.push('')
      }
    }
    if (generalComment?.trim()) {
      qaLines.push(`Additional notes: ${generalComment.trim()}`)
    }
    const qaText = qaLines.join('\n').trim()

    // Persist the Q&A as a user message
    insertMessage(this.threadId, 'user', qaText, { type: 'question_answer' }, this.activeSessionId)

    // Send to renderer so it appears in the thread
    this.window.webContents.send(`thread:output:${this.threadId}`, {
      type: 'text',
      content: qaText,
      metadata: { type: 'question_answer', role: 'user' },
      sessionId: this.activeSessionId
    } satisfies OutputEvent)

    this.questionPending = false
    this.pendingQuestions = []
    this.setStatus('running')

    // Format the answer as a response message for Claude
    const answerLines = Object.entries(answers).map(([question, answer]) => {
      const comment = questionComments[question]
      return comment?.trim()
        ? `${question}: ${answer}\n  (clarification: ${comment.trim()})`
        : `${question}: ${answer}`
    })
    if (generalComment?.trim()) {
      answerLines.push(`\nAdditional clarification: ${generalComment.trim()}`)
    }
    const answerText = answerLines.join('\n')

    driver.sendMessage(
      answerText,
      (event: OutputEvent) => this.handleEvent(event),
      (error?: Error) => this.handleDone(error)
    )
    this.window.webContents.send(`thread:pid:${this.threadId}`, driver.getPid())
  }

  private handleEvent(event: OutputEvent): void {
    // Drop all events after stop is requested — the process is winding down
    // and we don't want orphaned output appearing in the UI or DB.
    if (this.stopped) return

    // Include sessionId in all events sent to renderer
    const eventWithSession: OutputEvent = { ...event, sessionId: this.activeSessionId ?? undefined }

    // Don't send question events to renderer — they're handled via UI state, not message stream
    if (event.type !== 'question') {
      this.window.webContents.send(`thread:output:${this.threadId}`, eventWithSession)
    }

    // Persist all relevant event types to DB with session ID
    switch (event.type) {
      case 'text':
        if (event.content.trim() && this.activeSessionId) {
          insertMessage(this.threadId, 'assistant', event.content, event.metadata, this.activeSessionId)
        }
        break
      case 'tool_call':
        if (this.activeSessionId) {
          insertMessage(this.threadId, 'assistant', event.content, event.metadata, this.activeSessionId)
        }
        break
      case 'tool_result':
        if (this.activeSessionId) {
          insertMessage(this.threadId, 'assistant', event.content, event.metadata, this.activeSessionId)
        }
        break
      case 'thinking':
        if (this.activeSessionId) {
          insertMessage(this.threadId, 'assistant', event.content, event.metadata, this.activeSessionId)
        }
        break
      case 'plan_ready':
        // Mark that we received a plan — will set status to plan_pending on completion
        this.planPending = true
        this.pendingPlanContent = event.content
        if (this.activeSessionId) {
          insertMessage(this.threadId, 'assistant', event.content, event.metadata, this.activeSessionId)
        }
        break
      case 'question':
        // Mark that we received a question — will set status to question_pending on completion
        this.questionPending = true
        this.pendingQuestions = (event.metadata?.questions as Question[]) ?? []
        break
      case 'error':
        if (this.activeSessionId) {
          insertMessage(this.threadId, 'system', event.content, { type: 'error' }, this.activeSessionId)
        }
        break
      case 'usage': {
        // Persist accumulated totals and latest context window snapshot
        const inputTokens = (event.metadata?.input_tokens as number) ?? 0
        const outputTokens = (event.metadata?.output_tokens as number) ?? 0
        updateThreadUsage(this.threadId, inputTokens, outputTokens, inputTokens)
        break
      }
    }
  }

  private handleDone(error?: Error): void {
    // Clear the PID — the process has exited
    this.window.webContents.send(`thread:pid:${this.threadId}`, null)

    // If the user intentionally stopped the session, keep the stopped status
    // regardless of how the process exited (non-zero exit from SIGTERM looks
    // like an error but shouldn't be treated as one).
    if (this.stopped) {
      if (this.activeSessionId) {
        const cancelled = cancelPendingToolCalls(this.threadId, this.activeSessionId)
        for (const msg of cancelled) {
          this.window.webContents.send(`thread:output:${this.threadId}`, {
            type: 'tool_result',
            content: '',
            metadata: { type: 'tool_result', tool_use_id: (JSON.parse(msg.metadata!) as Record<string, unknown>).tool_use_id, cancelled: true },
            sessionId: this.activeSessionId,
          } satisfies OutputEvent)
        }
      }
      this.setStatus('stopped')
      this.window.webContents.send(`thread:complete:${this.threadId}`, 'stopped')
      return
    }

    // Always ensure status transitions to a terminal state
    let finalStatus: ThreadStatus
    if (error) {
      this.window.webContents.send(`thread:output:${this.threadId}`, {
        type: 'error',
        content: error.message,
        sessionId: this.activeSessionId
      } satisfies OutputEvent)
      finalStatus = 'error'
    } else if (this.planPending) {
      // Plan mode completed — waiting for user approval
      finalStatus = 'plan_pending'
    } else if (this.questionPending) {
      // Question asked — waiting for user answer
      finalStatus = 'question_pending'
    } else {
      // Response complete — idle and ready for next message
      finalStatus = 'idle'
    }
    // Cancel any tool calls that never received a result, and push synthetic
    // tool_result events to the renderer before the complete signal.
    if (this.activeSessionId) {
      const cancelled = cancelPendingToolCalls(this.threadId, this.activeSessionId)
      for (const msg of cancelled) {
        this.window.webContents.send(`thread:output:${this.threadId}`, {
          type: 'tool_result',
          content: '',
          metadata: { type: 'tool_result', tool_use_id: (JSON.parse(msg.metadata!) as Record<string, unknown>).tool_use_id, cancelled: true },
          sessionId: this.activeSessionId,
        } satisfies OutputEvent)
      }
    }

    this.setStatus(finalStatus)
    // Include final status in complete event so the renderer doesn't depend
    // on the separate thread:status event having been processed first
    this.window.webContents.send(`thread:complete:${this.threadId}`, finalStatus)
  }

  private setStatus(status: ThreadStatus): void {
    updateThreadStatus(this.threadId, status)
    this.window.webContents.send(`thread:status:${this.threadId}`, status)
  }

  private triggerAutoTitle(seed: string): void {
    // Use Claude Agent SDK with Haiku for fast, lightweight title generation
    generateTitle(seed)
      .then((title) => {
        if (!title) return
        updateThreadName(this.threadId, title)
        this.window.webContents.send(`thread:title:${this.threadId}`, title)
      })
      .catch((err) => {
        console.error('[auto-title]', err.message)
      })
  }
}
