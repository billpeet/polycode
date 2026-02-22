import { BrowserWindow } from 'electron'
import { Session } from './session'
import { SshConfig, WslConfig } from '../../shared/types'

class SessionManager {
  private sessions = new Map<string, Session>()

  getOrCreate(threadId: string, workingDir: string, window: BrowserWindow, sshConfig?: SshConfig | null, wslConfig?: WslConfig | null): Session {
    const existing = this.sessions.get(threadId)
    if (existing) {
      // If the transport config changed (e.g. project re-configured as WSL after
      // the session was first cached), recreate so the new driver is used.
      // Never interrupt a running session mid-message.
      if (!existing.isRunning() && existing.transportChanged(sshConfig, wslConfig)) {
        existing.stop()
        this.sessions.delete(threadId)
      } else {
        return existing
      }
    }
    const session = new Session(threadId, workingDir, window, sshConfig, wslConfig)
    this.sessions.set(threadId, session)
    return session
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
