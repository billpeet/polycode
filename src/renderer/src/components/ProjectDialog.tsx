import { useState, useEffect } from 'react'
import { useProjectStore } from '../stores/projects'
import { useLocationStore } from '../stores/locations'
import { useCommandStore, EMPTY_COMMANDS } from '../stores/commands'
import { Project, RepoLocation, ConnectionType, SshConfig, WslConfig } from '../types/ipc'

const EMPTY: RepoLocation[] = []

type LocationFormState = { mode: 'none' } | { mode: 'create' } | { mode: 'edit'; location: RepoLocation }

interface Props {
  mode: 'create' | 'edit'
  project?: Project
  onClose: () => void
  onCreated?: (project: Project) => void
}

interface LocationFormSectionProps {
  projectId: string
  location?: RepoLocation
  onSaved: () => void
  onCancel: () => void
}

function LocationFormSection({ projectId, location, onSaved, onCancel }: LocationFormSectionProps) {
  const createLocation = useLocationStore((s) => s.create)
  const updateLocation = useLocationStore((s) => s.update)

  const [label, setLabel] = useState(location?.label ?? '')
  const [path, setPath] = useState(location?.path ?? '')
  const [connectionType, setConnectionType] = useState<ConnectionType>(location?.connection_type ?? 'local')
  const [sshHost, setSshHost] = useState(location?.ssh?.host ?? '')
  const [sshUser, setSshUser] = useState(location?.ssh?.user ?? '')
  const [sshPort, setSshPort] = useState(location?.ssh?.port?.toString() ?? '')
  const [sshKeyPath, setSshKeyPath] = useState(location?.ssh?.keyPath ?? '')
  const [wslDistro, setWslDistro] = useState(location?.wsl?.distro ?? '')
  const [availableDistros, setAvailableDistros] = useState<string[]>([])
  const [error, setError] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<'success' | 'fail' | null>(null)

  const isSSH = connectionType === 'ssh'
  const isWSL = connectionType === 'wsl'

  useEffect(() => {
    if (isWSL) {
      window.api.invoke('wsl:list-distros').then((distros) => {
        setAvailableDistros(distros)
        if (!wslDistro && distros.length > 0) setWslDistro(distros[0])
      }).catch(() => setAvailableDistros([]))
    }
  }, [isWSL])

  function buildSshConfig(): SshConfig | null {
    if (!isSSH) return null
    return {
      host: sshHost.trim(),
      user: sshUser.trim(),
      port: sshPort ? parseInt(sshPort, 10) : undefined,
      keyPath: sshKeyPath.trim() || undefined,
    }
  }

  function buildWslConfig(): WslConfig | null {
    if (!isWSL) return null
    return { distro: wslDistro.trim() }
  }

  const canTest = (isSSH && sshHost.trim() && sshUser.trim() && path.trim()) ||
    (isWSL && wslDistro.trim() && path.trim())

  async function handleTest(): Promise<void> {
    setError('')
    setTesting(true)
    setTestResult(null)
    try {
      if (isSSH) {
        const ssh = buildSshConfig()
        if (!ssh || !path.trim()) return
        const result = await window.api.invoke('ssh:test', ssh, path.trim())
        setTestResult(result.ok ? 'success' : 'fail')
        if (!result.ok) setError(`SSH connection failed: ${result.error}`)
      } else if (isWSL) {
        const wsl = buildWslConfig()
        if (!wsl || !path.trim()) return
        const result = await window.api.invoke('wsl:test', wsl, path.trim())
        setTestResult(result.ok ? 'success' : 'fail')
        if (!result.ok) setError(`WSL test failed: ${result.error}`)
      }
    } catch (err) {
      setTestResult('fail')
      setError(`Test error: ${String(err)}`)
    }
    setTesting(false)
  }

  async function handleBrowse(): Promise<void> {
    const dir = await window.api.invoke('dialog:open-directory')
    if (dir) {
      setPath(dir)
      if (!label) {
        const parts = dir.split(/[/\\]/)
        setLabel(parts[parts.length - 1] || 'Local')
      }
    }
  }

  async function handleSave(): Promise<void> {
    if (!label.trim()) { setError('Label is required'); return }
    if (!path.trim()) { setError('Path is required'); return }
    if (isSSH && !sshHost.trim()) { setError('SSH host is required'); return }
    if (isSSH && !sshUser.trim()) { setError('SSH user is required'); return }
    if (isWSL && !wslDistro.trim()) { setError('WSL distro is required'); return }

    const ssh = buildSshConfig()
    const wsl = buildWslConfig()

    if (ssh) {
      setError('')
      setTesting(true)
      setTestResult(null)
      try {
        const result = await window.api.invoke('ssh:test', ssh, path.trim())
        if (!result.ok) {
          setTestResult('fail')
          setError(`SSH connection failed: ${result.error}`)
          setTesting(false)
          return
        }
        setTestResult('success')
      } catch (err) {
        setTestResult('fail')
        setError(`SSH test error: ${String(err)}`)
        setTesting(false)
        return
      }
      setTesting(false)
    } else if (wsl) {
      setError('')
      setTesting(true)
      setTestResult(null)
      try {
        const result = await window.api.invoke('wsl:test', wsl, path.trim())
        if (!result.ok) {
          setTestResult('fail')
          setError(`WSL test failed: ${result.error}`)
          setTesting(false)
          return
        }
        setTestResult('success')
      } catch (err) {
        setTestResult('fail')
        setError(`WSL test error: ${String(err)}`)
        setTesting(false)
        return
      }
      setTesting(false)
    }

    try {
      if (location) {
        await updateLocation(location.id, projectId, label.trim(), connectionType, path.trim(), ssh, wsl)
      } else {
        await createLocation(projectId, label.trim(), connectionType, path.trim(), ssh, wsl)
      }
      onSaved()
    } catch (err) {
      setError(String(err))
    }
  }

  const toggleStyle = (active: boolean) => ({
    background: active ? 'var(--color-claude)' : 'var(--color-surface)',
    color: active ? '#fff' : 'var(--color-text-muted)',
    border: `1px solid ${active ? 'var(--color-claude)' : 'var(--color-border)'}`,
  })

  const pathLabel = isSSH ? 'Remote Path' : isWSL ? 'WSL Path' : 'Directory'
  const pathPlaceholder = isSSH ? '/home/user/project' : isWSL ? '~/projects/myapp' : '/path/to/project'

  return (
    <div
      className="mt-1.5 rounded-md p-3 space-y-2.5"
      style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
    >
      {/* Connection type toggle */}
      <div>
        <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Connection</label>
        <div className="flex gap-1">
          {(['local', 'ssh', 'wsl'] as ConnectionType[]).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => { setConnectionType(type); setTestResult(null); setError('') }}
              className="flex-1 rounded px-2 py-1.5 text-xs font-medium transition-colors"
              style={toggleStyle(connectionType === type)}
            >
              {type === 'local' ? 'Local' : type === 'ssh' ? 'SSH Remote' : 'WSL'}
            </button>
          ))}
        </div>
      </div>

      {/* Label */}
      <div>
        <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Label</label>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="w-full rounded px-3 py-1.5 text-sm outline-none"
          style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
          placeholder={isSSH ? 'SSH Prod' : isWSL ? 'WSL Ubuntu' : 'Local'}
          autoFocus
        />
      </div>

      {/* SSH fields */}
      {isSSH && (
        <>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Host</label>
              <input
                type="text"
                value={sshHost}
                onChange={(e) => setSshHost(e.target.value)}
                className="w-full rounded px-3 py-1.5 text-sm outline-none font-mono"
                style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                placeholder="example.com"
              />
            </div>
            <div style={{ width: 72 }}>
              <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Port</label>
              <input
                type="number"
                value={sshPort}
                onChange={(e) => setSshPort(e.target.value)}
                className="w-full rounded px-3 py-1.5 text-sm outline-none font-mono"
                style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                placeholder="22"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>User</label>
            <input
              type="text"
              value={sshUser}
              onChange={(e) => setSshUser(e.target.value)}
              className="w-full rounded px-3 py-1.5 text-sm outline-none font-mono"
              style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
              placeholder="ubuntu"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>
              Key Path <span style={{ opacity: 0.5 }}>(optional)</span>
            </label>
            <input
              type="text"
              value={sshKeyPath}
              onChange={(e) => setSshKeyPath(e.target.value)}
              className="w-full rounded px-3 py-1.5 text-sm outline-none font-mono"
              style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
              placeholder="~/.ssh/id_rsa"
            />
          </div>
        </>
      )}

      {/* WSL fields */}
      {isWSL && (
        <div>
          <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Distro</label>
          {availableDistros.length > 0 ? (
            <select
              value={wslDistro}
              onChange={(e) => setWslDistro(e.target.value)}
              className="w-full rounded px-3 py-1.5 text-sm outline-none font-mono"
              style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
            >
              {availableDistros.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          ) : (
            <input
              type="text"
              value={wslDistro}
              onChange={(e) => setWslDistro(e.target.value)}
              className="w-full rounded px-3 py-1.5 text-sm outline-none font-mono"
              style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
              placeholder="Ubuntu"
            />
          )}
        </div>
      )}

      {/* Path */}
      <div>
        <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>{pathLabel}</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            className="flex-1 rounded px-3 py-1.5 text-sm outline-none font-mono"
            style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
            placeholder={pathPlaceholder}
          />
          {!isSSH && !isWSL && (
            <button
              type="button"
              onClick={handleBrowse}
              className="rounded px-3 py-1.5 text-xs"
              style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
            >
              Browse
            </button>
          )}
        </div>
      </div>

      {/* Test connection */}
      {(isSSH || isWSL) && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleTest}
            disabled={!canTest || testing}
            className="rounded px-3 py-1 text-xs font-medium transition-colors disabled:opacity-40"
            style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
          >
            {testing ? 'Testing...' : 'Test Connection'}
          </button>
          {testing && (
            <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--color-text-muted)' }}>
              <span className="streaming-dot" style={{ background: 'var(--color-claude)', width: 6, height: 6 }} />
              {isWSL ? 'Testing WSL...' : 'Connecting...'}
            </span>
          )}
          {!testing && testResult === 'success' && (
            <span className="text-xs font-medium" style={{ color: '#4ade80' }}>
              {isWSL ? 'Path valid' : 'Connected'}
            </span>
          )}
          {!testing && testResult === 'fail' && (
            <span className="text-xs font-medium" style={{ color: '#f87171' }}>Failed</span>
          )}
        </div>
      )}

      {error && <p className="text-xs" style={{ color: '#f87171' }}>{error}</p>}

      <div className="flex justify-end gap-2 pt-0.5">
        <button
          type="button"
          onClick={onCancel}
          disabled={testing}
          className="rounded px-3 py-1.5 text-xs"
          style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={testing}
          className="rounded px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          style={{ background: 'var(--color-claude)', color: '#fff' }}
        >
          {testing ? 'Testing...' : location ? 'Save' : 'Add'}
        </button>
      </div>
    </div>
  )
}

