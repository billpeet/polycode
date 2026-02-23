import { useState } from 'react'
import { useYouTrackStore } from '../stores/youtrack'
import { YouTrackServer } from '../types/ipc'

interface Props {
  onClose: () => void
}

interface FormState {
  name: string
  url: string
  token: string
}

const EMPTY_FORM: FormState = { name: '', url: '', token: '' }

export default function YouTrackSettingsDialog({ onClose }: Props) {
  const servers = useYouTrackStore((s) => s.servers)
  const createServer = useYouTrackStore((s) => s.create)
  const updateServer = useYouTrackStore((s) => s.update)
  const removeServer = useYouTrackStore((s) => s.remove)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [showAdd, setShowAdd] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  function startAdd() {
    setForm(EMPTY_FORM)
    setEditingId(null)
    setShowAdd(true)
    setTestResult(null)
    setError(null)
  }

  function startEdit(server: YouTrackServer) {
    setForm({ name: server.name, url: server.url, token: server.token })
    setEditingId(server.id)
    setShowAdd(true)
    setTestResult(null)
    setError(null)
  }

  function cancelForm() {
    setShowAdd(false)
    setEditingId(null)
    setForm(EMPTY_FORM)
    setTestResult(null)
    setError(null)
  }

  async function handleTest() {
    if (!form.url || !form.token) {
      setError('URL and token are required to test')
      return
    }
    setTesting(true)
    setTestResult(null)
    setError(null)
    try {
      const result = await window.api.invoke('youtrack:test', form.url.trim(), form.token.trim())
      setTestResult(result)
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : 'Unknown error' })
    } finally {
      setTesting(false)
    }
  }

  async function handleSave() {
    if (!form.name.trim() || !form.url.trim() || !form.token.trim()) {
      setError('All fields are required')
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (editingId) {
        await updateServer(editingId, form.name.trim(), form.url.trim(), form.token.trim())
      } else {
        await createServer(form.name.trim(), form.url.trim(), form.token.trim())
      }
      cancelForm()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    await removeServer(id)
    setConfirmDeleteId(null)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onClick={onClose}
    >
      <div
        className="relative flex w-[480px] max-h-[80vh] flex-col rounded-xl shadow-2xl"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          <div className="flex items-center gap-2">
            <YouTrackIcon />
            <span className="font-semibold" style={{ color: 'var(--color-text)' }}>
              YouTrack Servers
            </span>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-xs opacity-60 hover:opacity-100 transition-opacity"
            style={{ color: 'var(--color-text-muted)' }}
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Existing servers */}
          {servers.length > 0 && (
            <div className="space-y-2">
              {servers.map((server) => (
                <div
                  key={server.id}
                  className="flex items-center justify-between rounded-lg px-3 py-2.5"
                  style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate" style={{ color: 'var(--color-text)' }}>
                      {server.name}
                    </div>
                    <div className="text-xs truncate" style={{ color: 'var(--color-text-muted)' }}>
                      {server.url}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 ml-3 shrink-0">
                    <button
                      onClick={() => startEdit(server)}
                      className="rounded px-2 py-1 text-xs opacity-60 hover:opacity-100 transition-opacity"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(server.id)}
                      className="rounded px-2 py-1 text-xs opacity-60 hover:opacity-100 transition-opacity"
                      style={{ color: '#f87171' }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {servers.length === 0 && !showAdd && (
            <p className="text-sm text-center py-4" style={{ color: 'var(--color-text-muted)' }}>
              No YouTrack servers configured. Add one to enable issue search with @.
            </p>
          )}

          {/* Add/Edit form */}
          {showAdd && (
            <div
              className="rounded-lg p-4 space-y-3"
              style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}
            >
              <p className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                {editingId ? 'Edit Server' : 'Add Server'}
              </p>

              <div className="space-y-2">
                <div>
                  <label className="block text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>
                    Name
                  </label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. My YouTrack"
                    className="w-full rounded px-2.5 py-1.5 text-sm outline-none"
                    style={{
                      background: 'var(--color-surface)',
                      border: '1px solid var(--color-border)',
                      color: 'var(--color-text)',
                    }}
                  />
                </div>

                <div>
                  <label className="block text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>
                    URL
                  </label>
                  <input
                    type="url"
                    value={form.url}
                    onChange={(e) => { setForm((f) => ({ ...f, url: e.target.value })); setTestResult(null) }}
                    placeholder="https://yourcompany.youtrack.cloud"
                    className="w-full rounded px-2.5 py-1.5 text-sm outline-none font-mono"
                    style={{
                      background: 'var(--color-surface)',
                      border: '1px solid var(--color-border)',
                      color: 'var(--color-text)',
                    }}
                  />
                </div>

                <div>
                  <label className="block text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>
                    Permanent Token
                  </label>
                  <input
                    type="password"
                    value={form.token}
                    onChange={(e) => { setForm((f) => ({ ...f, token: e.target.value })); setTestResult(null) }}
                    placeholder="perm:..."
                    className="w-full rounded px-2.5 py-1.5 text-sm outline-none font-mono"
                    style={{
                      background: 'var(--color-surface)',
                      border: '1px solid var(--color-border)',
                      color: 'var(--color-text)',
                    }}
                  />
                </div>
              </div>

              {error && (
                <p className="text-xs" style={{ color: '#f87171' }}>{error}</p>
              )}

              {testResult && (
                <p
                  className="text-xs"
                  style={{ color: testResult.ok ? '#4ade80' : '#f87171' }}
                >
                  {testResult.ok ? 'Connection successful' : `Connection failed: ${testResult.error}`}
                </p>
              )}

              <div className="flex items-center justify-between pt-1">
                <button
                  onClick={handleTest}
                  disabled={testing}
                  className="rounded px-3 py-1.5 text-xs transition-opacity hover:opacity-80 disabled:opacity-50"
                  style={{
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                    color: 'var(--color-text)',
                  }}
                >
                  {testing ? 'Testing...' : 'Test Connection'}
                </button>
                <div className="flex items-center gap-2">
                  <button
                    onClick={cancelForm}
                    className="rounded px-3 py-1.5 text-xs opacity-60 hover:opacity-100 transition-opacity"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="rounded px-3 py-1.5 text-xs font-medium transition-all hover:scale-105 disabled:opacity-50 disabled:hover:scale-100"
                    style={{
                      background: 'linear-gradient(135deg, var(--color-claude) 0%, #d06a50 100%)',
                      color: '#fff',
                    }}
                  >
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {!showAdd && (
            <button
              onClick={startAdd}
              className="w-full rounded-lg py-2 text-sm transition-opacity hover:opacity-80"
              style={{
                background: 'var(--color-surface-2)',
                border: '1px dashed var(--color-border)',
                color: 'var(--color-text-muted)',
              }}
            >
              + Add Server
            </button>
          )}
        </div>

        {/* Delete confirmation */}
        {confirmDeleteId && (
          <div
            className="absolute inset-0 flex items-center justify-center rounded-xl"
            style={{ background: 'rgba(0,0,0,0.6)' }}
          >
            <div
              className="w-72 rounded-lg p-5 shadow-2xl"
              style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}
            >
              <p className="text-sm mb-1" style={{ color: 'var(--color-text)' }}>Delete server?</p>
              <p className="text-xs mb-4" style={{ color: 'var(--color-text-muted)' }}>
                This will remove the YouTrack server configuration.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setConfirmDeleteId(null)}
                  className="rounded px-3 py-1.5 text-xs"
                  style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDelete(confirmDeleteId)}
                  className="rounded px-3 py-1.5 text-xs font-medium"
                  style={{ background: '#dc2626', color: '#fff' }}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function YouTrackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-claude)" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <path d="M8 12l3 3 5-5" />
    </svg>
  )
}
