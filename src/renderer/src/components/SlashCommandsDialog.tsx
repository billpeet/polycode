import { useState, useEffect } from 'react'
import { useSlashCommandStore } from '../stores/slashCommands'
import { SlashCommand } from '../types/ipc'

interface Props {
  projectId: string | null
  projectName?: string
  onClose: () => void
}

interface FormState {
  name: string
  description: string
  prompt: string
  scope: 'global' | 'project'
}

const EMPTY_FORM: FormState = { name: '', description: '', prompt: '', scope: 'project' }

export default function SlashCommandsDialog({ projectId, projectName, onClose }: Props) {
  const fetch = useSlashCommandStore((s) => s.fetch)
  const create = useSlashCommandStore((s) => s.create)
  const update = useSlashCommandStore((s) => s.update)
  const remove = useSlashCommandStore((s) => s.remove)
  const commandsByScope = useSlashCommandStore((s) => s.commandsByScope)

  const scopeKey = projectId ?? 'global'
  const allCommands = commandsByScope[scopeKey] ?? []
  const globalCommands = allCommands.filter((c) => c.project_id === null)
  const projectCommands = allCommands.filter((c) => c.project_id !== null)

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  useEffect(() => {
    fetch(projectId)
  }, [projectId, fetch])

  function startAdd() {
    setForm({ ...EMPTY_FORM, scope: projectId ? 'project' : 'global' })
    setEditingId(null)
    setShowForm(true)
    setError(null)
  }

  function startEdit(cmd: SlashCommand) {
    setForm({
      name: cmd.name,
      description: cmd.description ?? '',
      prompt: cmd.prompt,
      scope: cmd.project_id === null ? 'global' : 'project',
    })
    setEditingId(cmd.id)
    setShowForm(true)
    setError(null)
  }

  function cancelForm() {
    setShowForm(false)
    setEditingId(null)
    setForm(EMPTY_FORM)
    setError(null)
  }

  async function handleSave() {
    const name = form.name.trim()
    const prompt = form.prompt.trim()
    if (!name) { setError('Name is required'); return }
    if (!prompt) { setError('Prompt is required'); return }
    if (!/^[\w-]+$/.test(name)) {
      setError('Name can only contain letters, numbers, hyphens, and underscores')
      return
    }

    const targetProjectId = (form.scope === 'project' && projectId) ? projectId : null
    setSaving(true)
    setError(null)
    try {
      if (editingId) {
        await update(editingId, name, form.description.trim() || null, prompt)
      } else {
        await create(targetProjectId, name, form.description.trim() || null, prompt)
      }
      await fetch(projectId)
      cancelForm()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    await remove(id)
    setConfirmDeleteId(null)
    fetch(projectId)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onClick={onClose}
    >
      <div
        className="flex w-[560px] max-h-[80vh] flex-col rounded-xl shadow-2xl"
        style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          <div>
            <h2 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
              Slash Commands
            </h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
              Reusable prompts triggered by <code className="font-mono">/name</code> in the input
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-xs hover:bg-white/10 transition-colors"
            style={{ color: 'var(--color-text-muted)' }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Add/Edit form */}
          {showForm ? (
            <div
              className="rounded-lg p-4 space-y-3"
              style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
            >
              <h3 className="text-xs font-semibold" style={{ color: 'var(--color-text)' }}>
                {editingId ? 'Edit command' : 'New command'}
              </h3>

              {/* Scope selector — only when a project is active and creating new */}
              {projectId && !editingId && (
                <div className="flex items-center gap-2">
                  <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Scope:</span>
                  <button
                    onClick={() => setForm((f) => ({ ...f, scope: 'project' }))}
                    className="rounded px-2 py-0.5 text-xs transition-colors"
                    style={{
                      background: form.scope === 'project' ? 'rgba(232,123,95,0.15)' : 'var(--color-surface-2)',
                      border: `1px solid ${form.scope === 'project' ? 'rgba(232,123,95,0.4)' : 'var(--color-border)'}`,
                      color: form.scope === 'project' ? 'var(--color-claude)' : 'var(--color-text-muted)',
                    }}
                  >
                    {projectName ?? 'Project'}
                  </button>
                  <button
                    onClick={() => setForm((f) => ({ ...f, scope: 'global' }))}
                    className="rounded px-2 py-0.5 text-xs transition-colors"
                    style={{
                      background: form.scope === 'global' ? 'rgba(255,255,255,0.08)' : 'var(--color-surface-2)',
                      border: `1px solid ${form.scope === 'global' ? 'rgba(255,255,255,0.2)' : 'var(--color-border)'}`,
                      color: form.scope === 'global' ? 'var(--color-text)' : 'var(--color-text-muted)',
                    }}
                  >
                    Global
                  </button>
                </div>
              )}

              <div>
                <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  Name
                </label>
                <div className="flex items-center gap-1">
                  <span className="text-sm font-mono" style={{ color: 'var(--color-claude)' }}>/</span>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, name: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') }))
                    }
                    placeholder="command-name"
                    className="flex-1 rounded px-2 py-1 text-sm outline-none font-mono"
                    style={{
                      background: 'var(--color-surface-2)',
                      border: '1px solid var(--color-border)',
                      color: 'var(--color-text)',
                    }}
                    autoFocus
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  Description <span style={{ fontStyle: 'italic' }}>(optional)</span>
                </label>
                <input
                  type="text"
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="Short description shown in the popup"
                  className="w-full rounded px-2 py-1 text-sm outline-none"
                  style={{
                    background: 'var(--color-surface-2)',
                    border: '1px solid var(--color-border)',
                    color: 'var(--color-text)',
                  }}
                />
              </div>

              <div>
                <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  Prompt
                </label>
                <textarea
                  value={form.prompt}
                  onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
                  placeholder="The prompt text that will be inserted when this command is selected"
                  rows={4}
                  className="w-full resize-none rounded px-2 py-1.5 text-sm outline-none"
                  style={{
                    background: 'var(--color-surface-2)',
                    border: '1px solid var(--color-border)',
                    color: 'var(--color-text)',
                    fontFamily: 'inherit',
                  }}
                />
              </div>

              {error && (
                <p className="text-xs" style={{ color: '#f87171' }}>{error}</p>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={cancelForm}
                  className="rounded px-3 py-1.5 text-xs"
                  style={{
                    background: 'var(--color-surface-2)',
                    border: '1px solid var(--color-border)',
                    color: 'var(--color-text-muted)',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="rounded px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                  style={{
                    background: 'linear-gradient(135deg, var(--color-claude) 0%, #d06a50 100%)',
                    color: '#fff',
                  }}
                >
                  {saving ? 'Saving…' : editingId ? 'Save' : 'Create'}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={startAdd}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs transition-all hover:opacity-100"
              style={{
                background: 'transparent',
                border: '1px dashed var(--color-border)',
                color: 'var(--color-text-muted)',
                opacity: 0.7,
              }}
            >
              + New slash command
            </button>
          )}

          {/* Project-scoped commands */}
          {projectId && projectCommands.length > 0 && (
            <div>
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
                {projectName ?? 'Project'}
              </p>
              <div className="space-y-1">
                {projectCommands.map((cmd) => (
                  <CommandRow
                    key={cmd.id}
                    cmd={cmd}
                    onEdit={startEdit}
                    onDelete={(id) => setConfirmDeleteId(id)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Global commands */}
          {globalCommands.length > 0 && (
            <div>
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
                Global
              </p>
              <div className="space-y-1">
                {globalCommands.map((cmd) => (
                  <CommandRow
                    key={cmd.id}
                    cmd={cmd}
                    onEdit={startEdit}
                    onDelete={(id) => setConfirmDeleteId(id)}
                  />
                ))}
              </div>
            </div>
          )}

          {allCommands.length === 0 && !showForm && (
            <p className="text-center text-xs py-4" style={{ color: 'var(--color-text-muted)' }}>
              No slash commands yet. Create one above.
            </p>
          )}
        </div>
      </div>

      {/* Delete confirmation */}
      {confirmDeleteId && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.5)' }}
          onClick={() => setConfirmDeleteId(null)}
        >
          <div
            className="w-72 rounded-lg p-5 shadow-2xl"
            style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm mb-3" style={{ color: 'var(--color-text)' }}>
              Delete this slash command?
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmDeleteId(null)}
                className="rounded px-3 py-1.5 text-xs"
                style={{
                  background: 'var(--color-surface)',
                  border: '1px solid var(--color-border)',
                  color: 'var(--color-text)',
                }}
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
  )
}

function CommandRow({
  cmd,
  onEdit,
  onDelete,
}: {
  cmd: SlashCommand
  onEdit: (cmd: SlashCommand) => void
  onDelete: (id: string) => void
}) {
  return (
    <div
      className="group flex items-start gap-3 rounded-lg px-3 py-2"
      style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
    >
      <div className="flex-1 min-w-0">
        <span className="font-mono text-sm font-medium" style={{ color: 'var(--color-claude)' }}>
          /{cmd.name}
        </span>
        {cmd.description && (
          <p className="mt-0.5 truncate text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {cmd.description}
          </p>
        )}
        <p
          className="mt-1 line-clamp-2 text-xs"
          style={{ color: 'var(--color-text-muted)', opacity: 0.7 }}
        >
          {cmd.prompt}
        </p>
      </div>
      <div className="flex flex-shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={() => onEdit(cmd)}
          className="rounded p-1 text-xs hover:bg-white/10 transition-colors"
          style={{ color: 'var(--color-text-muted)' }}
          title="Edit"
        >
          ✎
        </button>
        <button
          onClick={() => onDelete(cmd.id)}
          className="rounded p-1 text-xs hover:bg-white/10 transition-colors"
          style={{ color: 'var(--color-text-muted)' }}
          title="Delete"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
