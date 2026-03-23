import { BrowserWindow } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { ClaudeDriver } from '../driver/claude'
import { CodexDriver } from '../driver/codex'
import { OpenCodeDriver } from '../driver/opencode'
import { CLIDriver } from '../driver/types'
import { OutputEvent, ThreadStatus, SendOptions, Question, PermissionRequest, Session as SessionInfo, SshConfig, WslConfig, Provider } from '../../shared/types'
import { logThreadEvent } from '../thread-logger'
import { shellEscape, cdTarget, buildSshBaseArgs, LOAD_NODE_MANAGERS, augmentWindowsPath } from '../driver/runner'
import {
  updateThreadStatus,
  updateThreadName,
  insertMessage,
  getThreadModel,
  getThreadProvider,
  getThreadYoloMode,
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
  private pendingQuestionRequestId: string | null = null
  private pendingQuestions: Question[] = []
  private pendingPermissionOrder: string[] = []
  private pendingPermissions = new Map<string, PermissionRequest>()
  private recentToolCalls = new Map<string, { name: string; input: Record<string, unknown> }>()
  private lastPlanFilePath: string | null = null
  private lastPlanFileName: string | null = null
  private lastMessageOptions: SendOptions | undefined
  private suppressAssistantTextForPermissionTurn = false
  private stopped = false
  private shellProcess: ChildProcess | null = null

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
      yoloMode: getThreadYoloMode(this.threadId),
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
    this.pendingQuestionRequestId = null
    this.pendingQuestions = []
    this.clearPendingPermissions()
    this.recentToolCalls.clear()
    this.lastMessageOptions = options
    this.suppressAssistantTextForPermissionTurn = false

    logThreadEvent(this.threadId, {
      ts: new Date().toISOString(),
      type: 'message_sent',
      content: content.slice(0, 500),
    })

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

    const shellMode = parseShellMode(content)
    if (shellMode.enabled) {
      this.executeShellModeCommand(shellMode.command)
    } else {
      driver.sendMessage(
        content,
        (event: OutputEvent) => this.handleEvent(event),
        (error?: Error) => this.handleDone(error),
        { planMode: options?.planMode, yoloMode: getThreadYoloMode(this.threadId) }
      )
    }

    // Broadcast the spawned PID to the renderer for visibility
    this.window.webContents.send(`thread:pid:${this.threadId}`, this.getPid())
  }

  stop(): void {
    this.stopped = true
    if (this.activeSessionId) {
      const driver = this.drivers.get(this.activeSessionId)
      for (const request of this.getPendingPermissions()) {
        if (request.source === 'native') {
          driver?.sendControlResponse(request.requestId, 'deny', 'User interrupted the turn')
        }
      }
      this.clearPendingPermissions()
      this.questionPending = false
      this.pendingQuestionRequestId = null
      this.pendingQuestions = []
      this.planPending = false
      this.pendingPlanContent = null
      driver?.stop()
    }
    if (this.shellProcess) {
      killProcessTree(this.shellProcess)
    }
    // Immediately tell the UI we're stopping, but skip the DB write — 'stopping'
    // is a transient state and we don't want it persisted (a crash would leave
    // the DB in 'stopping' which startup wouldn't know to handle).
    // The DB and final UI status are both set in handleDone() when the process exits.
    this.window.webContents.send(`thread:status:${this.threadId}`, 'stopping')
  }

  isRunning(): boolean {
    if (this.shellProcess && this.shellProcess.exitCode == null && this.shellProcess.signalCode == null) {
      return true
    }
    if (!this.activeSessionId) return false
    const driver = this.drivers.get(this.activeSessionId)
    return driver?.isRunning() ?? false
  }

  getPid(): number | null {
    if (this.shellProcess && this.shellProcess.exitCode == null && this.shellProcess.signalCode == null) {
      return this.shellProcess.pid ?? null
    }
    if (!this.activeSessionId) return null
    const driver = this.drivers.get(this.activeSessionId)
    return driver?.getPid() ?? null
  }

  private executeShellModeCommand(command: string): void {
    const toolUseId = `shell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const toolCallEvent: OutputEvent = {
      type: 'tool_call',
      content: `!${command}`,
      metadata: {
        type: 'tool_call',
        id: toolUseId,
        name: 'Bash',
        input: { command },
      },
      sessionId: this.activeSessionId ?? undefined,
    }
    this.handleEvent(toolCallEvent)

    if (!command) {
      const resultEvent: OutputEvent = {
        type: 'tool_result',
        content: 'Shell mode requires a command after "!".',
        metadata: {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: 'Shell mode requires a command after "!".',
          is_error: true,
        },
        sessionId: this.activeSessionId ?? undefined,
      }
      this.handleEvent(resultEvent)
      this.handleDone()
      return
    }

    try {
      const proc = this.spawnShellCommand(command)
      this.shellProcess = proc
      this.window.webContents.send(`thread:pid:${this.threadId}`, this.getPid())

      let stdout = ''
      let stderr = ''
      let done = false

      const finish = (error?: Error): void => {
        if (done) return
        done = true
        if (this.shellProcess === proc) {
          this.shellProcess = null
        }
        this.handleDone(error)
      }

      proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

      proc.on('error', (err) => {
        const resultEvent: OutputEvent = {
          type: 'tool_result',
          content: err.message,
          metadata: {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: err.message,
            is_error: true,
          },
          sessionId: this.activeSessionId ?? undefined,
        }
        this.handleEvent(resultEvent)
        finish(err)
      })

      proc.on('close', (code, signal) => {
        if (this.stopped) {
          finish()
          return
        }

        const sections: string[] = []
        if (stdout.trim()) sections.push(stdout.trimEnd())
        if (stderr.trim()) sections.push(stderr.trimEnd())
        if (sections.length === 0) {
          sections.push(code === 0 ? 'Command completed with no output.' : 'Command failed with no output.')
        }
        const resultText = sections.join('\n\n')
        const exitCode = code ?? null
        const isError = exitCode !== 0

        const resultEvent: OutputEvent = {
          type: 'tool_result',
          content: resultText,
          metadata: {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: resultText,
            exit_code: exitCode,
            signal: signal ?? null,
            is_error: isError,
          },
          sessionId: this.activeSessionId ?? undefined,
        }
        this.handleEvent(resultEvent)
        finish()
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const resultEvent: OutputEvent = {
        type: 'tool_result',
        content: message,
        metadata: {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: message,
          is_error: true,
        },
        sessionId: this.activeSessionId ?? undefined,
      }
      this.handleEvent(resultEvent)
      this.handleDone(new Error(message))
    }
  }

  private spawnShellCommand(command: string): ChildProcess {
    const workDir = this.workingDir || '~'

    if (this.wslConfig) {
      const innerCmd = `cd ${cdTarget(workDir)} && ${command}`
      return spawn('wsl', ['-d', this.wslConfig.distro, '--', 'bash', '-ilc', innerCmd], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    }

    if (this.sshConfig) {
      const innerCmd = `${LOAD_NODE_MANAGERS}; cd ${cdTarget(workDir)} && ${command}`
      const remoteCmd = `bash -lc ${shellEscape(innerCmd)}`
      const sshArgs = [
        ...buildSshBaseArgs(this.sshConfig),
        `${this.sshConfig.user}@${this.sshConfig.host}`,
        remoteCmd,
      ]
      return spawn('ssh', sshArgs, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    }

    if (process.platform === 'win32') {
      const sysRoot = process.env.SystemRoot ?? 'C:\\Windows'
      const cmdExe = process.env.ComSpec ?? `${sysRoot}\\System32\\cmd.exe`
      return spawn(cmdExe, ['/d', '/s', '/c', command], {
        shell: false,
        cwd: workDir,
        env: augmentWindowsPath(),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    }

    return spawn('/bin/sh', ['-c', command], {
      shell: false,
      cwd: workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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
        (error?: Error) => this.handleDone(error),
        { yoloMode: getThreadYoloMode(this.threadId) }
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

    // Capture questions before clearing
    const questions = this.pendingQuestions
    const questionRequestId = this.pendingQuestionRequestId

    // Build formatted Q&A for display/persistence and for Claude — in one pass
    const qaLines: string[] = []
    const answerLines: string[] = []

    for (const q of questions) {
      const answer = answers[q.question]
      const comment = questionComments[q.question]?.trim()
      if (!answer && !comment) continue

      // Display block
      qaLines.push(`**${q.header}**: ${q.question}`)
      if (answer) qaLines.push(`→ ${answer}`)
      if (comment) qaLines.push(`  ↳ ${comment}`)
      qaLines.push('')

      // Claude text
      let claudeLine = answer ? `${q.question}: ${answer}` : `${q.question}: (no selection)`
      if (comment) claudeLine += `\n  (clarification: ${comment})`
      answerLines.push(claudeLine)
    }

    if (generalComment?.trim()) {
      qaLines.push(`Additional notes: ${generalComment.trim()}`)
      answerLines.push(`\nAdditional clarification: ${generalComment.trim()}`)
    }

    const qaText = qaLines.join('\n').trim()
    const answerText = answerLines.join('\n')

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
    this.pendingQuestionRequestId = null
    this.pendingQuestions = []
    this.setStatus('running')

    if (questionRequestId && driver.answerQuestion) {
      const structuredAnswers: Record<string, unknown> = {}
      for (const q of questions) {
        const key = q.id ?? q.question
        const answer = answers[key] ?? answers[q.question]
        const comment = questionComments[key] ?? questionComments[q.question]
        if (answer) structuredAnswers[key] = answer
        if (comment?.trim()) structuredAnswers[`${key}_comment`] = comment.trim()
      }
      if (generalComment?.trim()) {
        structuredAnswers.general_comment = generalComment.trim()
      }
      driver.answerQuestion(questionRequestId, structuredAnswers, generalComment.trim() || undefined)
    } else {
      driver.sendMessage(
        answerText,
        (event: OutputEvent) => this.handleEvent(event),
        (error?: Error) => this.handleDone(error)
      )
    }
    this.window.webContents.send(`thread:pid:${this.threadId}`, driver.getPid())
  }

  /** Get pending permission requests */
  getPendingPermissions(): PermissionRequest[] {
    return this.pendingPermissionOrder
      .map((requestId) => this.pendingPermissions.get(requestId))
      .filter((request): request is PermissionRequest => Boolean(request))
  }

  approvePermissions(requestId?: string): void {
    const request = this.getTargetPermissionRequest(requestId)
    if (!request || !this.activeSessionId) return

    const driver = this.drivers.get(this.activeSessionId)
    if (!driver) return

    if (request.source === 'native') {
      this.removePendingPermission(request.requestId)
      driver.sendControlResponse(request.requestId, 'allow')
      this.setStatus(this.pendingPermissions.size > 0 ? 'permission_pending' : 'running')
      return
    }

    this.clearPendingPermissions()
    this.recentToolCalls.clear()
    this.setStatus('running')

    driver.sendMessage(
      'Permission granted. Retry only the action that was previously blocked by permissions, then continue from there.',
      (event: OutputEvent) => this.handleEvent(event),
      (error?: Error) => this.handleDone(error),
      { ...this.lastMessageOptions, yoloMode: true }
    )
    this.window.webContents.send(`thread:pid:${this.threadId}`, driver.getPid())
  }

  denyPermissions(requestId?: string): void {
    const request = this.getTargetPermissionRequest(requestId)
    if (!request || !this.activeSessionId) return

    if (request.source === 'native') {
      const driver = this.drivers.get(this.activeSessionId)
      driver?.sendControlResponse(request.requestId, 'deny', 'User denied permission')
      this.removePendingPermission(request.requestId)
      this.setStatus(this.pendingPermissions.size > 0 ? 'permission_pending' : 'running')
      return
    }

    this.clearPendingPermissions()
    this.recentToolCalls.clear()
    this.setStatus('idle')
  }

  private handleEvent(event: OutputEvent): void {
    // Drop all events after stop is requested — the process is winding down
    // and we don't want orphaned output appearing in the UI or DB.
    if (this.stopped) return

    logThreadEvent(this.threadId, {
      ts: new Date().toISOString(),
      type: event.type,
      content: event.content ? event.content.slice(0, 500) : undefined,
      metadata: event.metadata,
    })

    // Include sessionId in all events sent to renderer
    const eventWithSession: OutputEvent = { ...event, sessionId: this.activeSessionId ?? undefined }
    const shouldSuppressAssistantText =
      this.suppressAssistantTextForPermissionTurn && (event.type === 'text' || event.type === 'thinking')

    // Don't send question/permission_request events to renderer message stream —
    // they're handled via UI state (status + banner), not as message bubbles
    if (event.type !== 'question' && event.type !== 'permission_request' && !shouldSuppressAssistantText) {
      this.window.webContents.send(`thread:output:${this.threadId}`, eventWithSession)
    }

    // Persist all relevant event types to DB with session ID
    switch (event.type) {
      case 'text':
        if (this.suppressAssistantTextForPermissionTurn) {
          break
        }
        if (event.content.trim() && this.activeSessionId) {
          insertMessage(this.threadId, 'assistant', event.content, event.metadata, this.activeSessionId)
        }
        break
      case 'tool_call': {
        if (this.activeSessionId) {
          insertMessage(this.threadId, 'assistant', event.content, event.metadata, this.activeSessionId)
        }
        // Track tool calls by ID so we can match permission errors to them
        const toolId = event.metadata?.id as string | undefined
        if (toolId) {
          this.recentToolCalls.set(toolId, {
            name: event.content,
            input: (event.metadata?.input as Record<string, unknown>) ?? {},
          })
        }
        // Detect Write calls targeting ~/.claude/plans/ so we can associate the file with this thread
        if (event.content === 'Write' || (event.metadata?.name as string | undefined) === 'Write') {
          const filePath = (event.metadata?.input as Record<string, unknown> | undefined)?.file_path as string | undefined
          if (filePath && /[/\\]\.claude[/\\]plans[/\\][^/\\]+\.md$/i.test(filePath)) {
            const fileName = filePath.replace(/^.*[/\\]/, '')
            this.lastPlanFilePath = filePath
            this.lastPlanFileName = fileName
          }
        }
        break
      }
      case 'tool_result': {
        if (this.activeSessionId) {
          insertMessage(this.threadId, 'assistant', event.content, event.metadata, this.activeSessionId)
        }
        // Fallback: detect permission errors from error tool_results (non-stream-json mode or
        // older Claude CLI versions that don't emit control_request events).
        const isError = event.metadata?.is_error === true
        const isPermissionError = isError && /requested permissions|you haven't granted/i.test(event.content)
        if (isPermissionError) {
          const toolUseId = (event.metadata?.tool_use_id as string) ?? ''
          const toolCall = toolUseId ? this.recentToolCalls.get(toolUseId) : undefined
          const toolName = toolCall?.name ?? 'Unknown tool'
          const toolInput = toolCall?.input ?? {}
          const description = buildPermissionDescription(toolName, toolInput)
          // No requestId — this is the legacy detection path (process already exited)
          this.enqueuePermissionRequest({
            requestId: this.makeSyntheticRequestId(toolUseId),
            toolName,
            toolInput,
            toolUseId,
            description,
            source: 'synthetic',
          })
          this.suppressAssistantTextForPermissionTurn = true
        }
        break
      }
      case 'permission_request': {
        const requestId = (event.metadata?.requestId as string | undefined) ?? ''
        const toolName = (event.metadata?.toolName as string | undefined) ?? event.content ?? 'Unknown tool'
        const toolInput = (event.metadata?.toolInput as Record<string, unknown> | undefined) ?? {}
        const toolUseId = (event.metadata?.toolUseId as string | undefined) ?? ''
        this.enqueuePermissionRequest({
          requestId,
          toolName,
          toolInput,
          toolUseId,
          description: buildPermissionDescription(toolName, toolInput),
          source: 'native',
        })
        if (this.activeSessionId) {
          this.setStatus('permission_pending')
        }
        break
      }

      case 'thinking':
        if (this.suppressAssistantTextForPermissionTurn) {
          break
        }
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
        // Emit per-thread plan association so the renderer can show the plan for the right thread
        if (this.lastPlanFileName) {
          this.window.webContents.send('plan:associated', {
            threadId: this.threadId,
            name: this.lastPlanFileName,
            path: this.lastPlanFilePath,
            content: event.content,
          })
        }
        break
      case 'question':
        // Native SDK question requests pause the live turn until we answer them,
        // so expose the pending state immediately instead of waiting for handleDone().
        this.questionPending = true
        this.pendingQuestionRequestId = (event.metadata?.requestId as string | undefined) ?? null
        this.pendingQuestions = ((event.metadata?.questions as Question[] | undefined) ?? []).map((question, index) => ({
          ...question,
          id: question.id ?? `${question.header || 'q'}-${index}`,
        }))
        if (this.activeSessionId) {
          this.setStatus('question_pending')
        }
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
    logThreadEvent(this.threadId, {
      ts: new Date().toISOString(),
      type: 'done',
      metadata: { error: error?.message ?? null },
    })

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
    } else if (this.pendingPermissions.size > 0) {
      // Claude requested permissions — waiting for user approval
      finalStatus = 'permission_pending'
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

  private makeSyntheticRequestId(seed: string): string {
    return `synthetic:${seed || randomUUID()}`
  }

  private enqueuePermissionRequest(input: {
    requestId: string
    toolName: string
    toolInput: Record<string, unknown>
    toolUseId: string
    description: string
    source: PermissionRequest['source']
  }): void {
    const request: PermissionRequest = {
      requestId: input.requestId,
      toolName: input.toolName,
      toolInput: input.toolInput,
      toolUseId: input.toolUseId,
      description: input.description,
      source: input.source,
      provider: getThreadProvider(this.threadId) as Provider,
      createdAt: new Date().toISOString(),
    }
    if (!this.pendingPermissions.has(request.requestId)) {
      this.pendingPermissionOrder.push(request.requestId)
    }
    this.pendingPermissions.set(request.requestId, request)
  }

  private removePendingPermission(requestId: string): void {
    this.pendingPermissions.delete(requestId)
    this.pendingPermissionOrder = this.pendingPermissionOrder.filter((id) => id !== requestId)
  }

  private clearPendingPermissions(): void {
    this.pendingPermissionOrder = []
    this.pendingPermissions.clear()
  }

  private getTargetPermissionRequest(requestId?: string): PermissionRequest | null {
    if (requestId) {
      return this.pendingPermissions.get(requestId) ?? null
    }
    const firstRequestId = this.pendingPermissionOrder[0]
    return firstRequestId ? (this.pendingPermissions.get(firstRequestId) ?? null) : null
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

function buildPermissionDescription(toolName: string, toolInput: Record<string, unknown>): string {
  switch (toolName) {
    case 'Write':
      return `Write to \`${toolInput.file_path ?? 'file'}\``
    case 'Edit':
    case 'MultiEdit':
      return `Edit \`${toolInput.file_path ?? 'file'}\``
    case 'Bash':
      return `Run command: \`${String(toolInput.command ?? '').slice(0, 120)}\``
    case 'Read':
      return `Read \`${toolInput.file_path ?? 'file'}\``
    default:
      return toolName
  }
}

function parseShellMode(content: string): { enabled: boolean; command: string } {
  const trimmedStart = content.trimStart()
  if (!trimmedStart.startsWith('!')) return { enabled: false, command: '' }
  const command = trimmedStart.slice(1).trim()
  return { enabled: true, command }
}

function killProcessTree(proc: ChildProcess): void {
  if (proc.exitCode != null || proc.signalCode != null) return
  if (process.platform === 'win32' && proc.pid != null) {
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { shell: false })
    return
  }
  try {
    proc.kill('SIGTERM')
  } catch {
    // ignore
  }
}
