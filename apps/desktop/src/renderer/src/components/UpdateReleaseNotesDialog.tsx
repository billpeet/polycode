import { useEffect, useState } from 'react'
import { Download, ExternalLink, GitCommitHorizontal, Loader2 } from 'lucide-react'
import type { UpdateReleaseNotes } from '../types/ipc'
import { useBackdropClose } from '../hooks/useBackdropClose'

interface Props {
  /** Pending version the notes describe; shown in the header. */
  version?: string
  onClose: () => void
  /** Invoked when the user confirms the install from the dialog. */
  onInstall: () => void
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(diff)) return ''
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

/**
 * What's-new dialog shown when the user is about to install a downloaded update.
 * Lists the commits between the running version and the pending one; installing
 * only happens from the explicit confirm button, after the list has been shown.
 */
export function UpdateReleaseNotesDialog({ version, onClose, onInstall }: Props): React.JSX.Element {
  const backdropClose = useBackdropClose(onClose)
  const [notes, setNotes] = useState<UpdateReleaseNotes | null>(null)
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api
      .invoke('update:release-notes')
      .then((result) => {
        if (!cancelled) setNotes(result as UpdateReleaseNotes | null)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const commits = notes?.commits ?? []
  const releaseUrl = notes?.releaseUrl ?? null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onClick={backdropClose.onClick}
      onPointerDown={backdropClose.onPointerDown}
    >
      <div
        className="flex w-[600px] max-h-[75vh] flex-col rounded-lg shadow-2xl"
        style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="border-b px-5 py-4" style={{ borderColor: 'var(--color-border)' }}>
          <h2 className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
            <Download className="h-4 w-4 text-emerald-400" />
            What's new{version ? ` in v${version}` : ''}
          </h2>
          <p className="mt-0.5 text-xs" style={{ color: 'var(--color-text-muted)' }}>
            Review the changes included in this update before installing.
          </p>
        </div>

        {/* Commit list */}
        <div className="flex-1 overflow-y-auto p-2">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-8">
              <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--color-text-muted)' }} />
              <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Loading changes…</span>
            </div>
          )}

          {!loading && commits.length === 0 && (
            <div className="px-3 py-8 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
              Couldn't load the commit list for this update.
              {releaseUrl && (
                <>
                  <br />
                  <a
                    href={releaseUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 mt-2 text-blue-400 hover:text-blue-300"
                    onClick={(e) => e.stopPropagation()}
                  >
                    View the release on GitHub
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </>
              )}
            </div>
          )}

          {commits.map((commit) => (
            <div
              key={commit.sha}
              className="flex items-start justify-between gap-3 rounded px-3 py-2 hover:bg-white/5"
            >
              <div className="flex min-w-0 items-start gap-2">
                <GitCommitHorizontal className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--color-text-muted)' }} />
                <div className="min-w-0">
                  <div className="truncate text-sm" style={{ color: 'var(--color-text)' }}>
                    {commit.subject}
                  </div>
                  <div className="mt-0.5 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                    {commit.authorName}
                  </div>
                </div>
              </div>
              <div className="flex-shrink-0 text-right">
                <div className="font-mono text-[11px] text-blue-400">{commit.shortSha}</div>
                <div className="text-[10px]" style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}>
                  {relativeTime(commit.authorDate)}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t px-5 py-3" style={{ borderColor: 'var(--color-border)' }}>
          {releaseUrl ? (
            <a
              href={releaseUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs hover:underline"
              style={{ color: 'var(--color-text-muted)' }}
              onClick={(e) => e.stopPropagation()}
            >
              View on GitHub
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={installing}
              className="rounded px-4 py-1.5 text-xs disabled:opacity-50"
              style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
            >
              Not now
            </button>
            <button
              onClick={() => {
                setInstalling(true)
                onInstall()
              }}
              disabled={installing}
              className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-1.5 text-xs text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
            >
              {installing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Download className="h-3 w-3" />
              )}
              {installing ? 'Restarting…' : 'Install and Restart'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
