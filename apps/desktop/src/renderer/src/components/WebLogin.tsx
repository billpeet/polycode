import { useState } from 'react'
import { Loader2, LockKeyhole, WifiOff } from 'lucide-react'
import type { LoginResult } from '../lib/webClient'

interface Props {
  /** `unreachable` shows a retry instead of the form. */
  state: 'login' | 'unreachable'
  onSubmit: (token: string) => Promise<LoginResult>
  onRetry: () => void
}

/**
 * The one screen a browser sees before it has a session. The token is pasted once and
 * exchanged for an `HttpOnly` cookie by the host; it never lands in storage this page can
 * read.
 */
export default function WebLogin({ state, onSubmit, onRetry }: Props) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    const trimmed = token.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await onSubmit(trimmed)
      if (!result.ok) setError(result.error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="flex h-full w-full items-center justify-center"
      style={{ background: 'var(--color-bg)', color: 'var(--color-text)' }}
    >
      <form
        onSubmit={(e) => void submit(e)}
        className="flex w-[360px] flex-col gap-4 rounded-xl p-6"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
      >
        <div className="flex items-center gap-2">
          {state === 'unreachable'
            ? <WifiOff className="h-4 w-4" style={{ color: '#f87171' }} />
            : <LockKeyhole className="h-4 w-4" style={{ color: 'var(--color-claude)' }} />}
          <h1 className="text-sm font-semibold">PolyCode</h1>
        </div>

        {state === 'unreachable' ? (
          <>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              The host did not answer. It may be starting up, or remote control may be turned off.
            </p>
            <button
              type="button"
              onClick={onRetry}
              className="w-fit rounded px-3 py-1.5 text-xs font-medium"
              style={{ background: 'var(--color-claude)', color: '#fff' }}
            >
              Try again
            </button>
          </>
        ) : (
          <>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              Paste this machine's host token from Settings → Remote on the desktop.
            </p>
            <input
              type="password"
              autoFocus
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Host token"
              aria-label="Host token"
              className="rounded px-2 py-1.5 text-xs font-mono outline-none"
              style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
            />
            {error && (
              <p role="alert" className="text-xs" style={{ color: 'var(--color-error, #f87171)' }}>
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={busy || !token.trim()}
              className="flex w-fit items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium disabled:opacity-50"
              style={{ background: 'var(--color-claude)', color: '#fff' }}
            >
              {busy && <Loader2 className="h-3 w-3 animate-spin" />}
              Sign in
            </button>
          </>
        )}
      </form>
    </div>
  )
}
