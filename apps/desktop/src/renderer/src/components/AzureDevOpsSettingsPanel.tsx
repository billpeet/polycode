import { useEffect, useState } from 'react'

export function AzureDevOpsSettingsPanel() {
  const [configured, setConfigured] = useState(false)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    window.api.invoke('azure:pat:status').then(setConfigured).catch(() => setMessage('Could not load credential status.'))
  }, [])

  async function save(value: string) {
    setBusy(true)
    setMessage('')
    try {
      await window.api.invoke('azure:pat:set', value)
      setConfigured(Boolean(value.trim()))
      setToken('')
      setMessage(value ? 'PAT saved. Refresh your pull requests to connect.' : 'PAT removed.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save PAT.')
    } finally { setBusy(false) }
  }

  return <div className="space-y-4 text-sm" style={{ color: 'var(--color-text)' }}>
    <h3 className="font-semibold">Azure DevOps</h3>
    <p style={{ color: 'var(--color-text-muted)' }}>Connect using a personal access token with Code (Read &amp; Write) permissions to view and create pull requests. The organization and project come from each repository’s Git remote.</p>
    <p>{configured ? 'A PAT is saved on this Polycode host.' : 'No PAT configured.'}</p>
    <label className="block space-y-2">
      <span>{configured ? 'Replace personal access token' : 'Personal access token'}</span>
      <input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)}
        className="w-full rounded px-3 py-2 outline-none" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }} />
    </label>
    <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Stored encrypted using your operating system. For a remote Polycode host, configure its PAT in that host’s desktop settings.</p>
    <div className="flex gap-3">
      <button disabled={busy || !token.trim()} onClick={() => void save(token)} className="rounded px-3 py-2 disabled:opacity-50" style={{ background: 'var(--color-surface-2)' }}>{busy ? 'Saving…' : 'Save PAT'}</button>
      {configured && <button disabled={busy} onClick={() => void save('')} className="rounded px-3 py-2 disabled:opacity-50">Remove PAT</button>}
    </div>
    {message && <p role="status">{message}</p>}
  </div>
}
