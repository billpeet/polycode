import { BrowserWindow } from 'electron'
import { Session } from './session'

class SessionManager {
  private sessions = new Map<string, Session>()

  getOrCreate(threadId: string, workingDir: string, window: BrowserWindow): Session {
    if (!this.sessions.has(threadId)) {
      const session = new Session(threadId, workingDir, window)
      this.sessions.set(threadId, session)
    }
    return this.sessions.get(threadId)!
  }

  get(threadId: string): Session | undefined {
    return this.sessions.get(threadId)
  }

  remove(threadId: string): void {
    const session = this.sessions.get(threadId)
    if (session?.isRunning()) {
      session.stop()
    }
    this.sessions.delete(threadId)
  }

  stopAll(): void {
    for (const session of this.sessions.values()) {
      if (session.isRunning()) {
        session.stop()
      }
    }
    this.sessions.clear()
  }
}

export const sessionManager = new SessionManager()
