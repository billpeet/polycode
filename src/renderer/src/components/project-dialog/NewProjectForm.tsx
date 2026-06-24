import { useEffect, useState } from 'react'
import { useProjectStore } from '../../stores/projects'
import { NewProjectSpec, Project } from '../../types/ipc'

type SourceKind = 'new' | 'existing' | 'clone'

function repoNameFromUrl(url: string): string {
  return url.replace(/\.git$/i, '').split(/[/\\]/).filter(Boolean).pop() ?? ''
}

/** Turn a project name into a directory-friendly slug: lowercase, whitespace → '-'. e.g. "T3 Code" → "t3-code". */
function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '-')
}

interface NewProjectFormProps {
  onClose: () => void
  onCreated?: (project: Project) => void
}

/**
 * Single-step "New Project" form covering all three provisioning scenarios:
 *   - new:      create a fresh directory + `git init`
 *   - existing: adopt an existing local directory (auto-detects name + git remote)
 *   - clone:    `git clone` a remote into a fresh directory (auto-detects name)
 * On Create it provisions the project *and* its first local location atomically.
 */
export default function NewProjectForm({ onClose, onCreated }: NewProjectFormProps) {
  const createFull = useProjectStore((s) => s.createFull)

  const [sourceKind, setSourceKind] = useState<SourceKind>('new')
  const [name, setName] = useState('')
  const [nameDirty, setNameDirty] = useState(false)
  const [allowMainBranchCommits, setAllowMainBranchCommits] = useState(true)
  const [baseDir, setBaseDir] = useState('~/source')
  const [existingPath, setExistingPath] = useState('')
  const [gitUrl, setGitUrl] = useState('')
  const [detectedRemote, setDetectedRemote] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [newPath, setNewPath] = useState('')
  const [newPathDirty, setNewPathDirty] = useState(false)
  const [suggestedPath, setSuggestedPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Load the user's saved default base directory once.
  useEffect(() => {
    window.api.invoke('settings:get', 'default_source_dir').then((val) => {
      if (val) setBaseDir(val)
    }).catch(() => {})
  }, [])

  // Helper to set the name only when the user hasn't typed their own.
  function autofillName(value: string): void {
    if (!nameDirty) setName(value)
  }

  // Clone mode: read-only preview of where the repo will land (folder name comes from the URL).
  useEffect(() => {
    if (sourceKind !== 'clone') {
      setSuggestedPath('')
      return
    }
    const folder = repoNameFromUrl(gitUrl.trim())
    if (!baseDir.trim() || !folder) {
      setSuggestedPath('')
      return
    }
    let cancelled = false
    window.api.invoke('locations:suggestPath', baseDir.trim(), folder)
      .then((p) => { if (!cancelled) setSuggestedPath(p) })
      .catch(() => { if (!cancelled) setSuggestedPath('') })
    return () => { cancelled = true }
  }, [sourceKind, baseDir, gitUrl])

  // New mode: default the (editable) directory path to "<baseDir>/<slugified-name>" until the user overrides it.
  useEffect(() => {
    if (sourceKind !== 'new' || newPathDirty) return
    const folder = slugify(name)
    if (!baseDir.trim() || !folder) {
      setNewPath('')
      return
    }
    let cancelled = false
    window.api.invoke('locations:suggestPath', baseDir.trim(), folder)
      .then((p) => { if (!cancelled) setNewPath(p) })
      .catch(() => { if (!cancelled) setNewPath('') })
    return () => { cancelled = true }
  }, [sourceKind, baseDir, name, newPathDirty])

  function handleSetDefaultBaseDir(): void {
    window.api.invoke('settings:set', 'default_source_dir', baseDir.trim()).catch(() => {})
  }

  async function handleBrowse(): Promise<void> {
    const dir = await window.api.invoke('dialog:open-directory')
    if (!dir) return
    setExistingPath(dir)
    const base = dir.split(/[/\\]/).filter(Boolean).pop() ?? ''
    if (base) autofillName(base)
    setDetectedRemote(null)
    try {
      const remote = await window.api.invoke('git:getRemoteUrl', dir)
      setDetectedRemote(remote)
    } catch {
      setDetectedRemote(null)
    }
  }

  function handleGitUrlChange(value: string): void {
    setGitUrl(value)
    const repo = repoNameFromUrl(value.trim())
    if (repo) autofillName(repo)
  }

  function buildSpec(): NewProjectSpec | string {
    const trimmedName = name.trim()
    if (!trimmedName) return 'Project name is required.'

    if (sourceKind === 'new') {
      if (!newPath.trim()) return 'Directory path is required.'
      return { name: trimmedName, allowMainBranchCommits, label: label.trim() || null, source: { kind: 'new', path: newPath.trim() } }
    }
    if (sourceKind === 'existing') {
      if (!existingPath.trim()) return 'Choose a directory to import.'
      return { name: trimmedName, allowMainBranchCommits, label: label.trim() || null, source: { kind: 'existing', path: existingPath.trim() } }
    }
    if (!gitUrl.trim()) return 'Git URL is required.'
    if (!baseDir.trim()) return 'Base directory is required.'
    return { name: trimmedName, allowMainBranchCommits, label: label.trim() || null, source: { kind: 'clone', gitUrl: gitUrl.trim(), parentDir: baseDir.trim() } }
  }

  async function handleCreate(): Promise<void> {
    const spec = buildSpec()
    if (typeof spec === 'string') { setError(spec); return }
    setBusy(true)
    setError('')
    try {
      const project = await createFull(spec)
      onCreated?.(project)
      onClose()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
      setBusy(false)
    }
  }

  const toggleStyle = (active: boolean) => ({
    background: active ? 'var(--color-claude)' : 'var(--color-surface)',
    color: active ? '#fff' : 'var(--color-text-muted)',
    border: `1px solid ${active ? 'var(--color-claude)' : 'var(--color-border)'}`,
  })

  const inputStyle = { background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }
  const createLabel = sourceKind === 'new' ? 'Create' : sourceKind === 'existing' ? 'Import' : 'Clone & Create'
  const busyLabel = sourceKind === 'clone' ? 'Cloning…' : 'Creating…'

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Source</label>
        <div className="flex gap-1">
          {([['new', 'New'], ['existing', 'Open Existing'], ['clone', 'Clone']] as [SourceKind, string][]).map(([kind, text]) => (
            <button
              key={kind}
              type="button"
              onClick={() => { setSourceKind(kind); setError('') }}
              className="flex-1 rounded px-2 py-1.5 text-xs font-medium transition-colors"
              style={toggleStyle(sourceKind === kind)}
            >
              {text}
            </button>
          ))}
        </div>
      </div>

      {sourceKind === 'clone' && (
        <div>
          <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Git URL</label>
          <input
            type="text"
            value={gitUrl}
            onChange={(e) => handleGitUrlChange(e.target.value)}
            className="w-full rounded px-3 py-2 text-sm outline-none font-mono"
            style={inputStyle}
            placeholder="https://github.com/org/repo.git"
            autoFocus
          />
        </div>
      )}

      {sourceKind === 'existing' && (
        <div>
          <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Directory</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={existingPath}
              onChange={(e) => setExistingPath(e.target.value)}
              className="flex-1 rounded px-3 py-2 text-sm outline-none font-mono"
              style={inputStyle}
              placeholder="/path/to/existing/repo"
            />
            <button type="button" onClick={handleBrowse} className="rounded px-3 py-2 text-xs whitespace-nowrap" style={inputStyle}>Browse</button>
          </div>
          {detectedRemote && (
            <p className="mt-1 text-xs truncate" style={{ color: 'var(--color-text-muted)' }} title={detectedRemote}>
              Remote: <span className="font-mono" style={{ color: 'var(--color-text)' }}>{detectedRemote}</span>
            </p>
          )}
        </div>
      )}

      <div>
        <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => { setName(e.target.value); setNameDirty(true) }}
          className="w-full rounded px-3 py-2 text-sm outline-none"
          style={inputStyle}
          placeholder="My Project"
          autoFocus={sourceKind === 'new'}
        />
      </div>

      {sourceKind !== 'existing' && (
        <div>
          <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Base directory</label>
          <div className="flex gap-2 items-center">
            <input
              type="text"
              value={baseDir}
              onChange={(e) => setBaseDir(e.target.value)}
              className="flex-1 rounded px-3 py-2 text-sm outline-none font-mono"
              style={inputStyle}
              placeholder="~/source"
            />
            <button type="button" onClick={handleSetDefaultBaseDir} className="rounded px-2.5 py-2 text-xs whitespace-nowrap" style={{ ...inputStyle, color: 'var(--color-text-muted)' }} title="Save as default base directory">
              Set default
            </button>
          </div>
          {sourceKind === 'clone' && suggestedPath && (
            <p className="mt-1 text-xs font-mono truncate" style={{ color: 'var(--color-text-muted)' }} title={suggestedPath}>
              → {suggestedPath}
            </p>
          )}
        </div>
      )}

      {sourceKind === 'new' && (
        <div>
          <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Directory path</label>
          <input
            type="text"
            value={newPath}
            onChange={(e) => { setNewPath(e.target.value); setNewPathDirty(true) }}
            className="w-full rounded px-3 py-2 text-sm outline-none font-mono"
            style={inputStyle}
            placeholder="~/source/my-project"
          />
        </div>
      )}

      <label className="flex items-start gap-2 rounded px-3 py-2 text-xs cursor-pointer" style={inputStyle}>
        <input
          type="checkbox"
          checked={allowMainBranchCommits}
          onChange={(e) => setAllowMainBranchCommits(e.target.checked)}
          style={{ accentColor: 'var(--color-claude)', marginTop: 2, flexShrink: 0 }}
        />
        <span>
          <span className="block">Allow commits on main/master</span>
          <span className="block mt-0.5" style={{ color: 'var(--color-text-muted)' }}>Turn off to prevent the Git panel from committing while the repo is on the default branch.</span>
        </span>
      </label>

      {error && <p className="text-xs" style={{ color: '#f87171' }}>{error}</p>}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={busy} className="rounded px-4 py-2 text-sm" style={inputStyle}>
          Cancel
        </button>
        <button type="button" onClick={handleCreate} disabled={busy} className="rounded px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50" style={{ background: 'var(--color-claude)', color: '#fff' }}>
          {busy ? <span className="flex items-center gap-1.5"><span className="streaming-dot" style={{ background: '#fff', width: 5, height: 5 }} />{busyLabel}</span> : createLabel}
        </button>
      </div>
    </div>
  )
}
