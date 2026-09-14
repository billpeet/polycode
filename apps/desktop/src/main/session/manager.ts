import { BrowserWindow } from 'electron'
import { Session } from './session'
import { SshConfig, WslConfig } from '../../shared/types'
import { assertAppRunning } from '../app-lifecycle'

class SessionManager {
  private sessions = new Map<string, Session>()

  getOrCreate(threadId: string, workingDir: string, window: BrowserWindow, sshConfig?: SshConfig | null, wslConfig?: WslConfig | null): Session {
    assertAppRunning()
    const existing = this.sessions.get(threadId)
    if (existing) {
      // If the transport config changed (e.g. project re-configured as WSL after
      // the session was first cached), recreate so the new driver is used.
      // Never interrupt a running session mid-message.
      if (!existing.isRunning() && existing.transportChanged(sshConfig, wslConfig)) {
        existing.forceReset()
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
    // Idle providers can still own a process and a persistent thread writer.
    session?.forceReset()
    this.sessions.delete(threadId)
  }

  reset(threadId: string): void {
    const session = this.sessions.get(threadId)
    session?.forceReset()
    this.sessions.delete(threadId)
  }

  stopAll(): void {
    for (const session of this.sessions.values()) {
      session.forceReset()
    }
    this.sessions.clear()
  }
}

export const sessionManager = new SessionManager()
