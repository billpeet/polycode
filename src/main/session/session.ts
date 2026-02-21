import { BrowserWindow } from 'electron'
import { ClaudeDriver } from '../driver/claude'
import { OutputEvent, ThreadStatus, SendOptions, Question } from '../../shared/types'
import { updateThreadStatus, updateThreadName, insertMessage, getThreadSessionId, updateThreadSessionId, getThreadModel } from '../db/queries'

export class Session {
  readonly threadId: string
  private driver: ClaudeDriver
  private window: BrowserWindow
  private workingDir: string
  private messageCount = 0
  private planPending = false
  private questionPending = false
  private pendingQuestions: Question[] = []

  constructor(threadId: string, workingDir: string, window: BrowserWindow) {
    this.threadId = threadId
    this.workingDir = workingDir
    this.window = window
    const initialSessionId = getThreadSessionId(threadId)
    const model = getThreadModel(threadId)
    this.driver = new ClaudeDriver({
      workingDir,
      threadId,
      model,
      initialSessionId,
      onSessionId: (sid) => updateThreadSessionId(threadId, sid),
    })
  }

  start(): void {
    this.setStatus('idle')
  }

  sendMessage(content: string, options?: SendOptions): void {
    this.setStatus('running')
    this.planPending = false  // Reset plan state for new message
    this.questionPending = false
    this.pendingQuestions = []
    // Persist to DB
    insertMessage(this.threadId, 'user', content)
    this.messageCount++
    const isFirst = this.messageCount === 1

    if (isFirst) {
      this.triggerAutoTitle(content)
    }

    this.driver.sendMessage(
      content,
      (event: OutputEvent) => this.handleEvent(event),
      (error?: Error) => this.handleDone(error),
      { planMode: options?.planMode }
    )
  }

  stop(): void {
    this.driver.stop()
    this.setStatus('stopped')
  }

  isRunning(): boolean {
    return this.driver.isRunning()
  }

  /** Approve pending plan and continue execution */
  approvePlan(): void {
    if (!this.planPending) return
    this.planPending = false
    this.setStatus('running')
    // Send approval message to continue with the plan
    // The CLI expects a simple confirmation to proceed
    this.driver.sendMessage(
      'Approved. Execute the plan.',
      (event: OutputEvent) => this.handleEvent(event),
      (error?: Error) => this.handleDone(error)
    )
  }

  /** Reject pending plan and return to idle */
  rejectPlan(): void {
    if (!this.planPending) return
    this.planPending = false
    this.setStatus('idle')
    insertMessage(this.threadId, 'system', 'Plan rejected by user.')
    this.window.webContents.send(`thread:output:${this.threadId}`, {
      type: 'text',
      content: 'Plan rejected.'
    } satisfies OutputEvent)
  }

  /** Get pending questions */
  getPendingQuestions(): Question[] {
    return this.pendingQuestions
  }

  /** Answer pending question and continue execution */
  answerQuestion(answers: Record<string, string>): void {
    if (!this.questionPending) return

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

    // Persist the Q&A as a user message (it's their answer)
    insertMessage(this.threadId, 'user', qaText, { type: 'question_answer' })

    // Send to renderer so it appears in the thread
    this.window.webContents.send(`thread:output:${this.threadId}`, {
      type: 'text',
      content: qaText,
      metadata: { type: 'question_answer', role: 'user' }
    } satisfies OutputEvent)

    this.questionPending = false
    this.pendingQuestions = []
    this.setStatus('running')

    // Format the answer as a response message for Claude
    const answerText = Object.entries(answers)
      .map(([question, answer]) => `${question}: ${answer}`)
      .join('\n')

    this.driver.sendMessage(
      answerText,
      (event: OutputEvent) => this.handleEvent(event),
      (error?: Error) => this.handleDone(error)
    )
  }

  private handleEvent(event: OutputEvent): void {
    // Don't send question events to renderer — they're handled via UI state, not message stream
    if (event.type !== 'question') {
      this.window.webContents.send(`thread:output:${this.threadId}`, event)
    }

    // Persist all relevant event types to DB
    switch (event.type) {
      case 'text':
        if (event.content.trim()) {
          insertMessage(this.threadId, 'assistant', event.content, event.metadata)
        }
        break
      case 'tool_call':
        insertMessage(this.threadId, 'assistant', event.content, event.metadata)
        break
      case 'tool_result':
        insertMessage(this.threadId, 'assistant', event.content, event.metadata)
        break
      case 'plan_ready':
        // Mark that we received a plan — will set status to plan_pending on completion
        this.planPending = true
        insertMessage(this.threadId, 'assistant', event.content, event.metadata)
        break
      case 'question':
        // Mark that we received a question — will set status to question_pending on completion
        // Don't persist as a message — it's UI-only metadata, the answer will be the persisted record
        this.questionPending = true
        this.pendingQuestions = (event.metadata?.questions as Question[]) ?? []
        break
      case 'error':
        insertMessage(this.threadId, 'system', event.content, { type: 'error' })
        break
    }
  }

  private handleDone(error?: Error): void {
    // Always ensure status transitions to a terminal state
    if (error) {
      this.window.webContents.send(`thread:output:${this.threadId}`, {
        type: 'error',
        content: error.message
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
    const prompt =
      `In 5 words or fewer, write a short title for a coding session that started with this request. ` +
      `Reply with ONLY the title, no quotes, no punctuation at the end:\n\n${seed.slice(0, 500)}`

    const titleDriver = new ClaudeDriver({
      workingDir: this.workingDir,
      threadId: `${this.threadId}-autotitle`
    })
    let acc = ''

    titleDriver.sendMessage(
      prompt,
      (event) => {
        if (event.type === 'text') acc += event.content
      },
      (err) => {
        if (err) {
          console.error('[auto-title]', err.message)
          return
        }
        const title = acc.trim().slice(0, 60)
        if (!title) return
        updateThreadName(this.threadId, title)
        this.window.webContents.send(`thread:title:${this.threadId}`, title)
      }
    )
  }
}
