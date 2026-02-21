import { BrowserWindow } from 'electron'
import { ClaudeDriver } from '../driver/claude'
import { OutputEvent, ThreadStatus } from '../../shared/types'
import { updateThreadStatus, insertMessage } from '../db/queries'

export class Session {
  readonly threadId: string
  private driver: ClaudeDriver
  private window: BrowserWindow

  constructor(threadId: string, workingDir: string, window: BrowserWindow) {
    this.threadId = threadId
    this.window = window
    this.driver = new ClaudeDriver({ workingDir, threadId })
  }

  start(): void {
    this.setStatus('running')

    this.driver.start(
      (event: OutputEvent) => this.handleEvent(event),
      (error?: Error) => this.handleDone(error)
    )
  }

  sendMessage(content: string): void {
    // Persist to DB
    insertMessage(this.threadId, 'user', content)
    this.driver.sendMessage(content)
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

    // Persist assistant messages to DB (text events only)
    if (event.type === 'text' && event.content.trim()) {
      insertMessage(this.threadId, 'assistant', event.content, event.metadata)
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
      this.setStatus('idle')
    }
    this.window.webContents.send(`thread:complete:${this.threadId}`)
  }

  private setStatus(status: ThreadStatus): void {
    updateThreadStatus(this.threadId, status)
    this.window.webContents.send(`thread:status:${this.threadId}`, status)
  }
}
