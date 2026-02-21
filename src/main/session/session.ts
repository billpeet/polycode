import { BrowserWindow } from 'electron'
import { ClaudeDriver } from '../driver/claude'
import { OutputEvent, ThreadStatus, SendOptions, Question, Session as SessionInfo } from '../../shared/types'
import {
  updateThreadStatus,
  updateThreadName,
  insertMessage,
  getThreadModel,
  getOrCreateActiveSession,
  createSession,
  listSessions,
  setActiveSession,
  updateSessionClaudeId,
  getSessionClaudeId
} from '../db/queries'
import { generateTitle } from '../claude-sdk'

export class Session {
  readonly threadId: string
  private drivers = new Map<string, ClaudeDriver>()
  private activeSessionId: string | null = null
  private window: BrowserWindow
  private workingDir: string
  private messageCountBySession = new Map<string, number>()
  private planPending = false
  private pendingPlanContent: string | null = null
  private questionPending = false
  private pendingQuestions: Question[] = []

  constructor(threadId: string, workingDir: string, window: BrowserWindow) {
    this.threadId = threadId
    this.workingDir = workingDir
    this.window = window

    // Load or create initial session
    const session = getOrCreateActiveSession(threadId)
    this.activeSessionId = session.id
    this.initDriver(session.id, session.claude_session_id)
  }

  private initDriver(sessionId: string, claudeSessionId: string | null): ClaudeDriver {
    const model = getThreadModel(this.threadId)
    const driver = new ClaudeDriver({
      workingDir: this.workingDir,
      threadId: this.threadId,
      model,
      initialSessionId: claudeSessionId,
      onSessionId: (sid) => updateSessionClaudeId(sessionId, sid)
    })
    this.drivers.set(sessionId, driver)
    return driver
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

    this.setStatus('running')
    this.planPending = false
    this.pendingPlanContent = null
    this.questionPending = false
    this.pendingQuestions = []

    // Persist to DB with session ID
    insertMessage(this.threadId, 'user', content, undefined, this.activeSessionId)

    const count = (this.messageCountBySession.get(this.activeSessionId) ?? 0) + 1
    this.messageCountBySession.set(this.activeSessionId, count)

    if (count === 1) {
      this.triggerAutoTitle(content)
    }

    driver.sendMessage(
      content,
      (event: OutputEvent) => this.handleEvent(event),
      (error?: Error) => this.handleDone(error),
      { planMode: options?.planMode }
    )
  }

  stop(): void {
    if (this.activeSessionId) {
      const driver = this.drivers.get(this.activeSessionId)
      driver?.stop()
    }
    this.setStatus('stopped')
  }

  isRunning(): boolean {
    if (!this.activeSessionId) return false
    const driver = this.drivers.get(this.activeSessionId)
    return driver?.isRunning() ?? false
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
  answerQuestion(answers: Record<string, string>): void {
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
        qaLines.push('')
      }
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
    const answerText = Object.entries(answers)
      .map(([question, answer]) => `${question}: ${answer}`)
      .join('\n')

    driver.sendMessage(
      answerText,
      (event: OutputEvent) => this.handleEvent(event),
      (error?: Error) => this.handleDone(error)
    )
  }

  private handleEvent(event: OutputEvent): void {
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
    }
  }

  private handleDone(error?: Error): void {
    // Always ensure status transitions to a terminal state
    if (error) {
      this.window.webContents.send(`thread:output:${this.threadId}`, {
        type: 'error',
        content: error.message,
        sessionId: this.activeSessionId
      } satisfies OutputEvent)
      this.setStatus('error')
    } else if (this.planPending) {
      // Plan mode completed — waiting for user approval
      this.setStatus('plan_pending')
    } else if (this.questionPending) {
      // Question asked — waiting for user answer
      this.setStatus('question_pending')
    } else {
      // Response complete — idle and ready for next message
      this.setStatus('idle')
    }
    // Send complete event AFTER status update to ensure correct ordering
    this.window.webContents.send(`thread:complete:${this.threadId}`)
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
