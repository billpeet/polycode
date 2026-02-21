import { BrowserWindow } from 'electron'
import { ClaudeDriver } from '../driver/claude'
import { OutputEvent, ThreadStatus } from '../../shared/types'
import { updateThreadStatus, updateThreadName, insertMessage, listMessages } from '../db/queries'

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
    this.driver = new ClaudeDriver({ workingDir, threadId })
  }

  start(): void {
    this.setStatus('running')
  }

  sendMessage(content: string): void {
    // Persist to DB
    insertMessage(this.threadId, 'user', content)
    this.messageCount++
    const isFirst = this.messageCount === 1

    this.driver.sendMessage(
      content,
      (event: OutputEvent) => this.handleEvent(event),
      (error?: Error) => this.handleDone(error, isFirst)
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

  private handleDone(error?: Error, isFirst = false): void {
    if (error) {
      this.window.webContents.send(`thread:output:${this.threadId}`, {
        type: 'error',
        content: error.message
      } satisfies OutputEvent)
      this.setStatus('error')
    } else {
      // Still ready for next message
      this.setStatus('running')
      if (isFirst) {
        this.triggerAutoTitle()
      }
    }
    this.window.webContents.send(`thread:complete:${this.threadId}`)
  }

  private setStatus(status: ThreadStatus): void {
    updateThreadStatus(this.threadId, status)
    this.window.webContents.send(`thread:status:${this.threadId}`, status)
  }

  private triggerAutoTitle(): void {
    const messages = listMessages(this.threadId)
    const firstUser = messages.find((m) => m.role === 'user')
    if (!firstUser) return

    const seed = firstUser.content.slice(0, 500)
    const prompt =
      `In 5 words or fewer, write a short title for a coding session that started with this request. ` +
      `Reply with ONLY the title, no quotes, no punctuation at the end:\n\n${seed}`

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
