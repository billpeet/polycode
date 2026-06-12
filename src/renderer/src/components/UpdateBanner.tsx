import { useEffect, useState } from 'react'
import { Download, Loader2, RefreshCw } from 'lucide-react'
import type { UpdateState } from '../types/ipc'
import { useToastStore } from '../stores/toast'

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
 */
export function UpdateBanner(): React.JSX.Element | null {
  const [state, setState] = useState<UpdateState>(INITIAL_STATE)

  useEffect(() => {
    window.api.invoke('update:get-state').then(setState).catch(() => {})
    return window.api.on('update:state', (next) => setState(next as UpdateState))
  }, [])

  const handleRestart = async (): Promise<void> => {
    try {
      const { success } = await window.api.invoke('update:apply')
      if (!success) {
        useToastStore.getState().add({
          type: 'error',
          message: 'Update is no longer ready to install.',
          duration: 5000,
        })
      }
    } catch (err) {
      useToastStore.getState().add({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to restart for update.',
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
      <div className="flex items-center justify-between border-b border-emerald-600/30 bg-emerald-600/20 px-4 py-1.5">
        <div className="flex items-center gap-2">
          <Download className="h-3.5 w-3.5 text-emerald-400" />
          <span className="text-xs text-emerald-300">
            A new version is ready to install{state.version ? ` (v${state.version})` : ''}
          </span>
        </div>
        <button
          onClick={handleRestart}
          className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1 text-xs text-white transition-colors hover:bg-emerald-500"
        >
          <RefreshCw className="h-3 w-3" />
          Restart to Update
        </button>
      </div>
    )
  }

  return null
}
