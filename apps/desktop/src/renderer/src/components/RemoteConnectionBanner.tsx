import { useEffect } from 'react'
import { Loader2, RefreshCw, WifiOff } from 'lucide-react'
import { initRemoteConnectionStore, useRemoteConnectionStore } from '../stores/remoteConnection'

/**
 * Banner across the top of the app while the active remote host is unreachable or the
 * event stream is re-dialing, or RPC refreshes are paused after repeated timeouts.
 * The TitleBar dot covers healthy states. Cached data stays on screen underneath; this
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
  const slow = connection.phase === 'connected' && connection.rpcDegraded
  if (!slow && connection.phase !== 'unavailable' && connection.phase !== 'reconnecting') return null

  const offline = connection.phase === 'unavailable'

  return (
    <div
      className={`flex items-center justify-between border-b px-4 py-1.5 ${
        offline ? 'border-danger-strong/30 bg-danger-strong/15' : 'border-warning-strong/30 bg-warning-strong/15'
      }`}
    >
      <div className="flex items-center gap-2">
        {offline
          ? <WifiOff className="h-3.5 w-3.5 text-danger" />
          : <Loader2 className="h-3.5 w-3.5 animate-spin text-warning" />}
        <span className={`text-xs ${offline ? 'text-[color-mix(in_srgb,var(--color-danger)_55%,var(--color-text))]' : 'text-[color-mix(in_srgb,var(--color-warning)_55%,var(--color-text))]'}`}>
          {slow
            ? 'Remote host is slow. Showing last synced data; refresh will retry shortly.'
            : offline
            ? 'Remote host unreachable — showing last synced data'
            : `Connection to remote host lost — reconnecting${connection.reconnectAttempt > 1 ? ` (attempt ${connection.reconnectAttempt})` : ''}…`}
          {connection.error ? ` · ${connection.error}` : ''}
        </span>
      </div>
      <button
        onClick={() => void retry()}
        disabled={retrying}
        className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs text-on-accent transition-colors ${
          offline ? 'bg-danger-strong hover:brightness-110' : 'bg-warning-strong hover:brightness-110'
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
