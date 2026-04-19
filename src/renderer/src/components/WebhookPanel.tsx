import { useState, useEffect } from 'react'

interface WebhookConfig {
  enabled: boolean
  port: number
  token: string
}

const DEFAULT_CONFIG: WebhookConfig = { enabled: false, port: 3284, token: '' }

interface Props {
  hideHeader?: boolean
}

export function WebhookPanel({ hideHeader }: Props) {
  const [config, setConfig] = useState<WebhookConfig>(DEFAULT_CONFIG)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.api.invoke('webhook:getConfig').then((cfg) => {
      setConfig(cfg as WebhookConfig)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  async function handleSave() {
    if (config.port < 1024 || config.port > 65535) {
      setError('Port must be between 1024 and 65535')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await window.api.invoke('webhook:setConfig', config)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Loading...</div>
  }

  return (
    <div className="flex flex-col gap-4">
      {!hideHeader && (
        <h2 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
          Webhook
        </h2>
      )}

      <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
        Expose a local HTTP server so external tools can spawn threads programmatically.
      </p>

      {/* Enable toggle */}
      <label className="flex items-center gap-3 cursor-pointer">
        <div
          onClick={() => setConfig((c) => ({ ...c, enabled: !c.enabled }))}
          className="relative w-9 h-5 rounded-full transition-colors flex-shrink-0"
          style={{
            background: config.enabled ? 'var(--color-claude)' : 'var(--color-border)',
            cursor: 'pointer',
          }}
        >
          <div
            className="absolute top-0.5 w-4 h-4 rounded-full transition-transform"
            style={{
              background: '#fff',
              transform: config.enabled ? 'translateX(18px)' : 'translateX(2px)',
            }}
          />
        </div>
        <span className="text-xs" style={{ color: 'var(--color-text)' }}>
          {config.enabled ? 'Enabled' : 'Disabled'}
        </span>
      </label>

      {/* Port */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
          Port
        </label>
        <input
          type="number"
          min={1024}
          max={65535}
          value={config.port}
          onChange={(e) => setConfig((c) => ({ ...c, port: parseInt(e.target.value, 10) || 3284 }))}
          className="w-32 rounded px-2 py-1 text-xs"
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text)',
          }}
        />
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Listens on 127.0.0.1 only (localhost).
        </span>
      </div>

      {/* Auth token */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
          Auth token <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>(optional)</span>
        </label>
        <div className="flex gap-2">
          <input
            type={showToken ? 'text' : 'password'}
            value={config.token}
            onChange={(e) => setConfig((c) => ({ ...c, token: e.target.value }))}
            placeholder="Leave empty to disable auth"
            className="flex-1 rounded px-2 py-1 text-xs"
            style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-text)',
            }}
          />
          <button
            onClick={() => setShowToken((v) => !v)}
            className="rounded px-2 py-1 text-xs"
            style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-text-muted)',
            }}
          >
            {showToken ? 'Hide' : 'Show'}
          </button>
        </div>
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          If set, requests must include <code>Authorization: Bearer &lt;token&gt;</code>.
        </span>
      </div>

      {/* API reference */}
      <div
        className="rounded p-3 text-xs"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
      >
        <div className="font-semibold mb-2" style={{ color: 'var(--color-text)' }}>
          POST http://127.0.0.1:{config.port}/api/threads
        </div>
        <pre
          className="text-xs whitespace-pre-wrap"
          style={{ color: 'var(--color-text-muted)', fontFamily: 'monospace' }}
        >{`{
  "project": "my-project",   // required
  "location": "dev-server",  // optional (label or pool name)
  "provider": "claude-code", // optional
  "model": "claude-opus-4-7",// optional
  "name": "Task name",       // optional
  "message": "Do the thing"  // optional — starts the thread
}`}</pre>
      </div>

      {error && (
        <p className="text-xs" style={{ color: 'var(--color-error, #f87171)' }}>
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded px-3 py-1.5 text-xs font-medium transition-opacity"
          style={{
            background: 'var(--color-claude)',
            color: '#fff',
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && (
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            Saved — server {config.enabled ? 'started' : 'stopped'}.
          </span>
        )}
      </div>
    </div>
  )
}
