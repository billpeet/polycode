import { useCallback } from 'react'
import { useGitStore } from '../stores/git'
import { useToastStore } from '../stores/toast'

/**
 * Pattern matches the stable substring of the main-process `GitLockedError.message`, plus the raw
 * stderr phrases so we recognise lock errors that come from transports where we might not have
 * wrapped the error (e.g. a WSL/SSH shell script that bubbles stderr directly).
 */
function isRepoLockError(message: string): boolean {
  return /Git repository is locked|index\.lock|Another git process seems to be running|cannot lock ref/i.test(message)
}

/**
 * Returns a helper that converts any git-operation error into a toast. When the error looks like
 * a repo-lock failure that survived the main-process retry budget, the toast gets a "Force Unlock"
 * action that removes the stale `.git/*.lock` files (after a confirmation dialog).
 *
 * Pass a project/repo path bound to this component. If `null`, lock-action enhancement is skipped.
 */
export function useGitErrorReporter(projectPath: string | null | undefined) {
  const addToast = useToastStore((s) => s.add)
  const forceUnlock = useGitStore((s) => s.forceUnlock)

  return useCallback((err: unknown, fallbackMessage: string, duration: number = 0) => {
    const message = err instanceof Error ? err.message : String(err ?? fallbackMessage)
    if (!projectPath || !isRepoLockError(message)) {
      addToast({ type: 'error', message: message || fallbackMessage, duration })
      return
    }
    addToast({
      type: 'error',
      message: `${message}\n\nIf no other git process is running, you can forcibly remove the lock file(s).`,
      duration: 0,
      actionLabel: 'Force Unlock',
      onAction: async () => {
        if (!window.confirm('Forcibly remove .git/*.lock files?\n\nOnly do this if you are SURE no other git process is currently running — otherwise the repository could be corrupted.')) return
        try {
          const result = await forceUnlock(projectPath)
          if (result.removed.length === 0) {
            addToast({ type: 'info', message: 'No lock files found — repository is already unlocked.', duration: 4000 })
          } else {
            addToast({
              type: 'success',
              message: `Removed ${result.removed.length} lock file${result.removed.length === 1 ? '' : 's'}: ${result.removed.join(', ')}`,
              duration: 5000,
            })
          }
        } catch (unlockErr) {
          addToast({
            type: 'error',
            message: unlockErr instanceof Error ? unlockErr.message : 'Failed to remove lock files',
            duration: 0,
          })
        }
      },
    })
  }, [addToast, forceUnlock, projectPath])
}
