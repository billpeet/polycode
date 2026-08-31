/**
 * RunSessions adapter over the session registry.
 *
 * The `thread:complete:*` app-event stays exactly as it is for its display
 * consumers (renderer, mobile, remote SSE); this adapter is the ONE place
 * that still translates it — the channel-name regex and the payload cast
 * live here, behind a typed interface, instead of inside the lifecycle.
 */
import { BrowserWindow } from 'electron'
import { ThreadStatus } from '../../../shared/types'
import { onAppEvent } from '../../app-events'
import { sessionManager } from '../../session/manager'
import { RunSessions } from '../types'

export function createRunSessions(getWindow: () => BrowserWindow | null): RunSessions {
  return {
    runToCompletion(threadId, worktree, prompt) {
      const win = getWindow()
      if (!win) return Promise.reject(new Error('No window available to host the run session.'))
      const session = sessionManager.getOrCreate(threadId, worktree.effectiveDir, win, worktree.ssh, worktree.wsl)
      return session.runToCompletion(prompt)
    },

    onCompletion(listener) {
      return onAppEvent((event) => {
        const match = /^thread:complete:(.+)$/.exec(event.channel)
        if (!match) return
        listener(match[1], event.args[0] as ThreadStatus)
      })
    },

    hasLiveBackgroundWork(threadId) {
      return sessionManager.get(threadId)?.hasLiveBackgroundWork() ?? false
    },

    discard(threadId) {
      sessionManager.remove(threadId)
    },
  }
}
