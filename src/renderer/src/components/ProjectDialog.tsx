import { useState } from 'react'
import { useProjectStore } from '../stores/projects'
import { Project } from '../types/ipc'

interface Props {
  mode: 'create' | 'edit'
  project?: Project
  onClose: () => void
  onCreated?: (project: Project) => void
}

export default function ProjectDialog({ mode, project, onClose, onCreated }: Props) {
  const [name, setName] = useState(project?.name ?? '')
  const [gitUrl, setGitUrl] = useState(project?.git_url ?? '')
  const [error, setError] = useState('')

  const createProject = useProjectStore((s) => s.create)
  const updateProject = useProjectStore((s) => s.update)

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!name.trim()) { setError('Name is required'); return }

    try {
      if (mode === 'edit' && project) {
        await updateProject(project.id, name.trim(), gitUrl.trim() || null)
        onClose()
      } else {
        const created = await createProject(name.trim(), gitUrl.trim() || null)
        onClose()
        onCreated?.(created)
      }
    } catch (err) {
      setError(String(err))
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onClick={onClose}
    >
      <div
        className="w-96 rounded-lg p-6 shadow-2xl"
        style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-base font-semibold" style={{ color: 'var(--color-text)' }}>
          {mode === 'edit' ? 'Edit Project' : 'New Project'}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded px-3 py-2 text-sm outline-none"
              style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
              placeholder="My Project"
              autoFocus
            />
          </div>

          <div>
            <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>
              Git URL <span style={{ opacity: 0.5 }}>(optional)</span>
            </label>
            <input
              type="text"
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              className="w-full rounded px-3 py-2 text-sm outline-none font-mono"
              style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
              placeholder="https://github.com/org/repo.git"
            />
          </div>

          {error && <p className="text-xs" style={{ color: '#f87171' }}>{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded px-4 py-2 text-sm"
              style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded px-4 py-2 text-sm font-medium"
              style={{ background: 'var(--color-claude)', color: '#fff' }}
            >
              {mode === 'edit' ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