export default function ProjectDialog({ mode, project, onClose, onCreated }: Props) {
  const [name, setName] = useState(project?.name ?? '')
  const [gitUrl, setGitUrl] = useState(project?.git_url ?? '')
  const [error, setError] = useState('')
  const [projectSaved, setProjectSaved] = useState(false)

  const createProject = useProjectStore((s) => s.create)
  const updateProject = useProjectStore((s) => s.update)

  const locations = useLocationStore((s) => project ? (s.byProject[project.id] ?? EMPTY) : EMPTY)
  const fetchLocations = useLocationStore((s) => s.fetch)
  const removeLocation = useLocationStore((s) => s.remove)

  const [locationForm, setLocationForm] = useState<LocationFormState>({ mode: 'none' })
  const [deleteConfirm, setDeleteConfirm] = useState<RepoLocation | null>(null)

  // Commands
  const commands = useCommandStore((s) => project ? (s.byProject[project.id] ?? EMPTY_COMMANDS) : EMPTY_COMMANDS)
  const fetchCommands = useCommandStore((s) => s.fetch)
  const createCommand = useCommandStore((s) => s.create)
  const updateCommand = useCommandStore((s) => s.update)
  const removeCommand = useCommandStore((s) => s.remove)
  const [newCmdName, setNewCmdName] = useState('')
  const [newCmdCommand, setNewCmdCommand] = useState('')
  const [newCmdCwd, setNewCmdCwd] = useState('')
  const [cmdError, setCmdError] = useState('')
  const [editingCmdId, setEditingCmdId] = useState<string | null>(null)
  const [editCmdName, setEditCmdName] = useState('')
  const [editCmdCommand, setEditCmdCommand] = useState('')
  const [editCmdCwd, setEditCmdCwd] = useState('')
  const [editCmdError, setEditCmdError] = useState('')

  const isEdit = mode === 'edit'

  useEffect(() => {
    if (isEdit && project) {
      fetchLocations(project.id)
      fetchCommands(project.id)
    }
  }, [isEdit, project?.id])

  async function handleProjectSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!name.trim()) { setError('Name is required'); return }
    try {
      if (isEdit && project) {
        await updateProject(project.id, name.trim(), gitUrl.trim() || null)
        setProjectSaved(true)
        setTimeout(() => setProjectSaved(false), 2000)
      } else {
        const created = await createProject(name.trim(), gitUrl.trim() || null)
        onClose()
        onCreated?.(created)
      }
    } catch (err) {
      setError(String(err))
    }
  }

  async function handleDeleteLocation(loc: RepoLocation): Promise<void> {
    if (!project) return
    await removeLocation(loc.id, project.id)
    setDeleteConfirm(null)
  }

  function connectionBadge(connType: string) {
    if (connType === 'local') return null
    const isSSH = connType === 'ssh'
    return (
      <span
        className="ml-1.5 flex-shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase"
        style={{
          background: isSSH ? 'rgba(99, 179, 237, 0.15)' : 'rgba(251, 191, 36, 0.15)',
          color: isSSH ? '#63b3ed' : '#fbbf24',
        }}
      >
        {connType}
      </span>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onClick={onClose}
    >
      <div
        className={`${isEdit ? 'w-[520px]' : 'w-96'} max-h-[85vh] overflow-y-auto rounded-lg p-6 shadow-2xl`}
        style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-base font-semibold" style={{ color: 'var(--color-text)' }}>
          {isEdit ? 'Edit Project' : 'New Project'}
        </h2>

        {/* Project settings */}
        <form onSubmit={handleProjectSubmit} className="space-y-3">
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

          <div className="flex justify-end gap-2">
            {!isEdit && (
              <button
                type="button"
                onClick={onClose}
                className="rounded px-4 py-2 text-sm"
                style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
              >
                Cancel
              </button>
            )}
            <button
              type="submit"
              className="rounded px-4 py-2 text-sm font-medium transition-colors"
              style={{ background: projectSaved ? '#16a34a' : 'var(--color-claude)', color: '#fff' }}
            >
              {isEdit ? (projectSaved ? 'Saved!' : 'Save Changes') : 'Create'}
            </button>
          </div>
        </form>

        {/* Locations section — edit mode only */}
        {isEdit && project && (
          <>
            <div className="my-5 border-t" style={{ borderColor: 'var(--color-border)' }} />

            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>Locations</span>
              {locationForm.mode === 'none' && (
                <button
                  type="button"
                  onClick={() => setLocationForm({ mode: 'create' })}
                  className="rounded px-2.5 py-1 text-xs"
                  style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                >
                  + Add Location
                </button>
              )}
            </div>

            {locations.length === 0 && locationForm.mode === 'none' && (
              <p className="text-xs py-1" style={{ color: 'var(--color-text-muted)' }}>
                No locations yet. Add a location to start working.
              </p>
            )}

            <div className="space-y-1">
              {locations.map((loc) => {
                const isEditingThis = locationForm.mode === 'edit' && locationForm.location.id === loc.id
                return (
                  <div key={loc.id}>
                    <div
                      className="flex items-center gap-2 rounded px-3 py-2"
                      style={{ background: 'var(--color-surface)', border: `1px solid ${isEditingThis ? 'var(--color-claude)' : 'var(--color-border)'}` }}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center min-w-0">
                          <span className="text-xs font-medium truncate" style={{ color: 'var(--color-text)' }}>
                            {loc.label}
                          </span>
                          {connectionBadge(loc.connection_type)}
                        </div>
                        <span className="text-[10px] font-mono truncate block" style={{ color: 'var(--color-text-muted)' }}>
                          {loc.connection_type === 'ssh' ? `${loc.ssh?.user}@${loc.ssh?.host}:${loc.path}` : loc.path}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          if (isEditingThis) {
                            setLocationForm({ mode: 'none' })
                          } else {
                            setLocationForm({ mode: 'edit', location: loc })
                          }
                        }}
                        className="rounded p-1 text-xs hover:bg-white/10 transition-colors flex-shrink-0"
                        style={{ color: isEditingThis ? 'var(--color-claude)' : 'var(--color-text-muted)' }}
                        title="Edit location"
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteConfirm(loc)}
                        className="rounded p-1 text-xs hover:bg-white/10 transition-colors flex-shrink-0"
                        style={{ color: 'var(--color-text-muted)' }}
                        title="Delete location"
                      >
                        ✕
                      </button>
                    </div>

                    {isEditingThis && (
                      <LocationFormSection
                        projectId={project.id}
                        location={loc}
                        onSaved={() => setLocationForm({ mode: 'none' })}
                        onCancel={() => setLocationForm({ mode: 'none' })}
                      />
                    )}
                  </div>
                )
              })}
            </div>

            {locationForm.mode === 'create' && (
              <div className={locations.length > 0 ? 'mt-1' : ''}>
                <LocationFormSection
                  projectId={project.id}
                  onSaved={() => setLocationForm({ mode: 'none' })}
                  onCancel={() => setLocationForm({ mode: 'none' })}
                />
              </div>
            )}

            {deleteConfirm && (
              <div
                className="mt-3 rounded-md p-3"
                style={{ background: 'rgba(220, 38, 38, 0.1)', border: '1px solid rgba(220, 38, 38, 0.3)' }}
              >
                <p className="text-xs mb-2" style={{ color: 'var(--color-text)' }}>
                  Delete location <strong>{deleteConfirm.label}</strong>?
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setDeleteConfirm(null)}
                    className="rounded px-3 py-1 text-xs"
                    style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteLocation(deleteConfirm)}
                    className="rounded px-3 py-1 text-xs font-medium"
                    style={{ background: '#dc2626', color: '#fff' }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            )}

            {/* Commands section */}
            <div className="my-5 border-t" style={{ borderColor: 'var(--color-border)' }} />

            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>Commands</span>
            </div>

            {commands.length === 0 && (
              <p className="text-xs py-1 mb-2" style={{ color: 'var(--color-text-muted)' }}>
                No commands yet.
              </p>
            )}

            <div className="space-y-1 mb-3">
              {commands.map((cmd) => {
                const isEditingThis = editingCmdId === cmd.id
                return (
                  <div key={cmd.id}>
                    <div
                      className="flex items-center gap-2 rounded px-3 py-2"
                      style={{ background: 'var(--color-surface)', border: `1px solid ${isEditingThis ? 'var(--color-claude)' : 'var(--color-border)'}` }}
                    >
                      <div className="flex-1 min-w-0">
                        <span className="text-xs font-medium truncate block" style={{ color: 'var(--color-text)' }}>
                          {cmd.name}
                        </span>
                        <span className="text-[10px] font-mono truncate block" style={{ color: 'var(--color-text-muted)' }}>
                          {cmd.command}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          if (isEditingThis) {
                            setEditingCmdId(null)
                          } else {
                            setEditingCmdId(cmd.id)
                            setEditCmdName(cmd.name)
                            setEditCmdCommand(cmd.command)
                            setEditCmdCwd(cmd.cwd ?? '')
                            setEditCmdError('')
                          }
                        }}
                        className="rounded p-1 text-xs hover:bg-white/10 transition-colors flex-shrink-0"
                        style={{ color: isEditingThis ? 'var(--color-claude)' : 'var(--color-text-muted)' }}
                        title="Edit command"
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        onClick={() => project && removeCommand(cmd.id, project.id)}
                        className="rounded p-1 text-xs hover:bg-white/10 transition-colors flex-shrink-0"
                        style={{ color: 'var(--color-text-muted)' }}
                        title="Remove command"
                      >
                        ✕
                      </button>
                    </div>

                    {isEditingThis && (
                      <div
                        className="mt-1 rounded-md p-3 space-y-2"
                        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-claude)' }}
                      >
                        <div>
                          <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Name</label>
                          <input
                            type="text"
                            value={editCmdName}
                            onChange={(e) => setEditCmdName(e.target.value)}
                            className="w-full rounded px-3 py-1.5 text-sm outline-none"
                            style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                            autoFocus
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Command</label>
                          <input
                            type="text"
                            value={editCmdCommand}
                            onChange={(e) => setEditCmdCommand(e.target.value)}
                            className="w-full rounded px-3 py-1.5 text-sm outline-none font-mono"
                            style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>
                            Working dir <span style={{ opacity: 0.5 }}>(optional)</span>
                          </label>
                          <input
                            type="text"
                            value={editCmdCwd}
                            onChange={(e) => setEditCmdCwd(e.target.value)}
                            className="w-full rounded px-3 py-1.5 text-sm outline-none font-mono"
                            style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                            placeholder="/path/to/subdir"
                          />
                        </div>
                        {editCmdError && <p className="text-xs" style={{ color: '#f87171' }}>{editCmdError}</p>}
                        <div className="flex justify-end gap-2 pt-0.5">
                          <button
                            type="button"
                            onClick={() => setEditingCmdId(null)}
                            className="rounded px-3 py-1.5 text-xs"
                            style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            disabled={!editCmdName.trim() || !editCmdCommand.trim()}
                            onClick={async () => {
                              if (!project || !editCmdName.trim() || !editCmdCommand.trim()) return
                              setEditCmdError('')
                              try {
                                await updateCommand(cmd.id, project.id, editCmdName.trim(), editCmdCommand.trim(), editCmdCwd.trim() || null)
                                setEditingCmdId(null)
                              } catch (err) {
                                setEditCmdError(String(err))
                              }
                            }}
                            className="rounded px-3 py-1.5 text-xs font-medium disabled:opacity-40"
                            style={{ background: 'var(--color-claude)', color: '#fff' }}
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Add command form */}
            <div
              className="rounded-md p-3 space-y-2"
              style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
            >
              <p className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>Add Command</p>
              <div>
                <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Name</label>
                <input
                  type="text"
                  value={newCmdName}
                  onChange={(e) => setNewCmdName(e.target.value)}
                  className="w-full rounded px-3 py-1.5 text-sm outline-none"
                  style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                  placeholder="Dev server"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Command</label>
                <input
                  type="text"
                  value={newCmdCommand}
                  onChange={(e) => setNewCmdCommand(e.target.value)}
                  className="w-full rounded px-3 py-1.5 text-sm outline-none font-mono"
                  style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                  placeholder="npm run dev"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  Working dir <span style={{ opacity: 0.5 }}>(optional — defaults to location path)</span>
                </label>
                <input
                  type="text"
                  value={newCmdCwd}
                  onChange={(e) => setNewCmdCwd(e.target.value)}
                  className="w-full rounded px-3 py-1.5 text-sm outline-none font-mono"
                  style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                  placeholder="/path/to/subdir"
                />
              </div>
              {cmdError && <p className="text-xs" style={{ color: '#f87171' }}>{cmdError}</p>}
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={!newCmdName.trim() || !newCmdCommand.trim()}
                  onClick={async () => {
                    if (!project || !newCmdName.trim() || !newCmdCommand.trim()) return
                    setCmdError('')
                    try {
                      await createCommand(project.id, newCmdName.trim(), newCmdCommand.trim(), newCmdCwd.trim() || null)
                      setNewCmdName('')
                      setNewCmdCommand('')
                      setNewCmdCwd('')
                    } catch (err) {
                      setCmdError(String(err))
                    }
                  }}
                  className="rounded px-3 py-1.5 text-xs font-medium disabled:opacity-40"
                  style={{ background: 'var(--color-claude)', color: '#fff' }}
                >
                  Add Command
                </button>
              </div>
            </div>

            <div className="mt-5 pt-4 flex justify-end border-t" style={{ borderColor: 'var(--color-border)' }}>
              <button
                type="button"
                onClick={onClose}
                className="rounded px-4 py-2 text-sm"
                style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
              >
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
