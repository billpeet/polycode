import { useState, useEffect } from 'react'
import { useLocationStore } from '../stores/locations'
import { RepoLocation, SshConfig, WslConfig, ConnectionType } from '../types/ipc'

interface Props {
  mode: 'create' | 'edit'
  projectId: string
  location?: RepoLocation
  onClose: () => void
}

export default function LocationDialog({ mode, projectId, location, onClose }: Props) {
  const [label, setLabel] = useState(location?.label ?? '')
  const [path, setPath] = useState(location?.path ?? '')
  const [error, setError] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<'success' | 'fail' | null>(null)
  const [connectionType, setConnectionType] = useState<ConnectionType>(
    location?.connection_type ?? 'local'
  )
  // SSH fields
  const [sshHost, setSshHost] = useState(location?.ssh?.host ?? '')
  const [sshUser, setSshUser] = useState(location?.ssh?.user ?? '')
  const [sshPort, setSshPort] = useState(location?.ssh?.port?.toString() ?? '')
  const [sshKeyPath, setSshKeyPath] = useState(location?.ssh?.keyPath ?? '')
  // WSL fields
  const [wslDistro, setWslDistro] = useState(location?.wsl?.distro ?? '')
  const [availableDistros, setAvailableDistros] = useState<string[]>([])

  const createLocation = useLocationStore((s) => s.create)
  const updateLocation = useLocationStore((s) => s.update)

  const isSSH = connectionType === 'ssh'
  const isWSL = connectionType === 'wsl'

  // Fetch available WSL distros when WSL mode is selected
  useEffect(() => {
    if (isWSL) {
      window.api.invoke('wsl:list-distros').then((distros) => {
        setAvailableDistros(distros)
        if (!wslDistro && distros.length > 0) {
          setWslDistro(distros[0])
        }
      }).catch(() => {
        setAvailableDistros([])
      })
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
        if (result.ok) {
          setTestResult('success')
        } else {
          setTestResult('fail')
          setError(`SSH connection failed: ${result.error}`)
        }
      } else if (isWSL) {
        const wsl = buildWslConfig()
        if (!wsl || !path.trim()) return
        const result = await window.api.invoke('wsl:test', wsl, path.trim())
        if (result.ok) {
          setTestResult('success')
        } else {
          setTestResult('fail')
          setError(`WSL test failed: ${result.error}`)
        }
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

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!label.trim()) { setError('Label is required'); return }
    if (!path.trim()) { setError('Path is required'); return }
    if (isSSH && !sshHost.trim()) { setError('SSH host is required'); return }
    if (isSSH && !sshUser.trim()) { setError('SSH user is required'); return }
    if (isWSL && !wslDistro.trim()) { setError('WSL distro is required'); return }

    const ssh = buildSshConfig()
    const wsl = buildWslConfig()

    // Validate connection before saving
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
      if (mode === 'edit' && location) {
        await updateLocation(location.id, projectId, label.trim(), connectionType, path.trim(), ssh, wsl)
      } else {
        await createLocation(projectId, label.trim(), connectionType, path.trim(), ssh, wsl)
      }
      onClose()
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
  const showBrowse = !isSSH && !isWSL

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
          {mode === 'edit' ? 'Edit Location' : 'Add Location'}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-3">
          {/* Connection mode toggle */}
          <div>
            <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Connection</label>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => { setConnectionType('local'); setTestResult(null); setError('') }}
                className="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors"
                style={toggleStyle(connectionType === 'local')}
              >
                Local
              </button>
              <button
                type="button"
                onClick={() => { setConnectionType('ssh'); setTestResult(null); setError('') }}
                className="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors"
                style={toggleStyle(connectionType === 'ssh')}
              >
                SSH Remote
              </button>
              <button
                type="button"
                onClick={() => { setConnectionType('wsl'); setTestResult(null); setError('') }}
                className="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors"
                style={toggleStyle(connectionType === 'wsl')}
              >
                WSL
              </button>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Label</label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full rounded px-3 py-2 text-sm outline-none"
              style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
              placeholder={isSSH ? 'SSH Prod' : isWSL ? 'WSL Ubuntu' : 'Local'}
              autoFocus
            />
          </div>

          {/* SSH config fields */}
          {isSSH && (
            <>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Host</label>
                  <input
                    type="text"
                    value={sshHost}
                    onChange={(e) => setSshHost(e.target.value)}
                    className="w-full rounded px-3 py-2 text-sm outline-none font-mono"
                    style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                    placeholder="example.com"
                  />
                </div>
                <div style={{ width: 80 }}>
                  <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Port</label>
                  <input
                    type="number"
                    value={sshPort}
                    onChange={(e) => setSshPort(e.target.value)}
                    className="w-full rounded px-3 py-2 text-sm outline-none font-mono"
                    style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
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
                  className="w-full rounded px-3 py-2 text-sm outline-none font-mono"
                  style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                  placeholder="ubuntu"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Key Path <span style={{ opacity: 0.5 }}>(optional)</span></label>
                <input
                  type="text"
                  value={sshKeyPath}
                  onChange={(e) => setSshKeyPath(e.target.value)}
                  className="w-full rounded px-3 py-2 text-sm outline-none font-mono"
                  style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                  placeholder="~/.ssh/id_rsa"
                />
              </div>
            </>
          )}

          {/* WSL config fields */}
          {isWSL && (
            <div>
              <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Distro</label>
              {availableDistros.length > 0 ? (
                <select
                  value={wslDistro}
                  onChange={(e) => setWslDistro(e.target.value)}
                  className="w-full rounded px-3 py-2 text-sm outline-none font-mono"
                  style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                >
                  {availableDistros.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={wslDistro}
                  onChange={(e) => setWslDistro(e.target.value)}
                  className="w-full rounded px-3 py-2 text-sm outline-none font-mono"
                  style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                  placeholder="Ubuntu"
                />
              )}
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {pathLabel}
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                className="flex-1 rounded px-3 py-2 text-sm outline-none font-mono"
                style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                placeholder={pathPlaceholder}
              />
              {showBrowse && (
                <button
                  type="button"
                  onClick={handleBrowse}
                  className="rounded px-3 py-2 text-xs"
                  style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                >
                  Browse
                </button>
              )}
            </div>
          </div>

          {/* Test connection button + result */}
          {(isSSH || isWSL) && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleTest}
                disabled={!canTest || testing}
                className="rounded px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40"
                style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
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

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={testing}
              className="rounded px-4 py-2 text-sm"
              style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={testing}
              className="rounded px-4 py-2 text-sm font-medium disabled:opacity-50"
              style={{ background: 'var(--color-claude)', color: '#fff' }}
            >
              {testing ? 'Testing...' : mode === 'edit' ? 'Save' : 'Add'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
