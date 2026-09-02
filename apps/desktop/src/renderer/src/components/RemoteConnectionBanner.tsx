import { useEffect } from 'react'
import { Loader2, RefreshCw, WifiOff } from 'lucide-react'
import { initRemoteConnectionStore, useRemoteConnectionStore } from '../stores/remoteConnection'

/**
 * Banner across the top of the app while the active remote host is unreachable or the
 * event stream is re-dialing. Hidden entirely in local mode and while connected — the
 * TitleBar dot covers the healthy states. Cached data stays on screen underneath; this
 * banner is what tells the user why nothing new is arriving (issue #48).
 */
export function RemoteConnectionBanner(): React.JSX.Element | null {
  const connection = useRemoteConnectionStore((s) => s.connection)
  const retrying = useRemoteConnectionStore((s) => s.retrying)
  const retry = useRemoteConnectionStore((s) => s.retry)

  useEffect(() => {
    initRemoteConnectionStore()
  }, [])

  if (!connection.hostId) return null
  if (connection.phase !== 'unavailable' && connection.phase !== 'reconnecting') return null

  const offline = connection.phase === 'unavailable'

  return (
    <div
      className={`flex items-center justify-between border-b px-4 py-1.5 ${
        offline ? 'border-red-600/30 bg-red-600/15' : 'border-amber-600/30 bg-amber-600/15'
      }`}
    >
      <div className="flex items-center gap-2">
        {offline
          ? <WifiOff className="h-3.5 w-3.5 text-red-400" />
          : <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" />}
        <span className={`text-xs ${offline ? 'text-red-300' : 'text-amber-300'}`}>
          {offline
            ? 'Remote host unreachable — showing last synced data'
            : `Connection to remote host lost — reconnecting${connection.reconnectAttempt > 1 ? ` (attempt ${connection.reconnectAttempt})` : ''}…`}
          {connection.error ? ` · ${connection.error}` : ''}
        </span>
      </div>
      <button
        onClick={() => void retry()}
        disabled={retrying}
        className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs text-white transition-colors ${
          offline ? 'bg-red-600 hover:bg-red-500' : 'bg-amber-600 hover:bg-amber-500'
        } disabled:opacity-60`}
      >
        {retrying
          ? <Loader2 className="h-3 w-3 animate-spin" />
          : <RefreshCw className="h-3 w-3" />}
        Retry now
      </button>
    </div>
  )
}
