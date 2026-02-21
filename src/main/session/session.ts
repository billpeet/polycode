import { BrowserWindow } from 'electron'
import { ClaudeDriver } from '../driver/claude'
import { OutputEvent, ThreadStatus } from '../../shared/types'
import { updateThreadStatus, updateThreadName, insertMessage, getThreadSessionId, updateThreadSessionId, getThreadModel } from '../db/queries'

export class Session {
  readonly threadId: string
  private driver: ClaudeDriver
  private window: BrowserWindow
  private workingDir: string
  private messageCount = 0

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

  sendMessage(content: string): void {
    this.setStatus('running')
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
      (error?: Error) => this.handleDone(error)
    )
  }

  stop(): void {
    this.driver.stop()
    this.setStatus('stopped')
  }

  isRunning(): boolean {
    return this.driver.isRunning()
  }

  private handleEvent(event: OutputEvent): void {
    // Push streaming event to renderer
    this.window.webContents.send(`thread:output:${this.threadId}`, event)

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
      case 'error':
        insertMessage(this.threadId, 'system', event.content, { type: 'error' })
        break
    }
  }

  private handleDone(error?: Error): void {
    if (error) {
      this.window.webContents.send(`thread:output:${this.threadId}`, {
        type: 'error',
        content: error.message
      } satisfies OutputEvent)
      this.setStatus('error')
    } else {
      // Response complete — idle and ready for next message
      this.setStatus('idle')
    }
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
