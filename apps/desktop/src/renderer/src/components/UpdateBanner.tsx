import { useEffect, useState } from 'react'
import { Download, GitCommitHorizontal, Loader2, RefreshCw } from 'lucide-react'
import type { UpdateState } from '../types/ipc'
import { useToastStore } from '../stores/toast'
import { formatErrorDetails } from '../lib/errorDetails'
import { UpdateReleaseNotesDialog } from './UpdateReleaseNotesDialog'

const INITIAL_STATE: UpdateState = {
  available: false,
  ready: false,
  checking: false,
  downloading: false,
}

/**
 * Banner across the top of the app showing auto-update progress.
 * - Hidden when no update is available.
 * - Blue progress banner while an update downloads.
 * - Green banner with a "Restart to Update" button once it's ready.
 *
 * "Restart to Update" opens the release-notes dialog first: the user reviews
 * the commits in the new version, and installing happens only from the
 * dialog's confirm button.
 */
export function UpdateBanner(): React.JSX.Element | null {
  const [state, setState] = useState<UpdateState>(INITIAL_STATE)
  const [showNotes, setShowNotes] = useState(false)

  useEffect(() => {
    window.api.invoke('update:get-state').then(setState).catch(() => {})
    return window.api.on('update:state', (next) => setState(next as UpdateState))
  }, [])

  const handleRestart = async (): Promise<void> => {
    try {
      const { success } = await window.api.invoke('update:apply')
      if (!success) {
        // The app did not quit, so un-stick the release-notes dialog — the toast
        // below explains why nothing restarted.
        setShowNotes(false)
        useToastStore.getState().add({
          type: 'error',
          title: 'Update Install Failed',
          message: 'Update is no longer ready to install.',
          details: formatErrorDetails({ action: 'update:apply', updateState: state, success: false }),
          duration: 5000,
        })
      }
    } catch (err) {
      useToastStore.getState().add({
        type: 'error',
        title: 'Update Install Failed',
        message: err instanceof Error ? err.message : 'Failed to restart for update.',
        details: formatErrorDetails({ action: 'update:apply', updateState: state }, err),
        duration: 0,
      })
    }
  }

  if (state.downloading) {
    return (
      <div className="flex items-center gap-2 border-b border-blue-600/30 bg-blue-600/20 px-4 py-1.5">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />
        <span className="text-xs text-blue-300">
          Downloading update{state.version ? ` v${state.version}` : ''}… {state.progress ?? 0}%
        </span>
      </div>
    )
  }

  if (state.ready) {
    return (
      <>
        <div className="flex items-center justify-between border-b border-emerald-600/30 bg-emerald-600/20 px-4 py-1.5">
          <div className="flex items-center gap-2">
            <Download className="h-3.5 w-3.5 text-emerald-400" />
            <span className="text-xs text-emerald-300">
              A new version is ready to install{state.version ? ` (v${state.version})` : ''}
            </span>
            <button
              onClick={() => setShowNotes(true)}
              className="flex items-center gap-1 text-xs text-emerald-300 underline-offset-2 transition-colors hover:text-emerald-200 hover:underline"
            >
              <GitCommitHorizontal className="h-3 w-3" />
              What's new
            </button>
          </div>
          <button
            onClick={() => setShowNotes(true)}
            className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1 text-xs text-white transition-colors hover:bg-emerald-500"
          >
            <RefreshCw className="h-3 w-3" />
            Restart to Update
          </button>
        </div>
        {showNotes && (
          <UpdateReleaseNotesDialog
            version={state.version}
            onClose={() => setShowNotes(false)}
            onInstall={handleRestart}
          />
        )}
      </>
    )
  }

  return null
}
